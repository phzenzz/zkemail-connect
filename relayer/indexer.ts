// relayer 链上索引器：监听 EscrowCreated → 过滤本 relayer → 解密 → 哈希校验 → 通知。
// 环境变量：RELAYER_EMAIL（发件邮箱，即 relayer 标识）、RELAYER_X25519_SECRET_HEX（32 字节 hex）、
//           RPC_URL（默认 http://127.0.0.1:8899）、CLAIM_BASE_URL（默认 http://localhost:3000/claim/）
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { computeCommitment } from "../circuits/scripts/poseidon";
import { openEmailCipher, relayerEmailHash } from "./crypto";
import { ConsoleNotifier, Notifier } from "./notify";

const ROOT = path.resolve(__dirname, "..");
const IDL_PATH = path.join(ROOT, "onchain/target/idl/email_wallet.json");

function fieldToBE(v: bigint): Buffer {
  const b = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

async function main() {
  const email = process.env.RELAYER_EMAIL;
  const secretHex = process.env.RELAYER_X25519_SECRET_HEX;
  if (!email || !secretHex) throw new Error("RELAYER_EMAIL / RELAYER_X25519_SECRET_HEX required");
  const secret = Buffer.from(secretHex, "hex");
  if (secret.length !== 32) throw new Error("RELAYER_X25519_SECRET_HEX must be 32 bytes");
  const claimBase = process.env.CLAIM_BASE_URL ?? "http://localhost:3000/claim/";
  const notifier: Notifier = new ConsoleNotifier();

  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  const conn = new Connection(process.env.RPC_URL ?? "http://127.0.0.1:8899", "confirmed");
  const wallet = new anchor.Wallet(Keypair.generate());
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const program: any = new anchor.Program(idl as any, provider);

  const ownHash = await relayerEmailHash(email);
  console.log(`[indexer] relayer=${email.toLowerCase()} hash=${ownHash.toString("hex")}`);

  await program.addEventListener("escrowCreated", async (e: any) => {
    try {
      if (Buffer.from(e.relayerEmailHash).compare(ownHash) !== 0) return;
      const acc = await program.account.escrow.fetch(e.escrow);
      const recipient = openEmailCipher(Buffer.from(acc.emailCipher), secret);
      if (!recipient) {
        console.error(`[indexer] ${e.escrow.toBase58()}: decrypt failed, drop`);
        return;
      }
      const commitment = fieldToBE(await computeCommitment(recipient));
      if (commitment.compare(Buffer.from(e.commitment)) !== 0) {
        console.error(`[indexer] ${e.escrow.toBase58()}: commitment mismatch, drop`);
        return;
      }
      await notifier.notify(recipient, {
        escrow: e.escrow.toBase58(),
        sender: e.sender.toBase58(),
        amount: e.amount.toString(),
        claimUrl: claimBase + e.escrow.toBase58(),
      });
    } catch (err) {
      console.error(`[indexer] ${e.escrow?.toBase58?.() ?? "unknown"}: handler error:`, err);
    }
  });
  console.log(`[indexer] listening on ${conn.rpcEndpoint} ...`);
}

main().catch((e) => { console.error("[indexer] FAIL:", e?.message ?? e); process.exit(1); });
