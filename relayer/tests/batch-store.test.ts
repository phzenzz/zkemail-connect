// batch-store 门面：缓存匹配 / merkle 路径重建 / 链上存活核验（connection 打桩）。
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";
import { Keypair } from "@solana/web3.js";
import { createSqliteStore } from "../store/sqlite";
import { batchLive, batchPath, findLeafByCommitment } from "../batch-store";
import { buildBatchTree } from "../../circuits/scripts/merkle";
import { computeCommitment } from "../../circuits/scripts/poseidon";

function fieldToBE(v: bigint): Buffer {
  const b = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

/** 伪造 Batch 账户数据：长度公式与 batchLive 布局一致（见 batch-store.ts 头注释）。 */
function fakeBatchAccount(leafCount: number, cipherLen: number, expireSecFromNow: number): Buffer {
  const d = Buffer.alloc(182 + 4 + Math.ceil(leafCount / 8) + 4 + cipherLen);
  d.writeUInt32LE(leafCount, 152);
  d.writeUInt32LE(cipherLen, 160);
  d.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) + expireSecFromNow), 164);
  return d;
}

const stubConn = (data: Buffer | null) =>
  ({ getAccountInfo: async () => (data ? { data } : null) }) as any;

async function seedBatch(store: any, batch: string, emails: string[]) {
  const commitments: Buffer[] = [];
  for (const e of emails) commitments.push(fieldToBE(await computeCommitment(e)));
  const tree = buildBatchTree(commitments);
  await store.saveBatch({ batch, root: tree.root.toString("hex"), emails });
  return commitments;
}

test("findLeafByCommitment：命中活着的批次并给出 leafIndex", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayer-bs-"));
  const store = createSqliteStore(path.join(dir, "t.db"));
  const b1 = Keypair.generate().publicKey.toBase58();
  const emails = ["a@x.com", "b@x.com"];
  const commitments = await seedBatch(store, b1, emails);
  const conn = stubConn(fakeBatchAccount(2, 10, 3600));
  const hit = await findLeafByCommitment(commitments[1], conn, store);
  assert.equal(hit?.cache.batch, b1);
  assert.equal(hit?.leafIndex, 1);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("findLeafByCommitment：过期批次跳过", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayer-bs-"));
  const store = createSqliteStore(path.join(dir, "t.db"));
  const b1 = Keypair.generate().publicKey.toBase58();
  const emails = ["a@x.com"];
  const commitments = await seedBatch(store, b1, emails);
  const conn = stubConn(fakeBatchAccount(1, 10, -3600)); // 已过期
  assert.equal(await findLeafByCommitment(commitments[0], conn, store), null);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("batchPath：重建路径与直接计算一致", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayer-bs-"));
  const store = createSqliteStore(path.join(dir, "t.db"));
  const b1 = Keypair.generate().publicKey.toBase58();
  const emails = ["a@x.com", "b@x.com", "c@x.com"];
  await seedBatch(store, b1, emails);
  const viaStore = await batchPath(store, b1, 2);
  const commitments: Buffer[] = [];
  for (const e of emails) commitments.push(fieldToBE(await computeCommitment(e)));
  const direct = buildBatchTree(commitments);
  assert.equal(viaStore.siblings.length, direct.depth);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("batchPath：缓存不存在抛错", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayer-bs-"));
  const store = createSqliteStore(path.join(dir, "t.db"));
  await assert.rejects(() => batchPath(store, "NOPE", 0), /batch cache not found/);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
