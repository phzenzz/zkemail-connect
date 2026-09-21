import * as anchor from "@coral-xyz/anchor";
import {
  createMint,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, AddressLookupTableAccount } from "@solana/web3.js";
import { assert, expect } from "chai";
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
  protocolConfigPda,
  nullifierPda,
  createAltAccount,
  sendV0Tx,
} from "./helpers";

// sweep.eml：与 claim.eml / e2e.eml 相同的真实 QQ 邮件（inbox 以 commitment = From 邮箱为键）。
// v1.7 起三份替身共享同一 emailNullifier（exactly-once）：claim 套件花掉 nullifier 后，
// 本套件首笔 sweep 会因 nullifier 已存在被拒——因此各套件必须分 validator 生命周期单独跑
// （pkill + --reset 后按组跑，见 .superpowers/sdd/2026-09-21-email-nullifier/task-5-report.md）。
const SWEEP_EML = "../circuits/testdata/emails/sweep.eml";
const FIXTURE_PATH = "../circuits/build/sweep-proof.json";
const FIRST_DEPOSIT = 777_000;
const SECOND_DEPOSIT = 55_000;
const THIRD_DEPOSIT = 66_000; // 仅 "fresh email" 正向用例（it.skip）使用

describe("sweep_inbox", () => {
  const funder = Keypair.generate();
  const payer = Keypair.generate(); // acts as relayer (proof binds this key)
  let mint: PublicKey;
  let fixture: any;
  let commitment: Buffer;
  let inbox: PublicKey;
  let altAccount: AddressLookupTableAccount; // sweep 交易经 v0 + ALT 发送（legacy 1232B 放不下 Groth16 证明）
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

    // sweep 与 claim 共享 verify_claim_common：时间窗校验读 protocol config，
    // 本套件独立跑（validator --reset）时必须自初始化。
    const treasury = Keypair.generate();
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

    // v0 地址查找表：静态账户列表压缩后 sweep 交易才进得了 1232B 上限
    altAccount = await createAltAccount([
      program.programId,
      SystemProgram.programId,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      mint,
      inbox,
      registry(),
      destOwner(),
      inboxAta,
      getAssociatedTokenAddressSync(mint, destOwner()),
      nullifierPda(fieldToBE(fixture.meta.emailNullifier)),
      protocolConfigPda(),
    ]);
  });

  // 返回 sweep 指令集（含 CU limit preInstruction），由调用方经 sendV0Tx + ALT 发送
  const sweepIxs = async () => {
    const inboxAta = getAssociatedTokenAddressSync(mint, inbox, true);
    const destAta = getAssociatedTokenAddressSync(mint, destOwner());
    const tx = await program.methods
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
        nullifier: nullifierPda(fieldToBE(fixture.meta.emailNullifier)),
        protocolConfig: protocolConfigPda(),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: inboxAta, isSigner: false, isWritable: true },
        { pubkey: destAta, isSigner: false, isWritable: true },
      ])
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ])
      .transaction();
    return tx.instructions;
  };

  const sweepV0 = async () =>
    sendV0Tx(await sweepIxs(), [payer], [altAccount], payer.publicKey);

  it("sweeps inbox balance to proof-bound dest", async () => {
    const sig = await sweepV0();

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

  it("rejects re-sweeping with the same proof (nullifier spent)", async () => {
    // v1.7 exactly-once：同一份 proof 的第二次 sweep 必须被 nullifier init 拒绝。
    // 与 v1.5 "重放无害"语义相反——资金始终只去 proof 绑定的 dest，重放不再允许。
    await mintTo(
      provider.connection,
      funder,
      mint,
      getAssociatedTokenAddressSync(mint, inbox, true),
      funder,
      SECOND_DEPOSIT
    );
    await expect(sweepV0()).to.be.rejectedWith(
      /already in use|NullifierAlreadyUsed|custom program error: 0x0/i
    );

    // nullifier 拒的是链上账户创建，资金未动：inbox 仍持有新打的 SECOND_DEPOSIT
    const inboxAta = await getAccount(
      provider.connection,
      getAssociatedTokenAddressSync(mint, inbox, true)
    );
    assert.equal(inboxAta.amount.toString(), SECOND_DEPOSIT.toString());
  });

  it.skip("sweeps new deposits with a fresh email (needs an independent second .eml)", async () => {
    // 正向用例：用户导出独立的第二封邮件 sweep2.eml（同 From、不同 DKIM 签名 →
    // 不同 emailNullifier）后启用：对其出证明并 sweep，断言
    // dest = FIRST_DEPOSIT + SECOND_DEPOSIT + THIRD_DEPOSIT、inbox 归零。
    // 跳过原因：当前 sweep.eml 是 e2e.eml 的替身（用户指令不导出新邮件），
    // 不存在第二封独立邮件，nullifier 必然碰撞。
    const FRESH_EML = "../circuits/testdata/emails/sweep2.eml";
    execFileSync(
      "npx",
      ["tsx", "../circuits/scripts/prove-for.ts", FRESH_EML, payer.publicKey.toBase58(), "build/sweep2-proof.json"],
      {
        cwd: "../circuits",
        stdio: "inherit",
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=16384" },
      }
    );
    const fresh = JSON.parse(
      fs.readFileSync("../circuits/build/sweep2-proof.json", "utf8")
    );
    await mintTo(
      provider.connection,
      funder,
      mint,
      getAssociatedTokenAddressSync(mint, inbox, true),
      funder,
      THIRD_DEPOSIT
    );
    const inboxAta = getAssociatedTokenAddressSync(mint, inbox, true);
    const destAta = getAssociatedTokenAddressSync(mint, destOwner());
    const freshTx = await program.methods
      .sweepInbox({
        proofA: fresh.proofA,
        proofB: fresh.proofB,
        proofC: fresh.proofC,
        publicInputs: fresh.publicInputs,
        selector: selector(),
      } as any)
      .accounts({
        inbox,
        registry: registry(),
        destOwner: destOwner(),
        payer: payer.publicKey,
        nullifier: nullifierPda(fieldToBE(fresh.meta.emailNullifier)),
        protocolConfig: protocolConfigPda(),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: inboxAta, isSigner: false, isWritable: true },
        { pubkey: destAta, isSigner: false, isWritable: true },
      ])
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ])
      .transaction();
    await sendV0Tx(freshTx.instructions, [payer], [altAccount], payer.publicKey);

    const dest = await getAccount(provider.connection, destAta);
    assert.equal(
      dest.amount.toString(),
      (FIRST_DEPOSIT + SECOND_DEPOSIT + THIRD_DEPOSIT).toString()
    );
    const inboxAfter = await getAccount(provider.connection, inboxAta);
    assert.equal(inboxAfter.amount.toString(), "0");
  });
});
