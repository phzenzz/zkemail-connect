import * as anchor from "@coral-xyz/anchor";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, AddressLookupTableAccount } from "@solana/web3.js";
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
  createAltAccount,
  sendV0Tx,
} from "./helpers";

const CLAIM_EML = "../circuits/testdata/emails/claim.eml";
const FIXTURE_PATH = "../circuits/build/onchain-proof.json";
const AMOUNT = 123_456;

describe("claim", () => {
  const sender = Keypair.generate();
  const payer = Keypair.generate(); // acts as relayer (proof binds this key)
  const treasury = Keypair.generate();
  // v1.7: relayer 标识 = eml 的 To 地址（proof 绑 relayerEmailHash），出证后才能确定
  let relayerHash: Buffer;
  let relayerEmail: string;
  let mint: PublicKey;
  let senderAta: PublicKey;
  let fixture: any;
  let altAccount: AddressLookupTableAccount; // claim 交易经 v0 + ALT 发送（legacy 1232B 放不下 Groth16 证明）
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
    relayerHash = fieldToBE(fixture.meta.relayerEmailHash);
    relayerEmail = fixture.meta.toEmail;

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
    // 注册本套件使用的 relayer（active 为默认）；邮箱必须等于 eml 的 To（proof 绑定其哈希）
    await program.methods
      .registerRelayer(
        relayerEmail,
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

    // v0 地址查找表：静态账户列表压缩后 claim 交易才进得了 1232B 上限
    const escrowPk = escrowPda(commitment(), sender.publicKey);
    altAccount = await createAltAccount([
      program.programId,
      SystemProgram.programId,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      mint,
      escrowPk,
      ata(mint, escrowPk),
      sender.publicKey,
      registry(),
      destOwner(),
      ata(mint, destOwner()),
      nullifierPda(fieldToBE(fixture.meta.emailNullifier)),
      protocolConfigPda(),
    ]);
  });

  // 返回 claim 指令集（含 CU limit preInstruction），由调用方经 sendV0Tx + ALT 发送
  const claimIxs = async (
    escrowPk: PublicKey = escrowPda(commitment(), sender.publicKey),
    senderPk: PublicKey = sender.publicKey
  ) => {
    const tx = await program.methods
      .claim({
        proofA: fixture.proofA,
        proofB: fixture.proofB,
        proofC: fixture.proofC,
        publicInputs: fixture.publicInputs,
        selector: selector(),
      } as any)
      .accounts({
        escrow: escrowPk,
        sender: senderPk,
        vault: ata(mint, escrowPk),
        mint,
        registry: registry(),
        destOwner: destOwner(),
        destAta: ata(mint, destOwner()),
        payer: payer.publicKey,
        nullifier: nullifierPda(fieldToBE(fixture.meta.emailNullifier)),
        protocolConfig: protocolConfigPda(),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ])
      .transaction();
    return tx.instructions;
  };

  const claimV0 = async (escrowPk?: PublicKey, senderPk?: PublicKey) =>
    sendV0Tx(
      await claimIxs(escrowPk, senderPk),
      [payer],
      [altAccount],
      payer.publicKey
    );

  it("rejects claim when escrow relayer email hash mismatches proof", async () => {
    // 另一个 relayer entry（不同邮箱哈希）建的 escrow，commitment 相同；
    // proof 的 relayerEmailHash 绑的是 eml 的 To → 必须 revert RelayerEmailHashMismatch。
    // 注意：本用例必须排在成功 claim 之前——nullifier 一旦被花掉，
    // 失败会发生在 init 阶段（system 0x0）而非 handler 的 RelayerEmailHashMismatch。
    // tx 原子回滚：失败不花 nullifier，后续成功 claim 不受影响。
    const sender2 = Keypair.generate();
    const otherHash = randomBytes(32);
    await fundSender(sender2);
    const sender2Ata = await createAccount(provider.connection, sender2, mint, sender2.publicKey);
    await mintTo(provider.connection, sender, mint, sender2Ata, sender, AMOUNT);
    await program.methods
      .registerRelayer(
        "other-relay@zkemail.io",
        Array.from(otherHash),
        Array.from(randomBytes(32)),
        sender2.publicKey,
        new anchor.BN(0)
      )
      .accounts({
        relayerEntry: relayerEntryPda(otherHash),
        claimAuthority: sender2.publicKey,
      })
      .signers([sender2])
      .rpc();
    const escrow2 = escrowPda(commitment(), sender2.publicKey);
    await program.methods
      .createEscrow(
        Array.from(commitment()),
        new anchor.BN(AMOUNT),
        randomBytes(60),
        Array.from(otherHash)
      )
      .accounts({
        escrow: escrow2,
        mint,
        vault: ata(mint, escrow2),
        senderAta: sender2Ata,
        sender: sender2.publicKey,
        config: protocolConfigPda(),
        treasury: treasury.publicKey,
        relayerEntry: relayerEntryPda(otherHash),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sender2])
      .rpc();

    // 不断言 custom program error 兜底：那会吞掉 nullifier init 的 system 0x0 假阳性。
    // 命中 handler 时为程序 600X 段错误（6018 RelayerEmailHashMismatch，见 claim.rs require!）。
    await expect(claimV0(escrow2, sender2.publicKey)).to.be.rejectedWith(
      /RelayerEmailHashMismatch|relayer email hash/i
    );
  });

  it("claim transfers funds to proof-bound dest and closes escrow", async () => {
    const sig = await claimV0();

    const destAta = await getAccount(provider.connection, ata(mint, destOwner()));
    assert.equal(destAta.amount.toString(), AMOUNT.toString());
    const escrow = escrowPda(commitment(), sender.publicKey);
    assert.equal(await provider.connection.getAccountInfo(escrow), null);
    assert.equal(await provider.connection.getAccountInfo(ata(mint, escrow)), null);
    // nullifier 已落链（exactly-once 标记）
    assert.notEqual(
      await provider.connection.getAccountInfo(
        nullifierPda(fieldToBE(fixture.meta.emailNullifier))
      ),
      null
    );

    // 记录链上日志/CU 供报告使用
    const tx = await provider.connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const cu = tx?.meta?.computeUnitsConsumed;
    console.log(`claim tx ${sig} consumed ${cu} CU`);
  });

  it("second claim of the same escrow fails (account closed)", async () => {
    await expect(claimV0()).to.be.rejected;
  });

  it("rejects replaying the same email (nullifier spent)", async () => {
    // escrow 已关闭可重新 create（同一 commitment+sender），但 nullifier 账户已存在：
    // 同一封邮件的第二次 claim 必须被 init 拒绝，资金留在 vault。
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

    await expect(claimV0()).to.be.rejectedWith(
      /already in use|NullifierAlreadyUsed|custom program error: 0x0/i
    );

    // nullifier 拒的是链上账户创建，资金未动：vault 仍持有 AMOUNT
    const vault = await getAccount(
      provider.connection,
      ata(mint, escrowPda(commitment(), sender.publicKey))
    );
    assert.equal(vault.amount.toString(), AMOUNT.toString());
  });
});
