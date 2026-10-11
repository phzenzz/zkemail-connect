// 开发自测：在本地 validator 上造真实数据（初始化 protocol/relayer + 单发 escrow + 批量 batch），
// 再用 app 同款的 fetchSentHistory（app/src/react-app/lib/sendHistory.ts）解析发送记录，
// 验证 Send 页「发送记录」的链上解析逻辑：托管地址、金额、时间倒序、领取情况。
// 前提：solana-test-validator 已在 8899 运行且程序已部署（见 docs/手动测试指南.md 终端 1）。
// 运行：npx tsx e2e/check-send-history.ts
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { randomBytes } from "crypto";
import fs from "fs";
import path from "path";
import { buildBatchTree } from "../circuits/scripts/merkle";
import { fetchSentHistory } from "../app/src/react-app/lib/sendHistory";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const ROOT = path.resolve(__dirname, "..");

const AMOUNT = 50_000_000n; // 单发 50 代币（6 位小数）
const AMOUNT_PER = 25_000_000n; // 批量每人 25 代币
const RELAYER_EMAIL = "history-check@example.com";
// 链上只存不验 hash，任意 32 字节即可（真实的 = Poseidon(email)，见 relayer/crypto.ts）
const RELAYER_HASH = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i + 1));

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const programId = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(path.join(ROOT, "onchain/target/deploy/email_wallet-keypair.json"), "utf8")))).publicKey;
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "onchain/target/idl/email_wallet.json"), "utf8"));
  idl.address = programId.toBase58();

  const sender = Keypair.generate();
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(sender), { commitment: "confirmed" });
  const program = new anchor.Program(idl, provider) as any;

  const airdrop = await conn.requestAirdrop(sender.publicKey, 3 * 1e9);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: airdrop, blockhash, lastValidBlockHeight }, "confirmed");
  console.log("[setup] sender =", sender.publicKey.toBase58());

  // protocol + relayer（幂等：validator 上已初始化则跳过）
  const protocolPda = PublicKey.findProgramAddressSync([Buffer.from("protocol")], programId)[0];
  let treasury = sender.publicKey;
  const protocol = await program.account.protocolConfig.fetchNullable(protocolPda);
  if (!protocol) {
    await program.methods.initializeProtocol(sender.publicKey, new anchor.BN(1_000_000), new anchor.BN(2_592_000))
      .accounts({ config: protocolPda, payer: sender.publicKey }).rpc();
    console.log("[setup] protocol initialized");
  } else {
    treasury = protocol.treasury;
    console.log("[setup] protocol already initialized");
  }
  const relayerEntry = PublicKey.findProgramAddressSync([Buffer.from("relayer"), Buffer.from(RELAYER_HASH)], programId)[0];
  if (!(await program.account.relayerEntry.fetchNullable(relayerEntry))) {
    await program.methods.registerRelayer(
      RELAYER_EMAIL, Array.from(RELAYER_HASH), Array.from(new Uint8Array(32)), sender.publicKey, new anchor.BN(0),
    ).accounts({ relayerEntry, claimAuthority: sender.publicKey }).rpc();
    console.log("[setup] relayer registered");
  } else {
    console.log("[setup] relayer already registered");
  }

  // 代币：新建 mint、建 sender 的 ATA 并铸 1000
  const mint = await createMint(conn, sender, sender.publicKey, null, 6);
  const senderAtaInfo = await getOrCreateAssociatedTokenAccount(conn, sender, mint, sender.publicKey);
  const senderAta = senderAtaInfo.address;
  await mintTo(conn, sender, mint, senderAta, sender, 1_000_000_000n);
  console.log("[setup] mint =", mint.toBase58());

  // 1) 单发 escrow
  const commitment = Buffer.alloc(32);
  commitment[31] = 42; // 小于 FR_MODULUS 即可，create 只校验范围
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), commitment, sender.publicKey.toBuffer()], programId);
  await program.methods.createEscrow(
    Array.from(commitment), new anchor.BN(AMOUNT.toString()), Buffer.from("cipher-stub"), Array.from(RELAYER_HASH),
  ).accounts({
    escrow: escrowPda,
    vault: getAssociatedTokenAddressSync(mint, escrowPda, true),
    mint, senderAta, sender: sender.publicKey,
    config: protocolPda, treasury, relayerEntry,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }).rpc();
  console.log("[send] escrow =", escrowPda.toBase58());

  // 2) 批量 batch（2 叶：create → append → seal）
  const leafA = Buffer.alloc(32); leafA[31] = 7;
  const leafB = Buffer.alloc(32); leafB[31] = 8;
  const tree = buildBatchTree([leafA, leafB]);
  const nonce = new anchor.BN(randomBytes(8).toString("hex"), 16);
  const [batchPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("batch"), sender.publicKey.toBuffer(), tree.root, nonce.toArrayLike(Buffer, "le", 8)],
    programId);
  const cipher = Buffer.from(JSON.stringify(["a@example.com", "b@example.com"]));
  await program.methods.createBatch(
    Array.from(tree.root), new anchor.BN(AMOUNT_PER.toString()), 2, cipher.length,
    new anchor.BN(Math.floor(Date.now() / 1000) + 7 * 86_400), Array.from(RELAYER_HASH), nonce,
  ).accounts({
    batch: batchPda,
    vault: getAssociatedTokenAddressSync(mint, batchPda, true),
    mint, senderAta, sender: sender.publicKey,
    config: protocolPda, treasury, relayerEntry,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }).rpc();
  await program.methods.appendBatchCipher(cipher)
    .accounts({ batch: batchPda, sender: sender.publicKey }).rpc();
  await program.methods.sealBatch()
    .accounts({ batch: batchPda, sender: sender.publicKey }).rpc();
  console.log("[send] batch =", batchPda.toBase58());

  // 3) 用 app 同款逻辑解析发送记录并断言
  const rows = await fetchSentHistory(conn, program, programId, sender.publicKey);
  console.log("[check] parsed:", JSON.stringify(
    rows.map((r) => ({ ...r, amountPer: r.amountPer.toString() })), null, 2));

  const fail: string[] = [];
  const expect = (cond: boolean, msg: string) => { if (!cond) fail.push(msg); };
  expect(rows.length === 2, `应解析出 2 条记录，实际 ${rows.length}`);
  const escrowRow = rows.find((r) => r.kind === "escrow");
  const batchRow = rows.find((r) => r.kind === "batch");
  expect(!!escrowRow, "缺少 escrow 记录");
  expect(!!batchRow, "缺少 batch 记录");
  if (escrowRow) {
    expect(escrowRow.pda === escrowPda.toBase58(), "escrow 托管地址不符");
    expect(escrowRow.amountPer === AMOUNT, "escrow 金额不符");
    expect(escrowRow.status.state === "pending", `escrow 应为待领取，实际 ${escrowRow.status.state}`);
    expect(escrowRow.createdAt !== null, "escrow 缺少发送时间");
  }
  if (batchRow) {
    expect(batchRow.pda === batchPda.toBase58(), "batch 托管地址不符");
    expect(batchRow.amountPer === AMOUNT_PER, "batch 每人金额不符");
    expect(batchRow.count === 2, "batch 人数不符");
    expect(batchRow.status.state === "open", `batch 应为 open，实际 ${batchRow.status.state}`);
    if (batchRow.status.state === "open") {
      expect(batchRow.status.sealed === true, "batch 应已密封");
      expect(batchRow.status.claimed === 0, "batch 已领取数应为 0");
      expect(batchRow.status.count === 2, "batch 可领总数不符");
    }
  }
  if (rows.length === 2) {
    const t0 = rows[0].createdAt ?? 0;
    const t1 = rows[1].createdAt ?? 0;
    expect(t0 >= t1, "时间应倒序排列");
  }

  if (fail.length > 0) {
    console.error(`[check] FAIL:\n - ${fail.join("\n - ")}`);
    process.exit(1);
  }
  console.log("[check] OK：单发（待领取）+ 批量（0/2 已密封）两条记录，托管地址 / 金额 / 倒序全部正确");
}

main().catch((e) => { console.error("FAIL:", e?.message ?? e); process.exit(1); });
