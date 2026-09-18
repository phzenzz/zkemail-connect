import * as anchor from "@coral-xyz/anchor";
import {
  createMint,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { assert } from "chai";
import { execFileSync } from "child_process";
import fs from "fs";
import {
  program,
  provider,
  inboxPda,
  registryPda,
  configPda,
  fundSender,
  fieldToBE,
} from "./helpers";

// sweep.eml：与 claim.eml 相同的真实 QQ 邮件（inbox 以 commitment = From 邮箱为键）
const SWEEP_EML = "../circuits/testdata/emails/sweep.eml";
const FIXTURE_PATH = "../circuits/build/sweep-proof.json";
const FIRST_DEPOSIT = 777_000;
const SECOND_DEPOSIT = 55_000;

describe("sweep_inbox", () => {
  const funder = Keypair.generate();
  const payer = Keypair.generate(); // acts as relayer (proof binds this key)
  let mint: PublicKey;
  let fixture: any;
  let commitment: Buffer;
  let inbox: PublicKey;
  const selector = () => fixture.meta.selector as string; // 真实 DKIM selector
  const destOwner = () => new PublicKey(fixture.meta.destBase58 as string);
  const registry = () =>
    registryPda(fieldToBE(fixture.meta.domainCommitment), selector());

  // getTransaction 可能滞后于 confirm，重试取回 meta 里的 CU
  const cuOf = async (sig: string): Promise<number | undefined> => {
    for (let i = 0; i < 5; i++) {
      const tx = await provider.connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (tx?.meta?.computeUnitsConsumed != null)
        return tx.meta.computeUnitsConsumed;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return undefined;
  };

  before(async function () {
    this.timeout(900_000);
    await fundSender(funder);
    await fundSender(payer);
    mint = await createMint(
      provider.connection,
      funder,
      funder.publicKey,
      null,
      6
    );

    // 用真实邮件出证明，relayer 绑定 payer 公钥。
    // PROVER_URL 设置时走 prover 容器（~7s），否则本地 snarkjs（~90s+）。
    execFileSync(
      "npx",
      ["tsx", "../circuits/scripts/prove-for.ts", SWEEP_EML, payer.publicKey.toBase58(), "build/sweep-proof.json"],
      {
        cwd: "../circuits",
        stdio: "inherit",
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=16384" },
      }
    );
    fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
    commitment = fieldToBE(fixture.meta.commitment);
    inbox = inboxPda(commitment);

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

    // 任何人直接给 inbox 的 ATA 打币（无需任何链上初始化）。
    // inbox 是 PDA（off-curve），必须显式 allowOwnerOffCurve：
    const inboxAta = getAssociatedTokenAddressSync(mint, inbox, true);
    const createTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        funder.publicKey,
        inboxAta,
        inbox,
        mint
      )
    );
    await provider.sendAndConfirm(createTx, [funder]);
    await mintTo(
      provider.connection,
      funder,
      mint,
      inboxAta,
      funder,
      FIRST_DEPOSIT
    );
  });

  const sweepTx = () => {
    const inboxAta = getAssociatedTokenAddressSync(mint, inbox, true);
    const destAta = getAssociatedTokenAddressSync(mint, destOwner());
    return program.methods
      .sweepInbox({
        proofA: fixture.proofA,
        proofB: fixture.proofB,
        proofC: fixture.proofC,
        publicInputs: fixture.publicInputs,
        selector: selector(),
      } as any)
      .accounts({
        inbox,
        registry: registry(),
        destOwner: destOwner(),
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: inboxAta, isSigner: false, isWritable: true },
        { pubkey: destAta, isSigner: false, isWritable: true },
      ])
      .signers([payer])
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ]);
  };

  it("sweeps inbox balance to proof-bound dest", async () => {
    const sig = await sweepTx().rpc();

    const destAta = await getAccount(
      provider.connection,
      getAssociatedTokenAddressSync(mint, destOwner())
    );
    assert.equal(destAta.amount.toString(), FIRST_DEPOSIT.toString());
    const inboxAta = await getAccount(
      provider.connection,
      getAssociatedTokenAddressSync(mint, inbox, true)
    );
    assert.equal(inboxAta.amount.toString(), "0");

    // 记录链上日志/CU 供报告使用
    console.log(`sweep tx ${sig} consumed ${await cuOf(sig)} CU`);
  });

  it("v1.5: re-sweeping with the same proof succeeds and sweeps new deposits", async () => {
    // 再次给 inbox 打币，用同一份 proof 重复 sweep：
    // v1.5 语义下重放无害——资金始终只去 proof 绑定的 dest。
    await mintTo(
      provider.connection,
      funder,
      mint,
      getAssociatedTokenAddressSync(mint, inbox, true),
      funder,
      SECOND_DEPOSIT
    );
    const sig = await sweepTx().rpc();

    const destAta = await getAccount(
      provider.connection,
      getAssociatedTokenAddressSync(mint, destOwner())
    );
    assert.equal(
      destAta.amount.toString(),
      (FIRST_DEPOSIT + SECOND_DEPOSIT).toString()
    );
    const inboxAta = await getAccount(
      provider.connection,
      getAssociatedTokenAddressSync(mint, inbox, true)
    );
    assert.equal(inboxAta.amount.toString(), "0");

    console.log(`re-sweep tx ${sig} consumed ${await cuOf(sig)} CU`);
  });
});
