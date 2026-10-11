// 与 devnet-init.ts 相同的 gmail DKIM upsert 步骤(DNS 空窗期补充执行;正式脚本保持不变)
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { promises as dns } from "dns";
import fs from "fs";
import os from "os";
import path from "path";
import { computePubkeyHash, computeDomainCommitment } from "./circuits/scripts/poseidon";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const GMAIL_SELECTOR = process.env.REGISTRY_SELECTOR_GMAIL ?? "20230601";
const ROOT = path.resolve(__dirname);

function fieldToBE(v: bigint): Buffer {
  const b = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

async function dkimRsaModulus(selector: string, domain: string): Promise<bigint> {
  const txts = await dns.resolveTxt(`${selector}._domainkey.${domain}`);
  const record = txts.map((t) => t.join("")).find((t) => t.includes("p="));
  if (!record) throw new Error(`no DKIM record for ${selector}.${domain}`);
  const pB64 = record.split(";").map((s) => s.trim()).find((s) => s.startsWith("p="))!.slice(2).replace(/\s+/g, "");
  const der = Buffer.from(pB64, "base64");
  if (der[0] !== 0x30) throw new Error("not a DER sequence");
  let off = 2;
  if (der[1] & 0x80) { const n = der[1] & 0x7f; off = 2 + n; }
  if (der[off] !== 0x02) throw new Error("no INTEGER after SEQUENCE");
  const len = der[off + 1];
  let intStart = off + 2;
  let n = Buffer.from(der.subarray(intStart, intStart + len));
  if (n[0] === 0x00) n = n.subarray(1);
  let v = 0n;
  for (const b of n) v = (v << 8n) | BigInt(b);
  return v;
}

async function main() {
  const kpPath = path.join(os.homedir(), ".config/solana/id.json");
  const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8"))));
  const conn = new Connection(RPC, "confirmed");
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "onchain/target/idl/email_wallet.json"), "utf8"));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(authority), { commitment: "confirmed" });
  const program: any = new anchor.Program(idl, provider);
  const programId: PublicKey = program.programId;

  const [registryConfig] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const modulus = await dkimRsaModulus(GMAIL_SELECTOR, "gmail.com");
  const pubkeyHash = fieldToBE(await computePubkeyHash(modulus));
  const domainCommitment = fieldToBE(await computeDomainCommitment("gmail.com"));
  const [dkimReg] = PublicKey.findProgramAddressSync(
    [Buffer.from("dkim"), domainCommitment, Buffer.from(GMAIL_SELECTOR)], programId);
  const sig = await program.methods.registryUpsert(
      Array.from(domainCommitment), GMAIL_SELECTOR, Array.from(pubkeyHash),
      new anchor.BN(Math.floor(Date.now() / 1000) + 90 * 24 * 3600))
    .accounts({ config: registryConfig, registry: dkimReg, authority: authority.publicKey }).rpc();
  console.log(`dkim upserted: gmail.com selector=${GMAIL_SELECTOR} registry=${dkimReg.toBase58()}`);
  console.log("tx:", sig);
}
main().catch((e) => { console.error("dkim-upsert FAIL:", e?.message ?? e); process.exit(1); });
