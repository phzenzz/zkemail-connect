// relayer 链上索引器：启动回填存量 escrow/batch → 监听事件 → 过滤本 relayer → 解密 → 哈希校验 → 通知。
// 配置经 IndexerDeps 注入（组合根 relayer/index.ts 调 loadConfig 后传入）；本模块不直接读 env。
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { computeCommitment } from "../circuits/scripts/poseidon";
import { buildBatchTree } from "../circuits/scripts/merkle";
import { openBytes, openEmailCipher, relayerEmailHash } from "./crypto";
import { saveCache, removeCache } from "./batch-store";
import { Notifier } from "./notify";

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

export interface IndexerDeps {
  connection: Connection;
  /** relayer 邮箱（身份过滤：relayer_email_hash == Poseidon(email)） */
  email: string;
  /** x25519 私钥（32B，与链上 relayerEntry.x25519Key 对应） */
  x25519Secret: Buffer;
  /** 通知里的 claim 链接前缀 */
  claimBase: string;
  notifier: Notifier;
}

export async function runIndexer(deps: IndexerDeps): Promise<void> {
  const { connection: conn, notifier } = deps;
  const email = deps.email;
  const secret = deps.x25519Secret;
  if (secret.length !== 32) throw new Error("x25519 secret must be 32 bytes");
  const claimBase = deps.claimBase;

  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
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
    try {
      await notifier.notify(recipient, {
        escrow: escrowAddr.toBase58(),
        sender: sender.toBase58(),
        amount: amount.toString(),
        claimUrl: claimBase + escrowAddr.toBase58(),
      });
      console.log(`[indexer] escrow ${escrowAddr.toBase58()}: notified ${recipient}`);
    } catch (e) {
      console.error(`[indexer] notify ${recipient} failed:`, (e as Error)?.message ?? e);
    }
  }

  // —— 批量空投：BatchCreated/BatchSealed → 解密列表 → 重算 root 比对 → 落缓存 → 逐邮箱通知 ——
  async function processBatch(batchAddr: PublicKey): Promise<void> {
    const acc = await program.account.batch.fetchNullable(batchAddr);
    if (!acc) return;
    if (Buffer.from(acc.relayerEmailHash).compare(ownHash) !== 0) return;
    const opened = openBytes(Buffer.from(acc.recipientsCipher), secret);
    if (!opened) {
      console.error(`[indexer] batch ${batchAddr.toBase58()}: decrypt failed, drop`);
      return;
    }
    let emails: string[];
    try {
      emails = JSON.parse(opened.toString("utf8"));
      if (!Array.isArray(emails) || emails.some((e) => typeof e !== "string")) throw new Error("bad shape");
    } catch {
      console.error(`[indexer] batch ${batchAddr.toBase58()}: bad email list, drop`);
      return;
    }
    const commitments: Buffer[] = [];
    for (const e of emails) commitments.push(fieldToBE(await computeCommitment(e)));
    const tree = buildBatchTree(commitments);
    if (tree.root.compare(Buffer.from(acc.merkleRoot)) !== 0) {
      console.error(`[indexer] batch ${batchAddr.toBase58()}: root mismatch, drop`);
      return;
    }
    saveCache({ batch: batchAddr.toBase58(), root: tree.root.toString("hex"), emails });
    let notified = 0;
    for (const recipient of emails) {
      try {
        await notifier.notify(recipient, {
          escrow: batchAddr.toBase58(),
          sender: (acc.sender as PublicKey).toBase58(),
          amount: acc.amountPerRecipient.toString(),
          claimUrl: claimBase + batchAddr.toBase58(),
        });
        notified++;
      } catch (e) {
        console.error(`[indexer] notify ${recipient} failed:`, (e as Error)?.message ?? e);
      }
    }
    console.log(`[indexer] batch ${batchAddr.toBase58()}: ${notified}/${emails.length} recipient(s) notified`);
  }

  program.addEventListener("batchCreated", async (e: any) => {
    try {
      // 事件触发时 append/seal 可能尚未完成；只处理已 seal 的，seal 完成由 batchSealed 事件兜住
      const info = await conn.getAccountInfo(new PublicKey(e.batch));
      if (!info || info.data[172] !== 1) return; // Batch.sealed @ 字节偏移 172
      await processBatch(e.batch);
    } catch (err) {
      console.error(`[indexer] batch handler error:`, err);
    }
  });

  // create 与 seal 是两条交易：BatchCreated 到达时几乎必然未 seal，
  // 运行期 seal 的批次靠本事件处理（否则要等到重启回填才会通知）。
  program.addEventListener("batchSealed", async (e: any) => {
    try {
      await processBatch(e.batch);
    } catch (err) {
      console.error(`[indexer] batchSealed handler error:`, err);
    }
  });

  // close_batch（领完或过期退款）后批次账户关闭、缓存即失效：
  // 不清理会让过期/关闭批次持续劫持入站邮件（白白走 prover + ALT 租金后才链上被拒）
  program.addEventListener("batchClosed", (e: any) => {
    try {
      removeCache(e.batch.toBase58());
    } catch (err) {
      console.error(`[indexer] batchClosed handler error:`, err);
    }
  });

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
    try {
      await processEscrow(commitment, emailCipher, pubkey, sender, amount);
    } catch (e) {
      console.error(`[indexer] backfill ${pubkey.toBase58()} failed:`, (e as Error)?.message ?? e);
    }
    backfilled++;
  }
  console.log(`[indexer] backfilled ${backfilled} escrow(s)`);

  // 批次回填：sealed @ 172（memcmp）。账户大小 = 182 + ceil(leaf_count/8) + cipher_len_expected，
  // 真实 seal 后 ≥ 258B 且随批次变长，dataSize 精确匹配不可用；非 Batch 账户由
  // fetchNullable 的 discriminator 校验跳过。
  const batchAccounts = await conn.getProgramAccounts(programId, {
    filters: [
      { memcmp: { offset: 172, bytes: anchor.utils.bytes.bs58.encode(Buffer.from([1])) } },
    ],
  });
  for (const { pubkey } of batchAccounts) {
    try {
      await processBatch(pubkey);
    } catch (e) {
      console.error(`[indexer] backfill batch ${pubkey.toBase58()} failed:`, (e as Error)?.message ?? e);
    }
  }
  console.log(`[indexer] backfilled ${batchAccounts.length} batch(es)`);

  console.log(`[indexer] listening on ${conn.rpcEndpoint} ...`);

  // 长驻：事件订阅由 websocket 维持。函数必须保持 pending——若在此返回，
  // supervise 会把它当正常退出反复重启，导致订阅叠加与重复回填。
  await new Promise(() => {});
}

// 独立运行入口（被 index.ts import 时不触发）：组合根本身，调 loadConfig 后运行。
if (require.main === module) {
  import("./config").then(async ({ loadConfig }) => {
    const { Connection } = await import("@solana/web3.js");
    const { ConsoleNotifier, GmailNotifier } = await import("./notify");
    const cfg = loadConfig();
    const notifier = cfg.gmail
      ? new GmailNotifier({ user: cfg.email, auth: cfg.gmail })
      : new ConsoleNotifier();
    await runIndexer({
      connection: new Connection(cfg.rpcUrl, "confirmed"),
      email: cfg.email,
      x25519Secret: cfg.x25519Secret,
      claimBase: cfg.claimBaseUrl,
      notifier,
    });
  }).catch((e) => { console.error("[indexer] FAIL:", e?.message ?? e); process.exit(1); });
}

