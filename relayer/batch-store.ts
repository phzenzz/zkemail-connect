// 批次缓存：relayer 从链上解密重建的派生状态（链上仍是唯一事实源，重启可重建）。
// 目录 relayer/data/batches/<batch>.json（.gitignore 追加 relayer/data/）。
import fs from "fs";
import path from "path";
import { buildBatchTree, merklePath } from "../circuits/scripts/merkle";
import { computeCommitment } from "../circuits/scripts/poseidon";

export interface BatchCache {
  batch: string;   // base58
  root: string;    // hex
  emails: string[];
}

const DIR = path.resolve(__dirname, "data", "batches");

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
  return fs.readdirSync(DIR).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")) as BatchCache);
}

export function saveCache(c: BatchCache): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `${c.batch}.json`), JSON.stringify(c, null, 2));
}

export function removeCache(batch: string): void {
  const p = path.join(DIR, `${batch}.json`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/** 在缓存中按 commitment 找叶子（重建树后比对叶子哈希）。 */
export async function findLeafByCommitment(c32: Buffer): Promise<{ cache: BatchCache; leafIndex: number } | null> {
  for (const cache of loadCaches()) {
    const commitments = await commitmentsOf(cache);
    const tree = buildBatchTree(commitments);
    if (tree.root.toString("hex") !== cache.root) continue; // 缓存损坏，跳过
    for (let i = 0; i < commitments.length; i++) {
      if (commitments[i].equals(c32)) return { cache, leafIndex: i };
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
