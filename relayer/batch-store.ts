// 批次缓存：relayer 从链上解密重建的派生状态（链上仍是唯一事实源，重启可重建）。
// 目录 relayer/data/batches/<batch>.json（.gitignore 追加 relayer/data/）。
import fs from "fs";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { buildBatchTree, merklePath } from "../circuits/scripts/merkle";
import { computeCommitment } from "../circuits/scripts/poseidon";

export interface BatchCache {
  batch: string;   // base58
  root: string;    // hex
  emails: string[];
}

const DIR = path.resolve(__dirname, "data", "batches");

// Batch.expire_at（i64 LE）的字节偏移，与 state.rs 布局一致：8 disc + 32 sender + 32 mint
// + 32 merkle_root + 32 relayer_email_hash + 8 amount_per_recipient + 8 total_amount
// + 4 leaf_count + 4 claimed_count + 4 cipher_len_expected = 164（sealed @ 172，indexer 同款）。
// nonce(u64) 在 bump 之后、变长 vec 之前，不影响上述偏移（issue #9）。
const BATCH_EXPIRE_AT_OFFSET = 164;

function fieldToBE(v: bigint): Buffer {
  const b = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

async function commitmentsOf(cache: BatchCache): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const email of cache.emails) out.push(fieldToBE(await computeCommitment(email)));
  return out;
}

export function loadCaches(): BatchCache[] {
  if (!fs.existsSync(DIR)) return [];
  const out: BatchCache[] = [];
  for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith(".json"))) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) as BatchCache;
      if (!c || typeof c.batch !== "string" || !Array.isArray(c.emails)) throw new Error("bad shape");
      out.push(c);
    } catch (err) {
      console.warn(`[batch-store] skipping corrupt cache file ${f}:`, (err as Error)?.message ?? err);
    }
  }
  return out;
}

export function saveCache(c: BatchCache): void {
  fs.mkdirSync(DIR, { recursive: true });
  // 原子写：tmp 文件 + rename，避免进程崩溃在 writeFileSync 中途留下截断 JSON
  // （坏文件会让 loadCaches/findLeafByCommitment 对每封邮件抛错，阻断入站处理）
  const target = path.join(DIR, `${c.batch}.json`);
  const tmp = path.join(DIR, `${c.batch}.json.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, target);
}

export function removeCache(batch: string): void {
  const p = path.join(DIR, `${batch}.json`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/** 链上批次是否仍可领取：账户已关闭（领完/过期退款）或超过 expire_at 视为不可领。
 *  布局校验：issue #9 起 Batch 含 nonce(u64)，账户长度须恰好等于新布局公式；旧程序
 *  残留的 legacy 批次短 8 字节，anchor 用新 IDL 解码会 RangeError，一律视为不可领，
 *  findLeafByCommitment 会跳过它继续匹配新批次。 */
export async function batchLive(connection: Connection, batch: string): Promise<boolean> {
  const info = await connection.getAccountInfo(new PublicKey(batch));
  if (!info) return false;
  const d = info.data;
  if (d.length < BATCH_EXPIRE_AT_OFFSET + 8) return false;
  const leafCount = d.readUInt32LE(152);
  const cipherLen = d.readUInt32LE(160);
  const expected = 182 + 4 + Math.ceil(leafCount / 8) + 4 + cipherLen;
  if (d.length !== expected) return false;
  return Number(d.readBigInt64LE(BATCH_EXPIRE_AT_OFFSET)) * 1000 > Date.now();
}

/** 在缓存中按 commitment 找叶子（重建树后比对叶子哈希）。
 *  命中后核链上过期/关闭：过期批次的缓存不得继续劫持入站邮件，跳过该缓存继续找。 */
export async function findLeafByCommitment(
  c32: Buffer, connection: Connection,
): Promise<{ cache: BatchCache; leafIndex: number } | null> {
  for (const cache of loadCaches()) {
    const commitments = await commitmentsOf(cache);
    const tree = buildBatchTree(commitments);
    if (tree.root.toString("hex") !== cache.root) continue; // 缓存损坏，跳过
    for (let i = 0; i < commitments.length; i++) {
      if (!commitments[i].equals(c32)) continue;
      if (!(await batchLive(connection, cache.batch))) continue;
      return { cache, leafIndex: i };
    }
  }
  return null;
}

/** 重建某叶子的 Merkle 路径（claim_batch 参数）；缓存不存在抛错。 */
export async function batchPath(batch: string, leafIndex: number) {
  const cache = loadCaches().find((c) => c.batch === batch);
  if (!cache) throw new Error(`batch cache not found: ${batch}`);
  const tree = buildBatchTree(await commitmentsOf(cache));
  return merklePath(tree, leafIndex);
}
