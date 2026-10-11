// 浏览器版批量 Merkle 工具，与 circuits/scripts/merkle.ts 逐字节同构（WebCrypto sha256）。
// UI 只需 root；领取路径由 relayer 从缓存重建。
export const LEAF_DOMAIN_SEP = "zkemail:batch:v1:leaf";
export const PAD_DOMAIN_SEP = "zkemail:batch:v1:pad";

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

export interface BatchTree {
  root: Uint8Array;
  depth: number;
  levels: Uint8Array[][];
}

export async function buildBatchTree(commitments: Uint8Array[]): Promise<BatchTree> {
  if (commitments.length === 0) throw new Error("empty tree");
  let depth = 0;
  while (2 ** depth < commitments.length) depth++;
  const pad = await sha256(new TextEncoder().encode(PAD_DOMAIN_SEP));
  const leaves: Uint8Array[] = [];
  for (const c of commitments) {
    const sep = new TextEncoder().encode(LEAF_DOMAIN_SEP);
    const buf = new Uint8Array(sep.length + c.length);
    buf.set(sep, 0); buf.set(c, sep.length);
    leaves.push(await sha256(buf));
  }
  while (leaves.length < 2 ** depth) leaves.push(pad);
  const levels: Uint8Array[][] = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next: Uint8Array[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      const buf = new Uint8Array(64);
      buf.set(cur[i], 0); buf.set(cur[i + 1], 32);
      next.push(await sha256(buf));
    }
    levels.push(next);
  }
  return { root: levels[levels.length - 1][0], depth, levels };
}
