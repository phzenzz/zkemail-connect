// relayer 链上索引器：启动回填存量 escrow → 监听 EscrowCreated → 过滤本 relayer → 解密 → 哈希校验 → 通知。
// 环境变量：RELAYER_EMAIL（发件邮箱，即 relayer 标识）、RELAYER_X25519_SECRET_HEX（32 字节 hex）、
//           RPC_URL（默认 http://127.0.0.1:8899）、CLAIM_BASE_URL（默认 http://localhost:3000/claim/）
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { computeCommitment } from "../circuits/scripts/poseidon";
import { openEmailCipher, relayerEmailHash } from "./crypto";
import { ConsoleNotifier, Notifier } from "./notify";

const ROOT = path.resolve(__dirname, "..");
const IDL_PATH = path.join(ROOT, "onchain/target/idl/email_wallet.json");

// 与链上 state::Escrow 布局一致：8 discriminator + 32 commitment + 32 sender + 32 mint
// + 8 amount + 32 relayer_email_hash + 4 vec len + 137 cipher + 1 bump = 286
const ESCROW_SIZE = 286;
const COMMITMENT_OFFSET = 8; // discriminator 之后
const SENDER_OFFSET = 40; // 8 + 32 commitment
const MINT_OFFSET = 72; // SENDER_OFFSET + 32
const AMOUNT_OFFSET = 104; // MINT_OFFSET + 32
const RELAYER_HASH_OFFSET = 112; // AMOUNT_OFFSET + 8
const CIPHER_LEN_OFFSET = 144; // RELAYER_HASH_OFFSET + 32
const CIPHER_OFFSET = 148; // CIPHER_LEN_OFFSET + 4（vec LE 长度前缀）

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
  const programId: PublicKey = program.programId;

  const ownHash = await relayerEmailHash(email);
  console.log(`[indexer] relayer=${email.toLowerCase()} hash=${ownHash.toString("hex")}`);

  // 事件回调与启动回填共用的处理管线：解密 → Poseidon 校验 → 通知。
  async function processEscrow(
    commitment: Buffer, emailCipher: Buffer, escrowAddr: PublicKey,
    sender: PublicKey, amount: bigint,
  ): Promise<void> {
    const recipient = openEmailCipher(emailCipher, secret);
    if (!recipient) {
      console.error(`[indexer] ${escrowAddr.toBase58()}: decrypt failed, drop`);
      return;
    }
    const expected = fieldToBE(await computeCommitment(recipient));
    if (expected.compare(commitment) !== 0) {
      console.error(`[indexer] ${escrowAddr.toBase58()}: commitment mismatch, drop`);
      return;
    }
    await notifier.notify(recipient, {
      escrow: escrowAddr.toBase58(),
      sender: sender.toBase58(),
      amount: amount.toString(),
      claimUrl: claimBase + escrowAddr.toBase58(),
    });
  }

  // 前向订阅（addEventListener 同步返回，底层 websocket 就绪无信号——就绪语义由下方回填保证）。
  program.addEventListener("escrowCreated", async (e: any) => {
    try {
      if (Buffer.from(e.relayerEmailHash).compare(ownHash) !== 0) return;
      const acc = await program.account.escrow.fetch(e.escrow);
      await processEscrow(
        Buffer.from(e.commitment), Buffer.from(acc.emailCipher), e.escrow,
        acc.sender as PublicKey, BigInt(acc.amount.toString()),
      );
    } catch (err) {
      console.error(`[indexer] ${e.escrow?.toBase58?.() ?? "unknown"}: handler error:`, err);
    }
  });

  // 启动回填：扫描存量 escrow（按 relayer_email_hash 过滤），消除订阅生效前的竞态窗口。
  const accounts = await conn.getProgramAccounts(programId, {
    filters: [
      { dataSize: ESCROW_SIZE },
      { memcmp: { offset: RELAYER_HASH_OFFSET, bytes: anchor.utils.bytes.bs58.encode(ownHash) } },
    ],
  });
  let backfilled = 0;
  for (const { pubkey, account } of accounts) {
    const data = account.data;
    const commitment = Buffer.from(data.subarray(COMMITMENT_OFFSET, SENDER_OFFSET)); // 8..40
    const sender = new PublicKey(data.subarray(SENDER_OFFSET, MINT_OFFSET)); // 40..72
    const amount = data.readBigUInt64LE(AMOUNT_OFFSET); // 72..80
    const cipherLen = data.readUInt32LE(CIPHER_LEN_OFFSET);
    const emailCipher = Buffer.from(data.subarray(CIPHER_OFFSET, CIPHER_OFFSET + cipherLen));
    await processEscrow(commitment, emailCipher, pubkey, sender, amount);
    backfilled++;
  }
  console.log(`[indexer] backfilled ${backfilled} escrow(s)`);

  console.log(`[indexer] listening on ${conn.rpcEndpoint} ...`);
}

main().catch((e) => { console.error("[indexer] FAIL:", e?.message ?? e); process.exit(1); });
