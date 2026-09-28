// 批量空投的链下 Merkle 树工具（node 侧；浏览器版见 app/src/react-app/lib/merkle.ts）。
// 与链上 claim_batch 的校验逻辑同构：叶子/内部节点哈希、padding、路径编码必须逐字节一致。
import { createHash } from "crypto";

export const LEAF_DOMAIN_SEP = "zkemail:batch:v1:leaf";
export const PAD_DOMAIN_SEP = "zkemail:batch:v1:pad";

const sha256 = (b: Buffer): Buffer => createHash("sha256").update(b).digest();

export function leafHash(commitment: Buffer): Buffer {
  return sha256(Buffer.concat([Buffer.from(LEAF_DOMAIN_SEP), commitment]));
}

export interface BatchTree {
  root: Buffer;
  depth: number;
  levels: Buffer[][]; // levels[0] = 叶子层（补零后 2^depth 个）
}

export function buildBatchTree(commitments: Buffer[]): BatchTree {
  if (commitments.length === 0) throw new Error("empty tree");
  let depth = 0;
  while (2 ** depth < commitments.length) depth++;
  const leaves: Buffer[] = commitments.map(leafHash);
  const pad = sha256(Buffer.from(PAD_DOMAIN_SEP));
  while (leaves.length < 2 ** depth) leaves.push(pad);
  const levels: Buffer[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next: Buffer[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(sha256(Buffer.concat([cur[i], cur[i + 1]])));
    levels.push(next);
  }
  return { root: levels[levels.length - 1][0], depth, levels };
}

/** indices[i] = 第 i 层（从叶子往上）走右子 = 1；该比特序列即叶子索引的二进制位。 */
export function merklePath(tree: BatchTree, leafIndex: number): { siblings: Buffer[]; indices: number[] } {
  if (leafIndex < 0 || leafIndex >= tree.levels[0].length) throw new Error("leaf index out of range");
  const siblings: Buffer[] = [];
  const indices: number[] = [];
  let idx = leafIndex;
  for (let lvl = 0; lvl < tree.depth; lvl++) {
    const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
    siblings.push(tree.levels[lvl][sib]);
    indices.push(idx % 2);
    idx = Math.floor(idx / 2);
  }
  return { siblings, indices };
}

export function leafIndexFromPathIndices(indices: number[]): number {
  let idx = 0;
  for (let i = 0; i < indices.length; i++) idx |= (indices[i] & 1) << i;
  return idx;
}

/** 与链上 claim_batch 相同顺序的折叠校验。 */
export function verifyBatchPath(root: Buffer, commitment: Buffer, siblings: Buffer[], indices: number[]): boolean {
  if (siblings.length !== indices.length || siblings.length > 16) return false;
  let cur = leafHash(commitment);
  for (let i = 0; i < siblings.length; i++) {
    cur = indices[i] % 2 === 0 ? sha256(Buffer.concat([cur, siblings[i]])) : sha256(Buffer.concat([siblings[i], cur]));
  }
  return cur.equals(root);
}
