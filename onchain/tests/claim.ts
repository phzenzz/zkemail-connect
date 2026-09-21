import * as anchor from "@coral-xyz/anchor";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey } from "@solana/web3.js";
import { assert, expect } from "chai";
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import fs from "fs";
import {
  program,
  provider,
  escrowPda,
  registryPda,
  configPda,
  ata,
  fundSender,
  fieldToBE,
  relayerEntryPda,
  protocolConfigPda,
  nullifierPda,
} from "./helpers";

const CLAIM_EML = "../circuits/testdata/emails/claim.eml";
const FIXTURE_PATH = "../circuits/build/onchain-proof.json";
const AMOUNT = 123_456;

describe("claim", () => {
  const sender = Keypair.generate();
  const payer = Keypair.generate(); // acts as relayer (proof binds this key)
  const treasury = Keypair.generate();
  const relayerHash = randomBytes(32);
  let mint: PublicKey;
  let senderAta: PublicKey;
  let fixture: any;
  const commitment = () => fieldToBE(fixture.meta.commitment);
  const selector = () => fixture.meta.selector as string; // 真实 DKIM selector
  const destOwner = () => new PublicKey(fixture.meta.destBase58 as string);
  const registry = () =>
    registryPda(fieldToBE(fixture.meta.domainCommitment), selector());

  before(async function () {
    this.timeout(900_000);
    await fundSender(sender);
    await fundSender(payer);
    mint = await createMint(
      provider.connection,
      sender,
      sender.publicKey,
      null,
      6
    );
    senderAta = await createAccount(
      provider.connection,
      sender,
      mint,
      sender.publicKey
    );
    await mintTo(
      provider.connection,
      sender,
      mint,
      senderAta,
      sender,
      1_000_000
    );

    // 用真实邮件出证明，relayer 绑定 payer 公钥。
    // PROVER_URL 设置时走 prover 容器（~7s），否则本地 snarkjs（~90s+）。
    execFileSync(
      "npx",
      ["tsx", "../circuits/scripts/prove-for.ts", CLAIM_EML, payer.publicKey.toBase58(), "build/onchain-proof.json"],
      {
        cwd: "../circuits",
        stdio: "inherit",
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=16384" },
      }
    );
    fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

    // registry: authority = provider 默认钱包（与其他套件共享；已初始化则跳过）
    const authority = provider.wallet.publicKey;
    try {
      await program.methods
        .initializeRegistry(authority)
        .accounts({ config: configPda(), payer: authority })
        .rpc();
    } catch {
      /* already initialized by another suite */
    }
    const expires = Math.floor(Date.now() / 1000) + 3600;
    await program.methods
      .registryUpsert(
        Array.from(fieldToBE(fixture.meta.domainCommitment)),
        selector(),
        Array.from(fieldToBE(fixture.meta.pubkeyHash)),
        new anchor.BN(expires)
      )
      .accounts({ config: configPda(), registry: registry(), authority })
      .rpc();

    // create the escrow the proof claims（v2: 加密邮箱 + relayer 标识 + 协议手续费）
    // protocol config 先到先得；其他套件已初始化时以 authority 重置为本套件的 treasury/fee
    try {
      await program.methods
        .initializeProtocol(treasury.publicKey, new anchor.BN(10_000_000), new anchor.BN(2_592_000))
        .accounts({ config: protocolConfigPda(), payer: authority })
        .rpc();
    } catch {
      await program.methods
        .updateProtocol(treasury.publicKey, new anchor.BN(10_000_000), new anchor.BN(2_592_000))
        .accounts({ config: protocolConfigPda(), authority })
        .rpc();
    }
    // 注册本套件使用的 relayer（active 为默认）
    await program.methods
      .registerRelayer(
        "claim-relay@zkemail.io",
        Array.from(relayerHash),
        Array.from(randomBytes(32)),
        sender.publicKey,
        new anchor.BN(0)
      )
      .accounts({
        relayerEntry: relayerEntryPda(relayerHash),
        claimAuthority: sender.publicKey,
      })
      .signers([sender])
      .rpc();
    await program.methods
      .createEscrow(
        Array.from(commitment()),
        new anchor.BN(AMOUNT),
        randomBytes(60),
        Array.from(relayerHash)
      )
      .accounts({
        escrow: escrowPda(commitment(), sender.publicKey),
        mint,
        vault: ata(mint, escrowPda(commitment(), sender.publicKey)),
        senderAta,
        sender: sender.publicKey,
        config: protocolConfigPda(),
        treasury: treasury.publicKey,
        relayerEntry: relayerEntryPda(relayerHash),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sender])
      .rpc();
  });

  const claimTx = () =>
    program.methods
      .claim({
        proofA: fixture.proofA,
        proofB: fixture.proofB,
        proofC: fixture.proofC,
        publicInputs: fixture.publicInputs,
        selector: selector(),
      } as any)
      .accounts({
        escrow: escrowPda(commitment(), sender.publicKey),
        sender: sender.publicKey,
        vault: ata(mint, escrowPda(commitment(), sender.publicKey)),
        mint,
        registry: registry(),
        destOwner: destOwner(),
        destAta: ata(mint, destOwner()),
        payer: payer.publicKey,
        nullifier: nullifierPda(fieldToBE(fixture.meta.emailNullifier)),
        protocolConfig: protocolConfigPda(),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([payer]);

  it("claim transfers funds to proof-bound dest and closes escrow", async () => {
    const sig = await claimTx()
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ])
      .rpc();

    const destAta = await getAccount(provider.connection, ata(mint, destOwner()));
    assert.equal(destAta.amount.toString(), AMOUNT.toString());
    const escrow = escrowPda(commitment(), sender.publicKey);
    assert.equal(await provider.connection.getAccountInfo(escrow), null);
    assert.equal(await provider.connection.getAccountInfo(ata(mint, escrow)), null);

    // 记录链上日志/CU 供报告使用
    const tx = await provider.connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const cu = tx?.meta?.computeUnitsConsumed;
    console.log(`claim tx ${sig} consumed ${cu} CU`);
  });

  it("second claim of the same escrow fails (account closed)", async () => {
    await expect(
      claimTx()
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ])
        .rpc()
    ).to.be.rejected;
  });
});
