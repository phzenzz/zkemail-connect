// circuits/tests/merkle.test.ts
import { describe, expect, it } from "@jest/globals"; // 仓库无 @types/jest；与同目录其它测试一致从 @jest/globals 导入
import { createHash } from "crypto";
import {
  LEAF_DOMAIN_SEP, PAD_DOMAIN_SEP, leafHash, buildBatchTree, merklePath,
  leafIndexFromPathIndices, verifyBatchPath,
} from "../scripts/merkle";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();
const hex = (b: Buffer) => b.toString("hex");
const leaf = (i: number) => Buffer.alloc(32, i); // 伪 commitment，仅测结构

describe("merkle", () => {
  it("leaf hash domain-separates commitment", () => {
    const c = leaf(42);
    expect(hex(leafHash(c))).toBe(hex(sha256(Buffer.concat([Buffer.from(LEAF_DOMAIN_SEP), c]))));
  });

  it("1-leaf tree: root == leaf, empty path", () => {
    const c = leaf(1);
    const t = buildBatchTree([c]);
    expect(t.depth).toBe(0);
    expect(hex(t.root)).toBe(hex(leafHash(c)));
    const p = merklePath(t, 0);
    expect(p.siblings).toEqual([]);
    expect(verifyBatchPath(t.root, c, p.siblings, p.indices)).toBe(true);
  });

  it("3 leaves pad to depth 2; all paths verify", () => {
    const cs = [leaf(1), leaf(2), leaf(3)];
    const t = buildBatchTree(cs);
    expect(t.depth).toBe(2);
    expect(t.levels[0].length).toBe(4); // 3 真实 + 1 padding
    expect(hex(t.levels[0][3])).toBe(hex(sha256(Buffer.from(PAD_DOMAIN_SEP))));
    for (let i = 0; i < 3; i++) {
      const p = merklePath(t, i);
      expect(verifyBatchPath(t.root, cs[i], p.siblings, p.indices)).toBe(true);
      expect(leafIndexFromPathIndices(p.indices)).toBe(i);
    }
    // 独立重算根
    const l0 = leafHash(cs[0]), l1 = leafHash(cs[1]), l2 = leafHash(cs[2]);
    const pad = sha256(Buffer.from(PAD_DOMAIN_SEP));
    const n0 = sha256(Buffer.concat([l0, l1])), n1 = sha256(Buffer.concat([l2, pad]));
    expect(hex(t.root)).toBe(hex(sha256(Buffer.concat([n0, n1]))));
  });

  it("rejects wrong sibling / wrong commitment", () => {
    const cs = [leaf(1), leaf(2)];
    const t = buildBatchTree(cs);
    const p = merklePath(t, 0);
    expect(verifyBatchPath(t.root, cs[1], p.siblings, p.indices)).toBe(false);
    const bad = p.siblings.slice(); bad[0] = leaf(99);
    expect(verifyBatchPath(t.root, cs[0], bad, p.indices)).toBe(false);
  });

  it("leafIndexFromPathIndices bit order: indices[i] = 第 i 层走右=1", () => {
    expect(leafIndexFromPathIndices([])).toBe(0);
    expect(leafIndexFromPathIndices([1])).toBe(1);
    expect(leafIndexFromPathIndices([0, 1])).toBe(2);
    expect(leafIndexFromPathIndices([1, 0, 1])).toBe(5);
  });
});
