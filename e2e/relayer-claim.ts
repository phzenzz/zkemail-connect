// claimer 集成测试:本地 validator + prover 容器 + 真实 .eml,直接调 claimEscrow(绕过 IMAP/Gmail)。
// 与 e2e/e2e.ts 的差异:claim 段走 relayer/claimer.ts,验证 Task 9 的生产代码路径。
// 适配(Task 12 rulings):优先复用已运行的本地 validator(不 spawn、不 --reset、不杀别人的进程);
// RPC 不可达或程序未部署时,回退为自起 validator(e2e.ts 同款),仅清理自己 spawn 的进程。
// prover 由 docker compose 管理,不随脚本退出销毁。
import { execFileSync, spawn, ChildProcess } from "child_process";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createMint, createAccount, mintTo, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";
import path from "path";
import nacl from "tweetnacl";
import { sealEmailForRelayer } from "../relayer/crypto";
import { claimEscrow, ClaimerDeps } from "../relayer/claimer";

const ROOT = path.resolve(__dirname, "..");
const RPC = "http://127.0.0.1:8899";
const EML = path.join(ROOT, "circuits/testdata/emails/e2e.eml");
const AMOUNT = 50_000_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fieldToBE = (v: bigint) => {
  const b = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
};

const children: ChildProcess[] = [];
process.on("exit", () => { for (const c of children) try { c.kill(); } catch {} });

async function waitRpc(conn: Connection) {
  for (let i = 0; i < 60; i++) {
    try { await conn.getSlot(); return; } catch { await sleep(500); }
  }
  throw new Error("validator did not start");
}

async function main() {
  const { loadClaimEmail } = await import("../circuits/scripts/load-email");
  const { relayerToField } = await import("../circuits/scripts/poseidon");
  const relayer = Keypair.generate();
  const sender = Keypair.generate();
  const treasury = Keypair.generate();
  const relayerX25519 = nacl.box.keyPair();
  const email = await loadClaimEmail(EML, relayerToField(relayer.publicKey.toBytes()));
  const relayerEmail = email.meta.toEmail;
  const relayerHash = fieldToBE(BigInt(email.meta.relayerEmailHash));
  const commitment = fieldToBE(BigInt(email.meta.commitment));
  process.env.RELAYER_EMAIL = relayerEmail; // claimer 内校验 To 绑定

  // 优先复用运行中的 validator;RPC 不可达或程序缺失时回退自起(e2e.ts 同款),只清理自己 spawn 的
  const conn = new Connection(RPC, "confirmed");
  let reachable = false;
  for (let i = 0; i < 10; i++) { try { await conn.getSlot(); reachable = true; break; } catch { await sleep(500); } }
  const readProgramId = () => Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync(path.join(ROOT, "onchain/target/deploy/email_wallet-keypair.json"), "utf8"))))
    .publicKey.toBase58();
  let programIdStr = readProgramId();
  let deployed = false;
  if (reachable) {
    try { deployed = !!(await conn.getAccountInfo(new PublicKey(programIdStr)))?.executable; } catch { deployed = false; }
  }
  if (deployed) {
    console.log(`[e2e:relayer] reusing running validator, program ${programIdStr} deployed`);
  } else {
    console.log(`[e2e:relayer] ${reachable ? "program missing on running validator" : "no validator reachable"}, spawning our own`);
    execFileSync("anchor", ["build"], { cwd: path.join(ROOT, "onchain"), stdio: "inherit",
      env: { ...process.env, PATH: `${process.env.HOME}/.avm/bin:${process.env.PATH}` } });
    programIdStr = readProgramId();
    const validator = spawn("solana-test-validator", ["--reset", "--quiet", "--bpf-program",
      programIdStr, path.join(ROOT, "onchain/target/deploy/email_wallet.so")],
      { cwd: path.join(ROOT, "onchain"), stdio: "ignore" });
    children.push(validator);
    await waitRpc(conn);
  }
  const programId = new PublicKey(programIdStr);

  for (const kp of [relayer, sender, treasury]) {
    const sig = await conn.requestAirdrop(kp.publicKey, 5e9);
    await conn.confirmTransaction(sig);
  }
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "onchain/target/idl/email_wallet.json"), "utf8"));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(relayer), { commitment: "confirmed" });
  const program: any = new anchor.Program(idl, provider);
  const protocolConfig = PublicKey.findProgramAddressSync([Buffer.from("protocol")], programId)[0];
  const relayerEntry = PublicKey.findProgramAddressSync([Buffer.from("relayer"), relayerHash], programId)[0];
  try {
    await program.methods.initializeProtocol(treasury.publicKey, new anchor.BN(1_000_000), new anchor.BN(2_592_000))
      .accounts({ config: protocolConfig, payer: relayer.publicKey }).rpc();
  } catch { /* already initialized(validator 账本持久) */ }
  await program.methods.registerRelayer(relayerEmail, Array.from(relayerHash), Array.from(relayerX25519.publicKey), relayer.publicKey, new anchor.BN(0))
    .accounts({ relayerEntry, claimAuthority: relayer.publicKey }).rpc();
  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
  try {
    await program.methods.initializeRegistry(relayer.publicKey)
      .accounts({ config: configPda, payer: relayer.publicKey }).rpc();
  } catch { /* already initialized */ }

  // sender 建托管
  const mint = await createMint(conn, sender, sender.publicKey, null, 6);
  const senderAta = await createAccount(conn, sender, mint, sender.publicKey);
  await mintTo(conn, sender, mint, senderAta, sender, 1_000_000_000);
  const escrow = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), commitment, sender.publicKey.toBuffer()], programId)[0];
  const ata = (m: PublicKey, o: PublicKey) => anchor.utils.token.associatedAddress({ mint: m, owner: o });
  const cipher = sealEmailForRelayer(email.meta.fromEmail, relayerX25519.publicKey);
  await program.methods.createEscrow(Array.from(commitment), new anchor.BN(AMOUNT), cipher, Array.from(relayerHash))
    .accounts({ escrow, mint, vault: ata(mint, escrow), senderAta, sender: sender.publicKey,
      config: protocolConfig, treasury: treasury.publicKey, relayerEntry,
      tokenProgram: TOKEN_PROGRAM_ID })
    .signers([sender]).rpc();
  console.log("[e2e:relayer] escrow created");

  // prover 容器
  execFileSync("docker", ["compose", "up", "-d", "--build", "prover"], { cwd: ROOT, stdio: "inherit" });
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch("http://localhost:8080/health"); if (r.ok) break; } catch {}
    await sleep(1000);
  }

  // 生产代码路径:claimer(内含 registry 兜底 upsert)
  const deps: ClaimerDeps = { connection: conn, program, programId, relayerKeypair: relayer, proverUrl: "http://localhost:8080" };
  const sig = await claimEscrow(deps, { emlPath: EML, escrow });
  console.log("[e2e:relayer] claim tx:", sig);

  // 断言
  const destOwner = new PublicKey(email.meta.destBase58);
  const destAta = await getAccount(conn, ata(mint, destOwner));
  if (destAta.amount.toString() !== AMOUNT.toString()) throw new Error("dest balance mismatch");
  if (await conn.getAccountInfo(escrow)) throw new Error("escrow not closed");
  if (await conn.getAccountInfo(ata(mint, escrow))) throw new Error("vault not closed");
  // 幂等:重复调用应抛 "already closed"
  let replayed = false;
  try { await claimEscrow(deps, { emlPath: EML, escrow }); } catch { replayed = true; }
  if (!replayed) throw new Error("replay was not rejected");
  console.log("[e2e:relayer] ALL PASS");
  process.exit(0);
}
main().catch((e) => { console.error("[e2e:relayer] FAIL:", e?.message ?? e); process.exit(1); });
