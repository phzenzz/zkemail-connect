// devnet 一次性初始化(幂等):protocol config → registry → relayer 注册 → DKIM(gmail) → 测试 mint。
// 用法: npx tsx onchain/scripts/devnet-init.ts   需 ~/.config/solana/id.json 有足够 devnet SOL(脚本自动 airdrop 2)。
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { promises as dns } from "dns";
import fs from "fs";
import os from "os";
import path from "path";
import nacl from "tweetnacl";
import { computeCommitment, computePubkeyHash, computeDomainCommitment } from "../../circuits/scripts/poseidon";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const RELAYER_EMAIL = (process.env.RELAYER_EMAIL ?? "penghe1996@gmail.com").toLowerCase();
const GMAIL_SELECTOR = process.env.REGISTRY_SELECTOR_GMAIL ?? "20230601";
const PROTOCOL_FEE = 1_000_000;        // 0.001 SOL
const WINDOW_PAST = 2_592_000;         // 30 天
const MINT_SUPPLY = 1_000_000_000;
const ROOT = path.resolve(__dirname, "..", "..");

function fieldToBE(v: bigint): Buffer {
  const b = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

/** DKIM TXT(v=DKIM1;k=rsa;p=...) → RSA 模数 n(DER SEQUENCE 内第一个 INTEGER,去前导 0)。 */
export async function dkimRsaModulus(selector: string, domain: string): Promise<bigint> {
  const txts = await dns.resolveTxt(`${selector}._domainkey.${domain}`);
  const record = txts.map((t) => t.join("")).find((t) => t.includes("p="));
  if (!record) throw new Error(`no DKIM record for ${selector}.${domain}`);
  const pB64 = record.split(";").map((s) => s.trim()).find((s) => s.startsWith("p="))!.slice(2).replace(/\s+/g, "");
  const der = Buffer.from(pB64, "base64");
  if (der[0] !== 0x30) throw new Error("not a DER sequence");
  let off = 2; // SEQUENCE header(短格式足够:DKIM key < 127B 头域假设不成立时按长格式走)
  if (der[1] & 0x80) { const n = der[1] & 0x7f; off = 2 + n; }
  if (der[off] !== 0x02) throw new Error("no INTEGER after SEQUENCE");
  const len = der[off + 1];
  let intStart = off + 2;
  let n = Buffer.from(der.subarray(intStart, intStart + len));
  if (n[0] === 0x00) n = n.subarray(1); // 前导零
  let v = 0n;
  for (const b of n) v = (v << 8n) | BigInt(b);
  return v;
}

async function main() {
  const kpPath = process.env.RELAYER_KEYPAIR_PATH ?? path.join(os.homedir(), ".config/solana/id.json");
  const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8"))));
  const conn = new Connection(RPC, "confirmed");
  const balance = await conn.getBalance(authority.publicKey);
  if (balance < 1e9) {
    const sig = await conn.requestAirdrop(authority.publicKey, 2e9);
    await conn.confirmTransaction(sig, "confirmed");
  }
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "onchain/target/idl/email_wallet.json"), "utf8"));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(authority), { commitment: "confirmed" });
  const program: any = new anchor.Program(idl, provider);
  const programId: PublicKey = program.programId;

  const [protocol] = PublicKey.findProgramAddressSync([Buffer.from("protocol")], programId);
  try {
    await program.methods.initializeProtocol(authority.publicKey, new anchor.BN(PROTOCOL_FEE), new anchor.BN(WINDOW_PAST))
      .accounts({ config: protocol, payer: authority.publicKey }).rpc();
    console.log("initialized protocol");
  } catch { console.log("protocol already initialized"); }

  const [registryConfig] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  try {
    await program.methods.initializeRegistry(authority.publicKey)
      .accounts({ config: registryConfig, payer: authority.publicKey }).rpc();
    console.log("initialized registry");
  } catch { console.log("registry already initialized"); }

  // relayer:x25519 私钥来自 env,没有则生成并打印(用户填入 .env)
  let secretHex = process.env.RELAYER_X25519_SECRET_HEX;
  if (!secretHex) {
    const kp = nacl.box.keyPair();
    secretHex = Buffer.from(kp.secretKey).toString("hex");
    console.log(`\n!!! 生成新 x25519 私钥,请写入根 .env: RELAYER_X25519_SECRET_HEX=${secretHex}\n`);
  }
  const x25519 = nacl.box.keyPair.fromSecretKey(Buffer.from(secretHex, "hex"));
  const emailHash = fieldToBE(await computeCommitment(RELAYER_EMAIL));
  const [relayerEntry] = PublicKey.findProgramAddressSync([Buffer.from("relayer"), emailHash], programId);
  const existing = await program.account.relayerEntry.fetchNullable(relayerEntry);
  if (!existing) {
    await program.methods.registerRelayer(
        RELAYER_EMAIL, Array.from(emailHash), Array.from(x25519.publicKey), authority.publicKey, new anchor.BN(0))
      .accounts({ relayerEntry, claimAuthority: authority.publicKey }).rpc();
    console.log("registered relayer:", RELAYER_EMAIL);
  } else console.log("relayer already registered");

  // gmail DKIM 公钥上链(非致命:selector 轮换频繁,失败时 claimer 的 ensureRegistry
  // 会在领取时按真实邮件的 DKIM-Signature 自动注册接收方域名,故此处仅作预热)
  try {
    const modulus = await dkimRsaModulus(GMAIL_SELECTOR, "gmail.com");
    const pubkeyHash = fieldToBE(await computePubkeyHash(modulus));
    const domainCommitment = fieldToBE(await computeDomainCommitment("gmail.com"));
    const [dkimReg] = PublicKey.findProgramAddressSync(
      [Buffer.from("dkim"), domainCommitment, Buffer.from(GMAIL_SELECTOR)], programId);
    await program.methods.registryUpsert(
        Array.from(domainCommitment), GMAIL_SELECTOR, Array.from(pubkeyHash),
        new anchor.BN(Math.floor(Date.now() / 1000) + 90 * 24 * 3600))
      .accounts({ config: registryConfig, registry: dkimReg, authority: authority.publicKey }).rpc();
    console.log(`dkim upserted: gmail.com selector=${GMAIL_SELECTOR}`);
  } catch (e) {
    console.warn(`gmail dkim skipped: ${(e as Error)?.message ?? e}(claimer ensureRegistry 兜底)`);
  }

  // 测试 mint
  const mint = await createMint(conn, authority, authority.publicKey, null, 6);
  const ata = await getOrCreateAssociatedTokenAccount(conn, authority, mint, authority.publicKey);
  await mintTo(conn, authority, mint, ata.address, authority, BigInt(MINT_SUPPLY));
  console.log(`test mint: ${mint.toBase58()} supply=${MINT_SUPPLY} decimals=6`);

  console.log("\n--- 粘贴到 app/.dev.vars ---");
  console.log(`RELAYER_X25519_PK_HEX=${Buffer.from(x25519.publicKey).toString("hex")}`);
  console.log(`MINTS_JSON=[{"mint":"${mint.toBase58()}","symbol":"TST","decimals":6}]`);
  console.log("--- devnet-init done ---");
}
main().catch((e) => { console.error("devnet-init FAIL:", e?.message ?? e); process.exit(1); });
