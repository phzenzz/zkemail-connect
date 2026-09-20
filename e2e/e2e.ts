// e2e: 真实 .eml → prover 容器出证明 → 本地验证器全流程（v1.6：relayer 注册表 + 加密邮箱 + 手续费）
// 用法: npm run e2e（在 repo 根目录；退出码非 0 = 失败）
// 顺序与生产一致：先解析真实邮件（Subject = dest base58，DKIM 走真实 DNS），
// 运营侧初始化 protocol config + 注册 relayer，sender 建托管（createEscrow v1.6：
// commitment + amount + 加密邮箱 + relayer 标识 + 协议手续费），indexer 解密通知收件人，
// 最后出证明并 claim。
import { spawn, execFileSync, ChildProcess } from "child_process";
import nacl from "tweetnacl";
import { sealEmailForRelayer, relayerEmailHash } from "../relayer/crypto";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  createMint, createAccount, mintTo, getAccount, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..");
const RPC = "http://127.0.0.1:8899";
const EML = path.join(ROOT, "circuits/testdata/emails/e2e.eml");
const PROOF_OUT = path.join(ROOT, "circuits/build/e2e-proof.json");
const MINT_SUPPLY = 1_000_000_000;
const AMOUNT = 50_000_000;
const RELAYER_EMAIL = "relay@zkemail.io";
const PROTOCOL_FEE = 1_000_000; // 0.001 SOL

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fieldToBE = (s: string) => {
  let v = BigInt(s); const b = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
};

const children: ChildProcess[] = [];
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const c of children) { try { c.kill(); } catch { /* already dead */ } }
  try { execFileSync("docker", ["compose", "down"], { cwd: ROOT, stdio: "ignore" }); } catch { /* not up */ }
}
process.on("exit", cleanup);

async function waitRpc(conn: Connection) {
  for (let i = 0; i < 60; i++) {
    try { await conn.getSlot(); return; } catch { await sleep(500); }
  }
  throw new Error("validator did not start");
}

async function main() {
  const t0 = Date.now();
  // 0. 先解析真实邮件（relayer 公钥绑定进电路输入），拿到 dest / commitment / selector
  const relayer = Keypair.generate(); // 代付方（证明绑定它）
  const sender = Keypair.generate();  // 托管发送方
  const relayerX25519 = nacl.box.keyPair();
  const treasury = Keypair.generate();
  const { loadClaimEmail } = await import("../circuits/scripts/load-email");
  const { relayerToField } = await import("../circuits/scripts/poseidon");
  const email = await loadClaimEmail(EML, relayerToField(relayer.publicKey.toBytes()));
  const { destBase58, selector } = email.meta;
  const commitment = fieldToBE(email.meta.commitment);
  console.log(`[e2e] email parsed: from=${email.meta.fromEmail} domain=${email.meta.domain} selector=${selector} dest=${destBase58}`);

  // 1. build program & start a fresh local validator with the program deployed
  execFileSync("anchor", ["build"], {
    cwd: path.join(ROOT, "onchain"), stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.avm/bin:${process.env.PATH}` },
  });
  const programIdStr = Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync(path.join(ROOT, "onchain/target/deploy/email_wallet-keypair.json"), "utf8"))))
    .publicKey.toBase58();
  const programId = new PublicKey(programIdStr);
  const validator = spawn("solana-test-validator", [
    "--reset", "--quiet",
    "--bpf-program", programIdStr, path.join(ROOT, "onchain/target/deploy/email_wallet.so"),
  ], { cwd: path.join(ROOT, "onchain"), stdio: "ignore" });
  children.push(validator);

  const conn = new Connection(RPC, "confirmed");
  await waitRpc(conn);

  for (const kp of [sender, relayer, treasury]) {
    const sig = await conn.requestAirdrop(kp.publicKey, 5e9);
    await conn.confirmTransaction(sig);
  }
  console.log(`[e2e] validator up with program ${programIdStr}, sender+relayer airdropped`);

  // 1.5 运营侧：初始化 protocol config + 注册 relayer（发件邮箱即标识）
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "onchain/target/idl/email_wallet.json"), "utf8"));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(relayer), { commitment: "confirmed" });
  const program = new Program(idl, provider) as any;
  const protocolConfig = PublicKey.findProgramAddressSync([Buffer.from("protocol")], programId)[0];
  const relayerHash = await relayerEmailHash(RELAYER_EMAIL);
  const relayerEntry = PublicKey.findProgramAddressSync(
    [Buffer.from("relayer"), relayerHash], programId)[0];
  try {
    await program.methods.initializeProtocol(treasury.publicKey, new anchor.BN(PROTOCOL_FEE))
      .accounts({ config: protocolConfig, payer: relayer.publicKey }).rpc();
  } catch { /* already initialized */ }
  await program.methods.registerRelayer(
      RELAYER_EMAIL, Array.from(relayerHash), Array.from(relayerX25519.publicKey),
      relayer.publicKey, new anchor.BN(0))
    .accounts({ relayerEntry, claimAuthority: relayer.publicKey }).rpc();
  console.log(`[e2e] relayer registered: ${RELAYER_EMAIL} entry=${relayerEntry.toBase58()}`);

  // 2. sender 侧：创建 SPL mint + 存币建托管（commitment 对应邮件 From 邮箱）
  const mint = await createMint(conn, sender, sender.publicKey, null, 6);
  const senderAta = await createAccount(conn, sender, mint, sender.publicKey);
  await mintTo(conn, sender, mint, senderAta, sender, MINT_SUPPLY);
  const escrow = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), commitment, sender.publicKey.toBuffer()], programId)[0];
  const ata = (m: PublicKey, o: PublicKey) => anchor.utils.token.associatedAddress({ mint: m, owner: o });

  // 2.5 启动 relayer 索引器：必须先于 createEscrow 就绪，否则错过 escrowCreated 事件
  const cipher = sealEmailForRelayer(email.meta.fromEmail, relayerX25519.publicKey);
  const indexer = spawn("npx", ["tsx", "relayer/indexer.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      RELAYER_EMAIL,
      RELAYER_X25519_SECRET_HEX: Buffer.from(relayerX25519.secretKey).toString("hex"),
      RPC_URL: RPC,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push({ kill: () => indexer.kill() } as any);
  let listening = false;
  let notified = false;
  indexer.stdout!.on("data", (d: Buffer) => {
    const line = d.toString();
    process.stdout.write(`[indexer] ${line}`);
    if (line.includes("listening")) listening = true;
    if (line.includes(`[notify] to=${email.meta.fromEmail}`)) notified = true;
  });
  for (let i = 0; i < 30 && !listening; i++) await sleep(1000);
  if (!listening) throw new Error("indexer did not start listening");
  await sleep(2000); // addEventListener 在 listening 日志之后才完成 ws 订阅，留一点余量

  const treasuryBefore = await conn.getBalance(treasury.publicKey);
  await program.methods.createEscrow(
      Array.from(commitment), new anchor.BN(AMOUNT),
      cipher, Array.from(relayerHash))
    .accounts({
      escrow, mint, vault: ata(mint, escrow), senderAta, sender: sender.publicKey,
      config: protocolConfig, treasury: treasury.publicKey, relayerEntry,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([sender]).rpc();
  console.log(`[e2e] escrow created: ${escrow.toBase58()} amount=${AMOUNT}`);
  const treasuryAfter = await conn.getBalance(treasury.publicKey);
  if (treasuryAfter - treasuryBefore !== PROTOCOL_FEE) throw new Error("protocol fee not collected");
  console.log(`[e2e] escrow created + protocol fee ${PROTOCOL_FEE} lamports collected`);

  for (let i = 0; i < 30 && !notified; i++) await sleep(1000);
  if (!notified) throw new Error("indexer did not notify recipient");
  console.log("[e2e] indexer decrypted cipher and notified recipient");

  // 3. 起 prover 容器（Task 13），对真实邮件出证明
  execFileSync("docker", ["compose", "up", "-d", "--build", "prover"], { cwd: ROOT, stdio: "inherit" });
  for (let i = 0; i < 120; i++) { // 首次构建镜像较慢，耐心等 health
    try {
      const r = await fetch("http://localhost:8080/health");
      if (r.ok) break;
    } catch { /* not up yet */ }
    await sleep(1000);
    if (i === 119) throw new Error("prover container did not become healthy");
  }
  const proveStart = Date.now();
  execFileSync("npx", ["tsx", "scripts/prove-for.ts",
    EML, relayer.publicKey.toBase58(), PROOF_OUT],
    { cwd: path.join(ROOT, "circuits"), stdio: "inherit",
      env: { ...process.env, PROVER_URL: "http://localhost:8080" } });
  const fixture = JSON.parse(fs.readFileSync(PROOF_OUT, "utf8"));
  const proveMs = Date.now() - proveStart;
  console.log(`[e2e] proof generated via prover container in ${proveMs}ms`);
  if (proveMs > 30_000) throw new Error(`NFR-3 violated: proving took ${proveMs}ms > 30s`);

  // 4. 运营侧：把该服务商（真实 DNS 取回）的 DKIM 公钥哈希注册上链
  const config = PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
  try {
    await program.methods.initializeRegistry(relayer.publicKey)
      .accounts({ config, payer: relayer.publicKey }).rpc();
  } catch { /* already initialized */ }
  const registry = PublicKey.findProgramAddressSync(
    [Buffer.from("dkim"), fieldToBE(fixture.meta.domainCommitment), Buffer.from(selector)],
    programId)[0];
  await program.methods.registryUpsert(
      Array.from(fieldToBE(fixture.meta.domainCommitment)), selector,
      Array.from(fieldToBE(fixture.meta.pubkeyHash)), new anchor.BN(Math.floor(Date.now() / 1000) + 3600))
    .accounts({ config, registry, authority: relayer.publicKey }).rpc();
  console.log(`[e2e] dkim registry upserted for ${email.meta.domain} selector=${selector}`);

  // 5. claim：单笔交易 = 验证明 + 解码 dest + 转账 + 关账户
  const destOwner = new PublicKey(destBase58);
  const claimStart = Date.now();
  const sig = await program.methods.claim({
    proofA: fixture.proofA, proofB: fixture.proofB, proofC: fixture.proofC,
    publicInputs: fixture.publicInputs, selector,
  })
    .accounts({
      escrow, sender: sender.publicKey, vault: ata(mint, escrow), mint,
      registry, destOwner, destAta: ata(mint, destOwner), payer: relayer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
    .signers([relayer]).rpc();
  console.log(`[e2e] claim tx: ${sig} (${Date.now() - claimStart}ms)`);

  // 6. 断言终态
  const destAta = await getAccount(conn, ata(mint, destOwner));
  if (destAta.amount.toString() !== AMOUNT.toString()) throw new Error(`dest balance mismatch: ${destAta.amount}`);
  if (await conn.getAccountInfo(escrow)) throw new Error("escrow not closed");
  if (await conn.getAccountInfo(ata(mint, escrow))) throw new Error("vault not closed");
  console.log(`[e2e] PASS: ${AMOUNT} tokens delivered to proof-bound dest ${destBase58}`);
  console.log(`[e2e] PASS: escrow + vault closed, NFR-3 proving ${proveMs}ms < 30s`);
  console.log(`[e2e] ALL PASS (total ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  cleanup();
  process.exit(0); // web3.js ws 客户端在 validator 退出后会无限重连，独占事件循环
}

main().catch((e) => { console.error("[e2e] FAIL:", e?.message ?? e); cleanup(); process.exit(1); });
