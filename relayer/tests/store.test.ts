// RelayerStore（better-sqlite3 实现）的持久化语义测试。
// 每个用例独立 tmp 数据库；node:test + tsx，无网络/链依赖。
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";
import { createSqliteStore } from "../store/sqlite";
import { RelayerStore } from "../store";

function tmpStore(): { store: RelayerStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayer-store-test-"));
  const store = createSqliteStore(path.join(dir, "t.db"));
  return { store, dir };
}

test("batches CRUD 与 upsert", async () => {
  const { store, dir } = tmpStore();
  assert.deepEqual(await store.listBatches(), []);
  await store.saveBatch({ batch: "B1", root: "aa", emails: ["a@x.com", "b@x.com"] });
  await store.saveBatch({ batch: "B1", root: "bb", emails: ["a@x.com"] }); // upsert
  await store.saveBatch({ batch: "B2", root: "cc", emails: ["c@x.com"] });
  const all = await store.listBatches();
  assert.equal(all.length, 2);
  const b1 = all.find((c) => c.batch === "B1")!;
  assert.equal(b1.root, "bb");
  assert.deepEqual(b1.emails, ["a@x.com"]);
  await store.removeBatch("B1");
  assert.equal((await store.listBatches()).length, 1);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("notified：escrow 去重 + 重复标记幂等", async () => {
  const { store, dir } = tmpStore();
  assert.equal(await store.wasEscrowNotified("E1"), false);
  await store.markEscrowNotified("E1", "a@x.com");
  await store.markEscrowNotified("E1", "a@x.com"); // 唯一约束，不得抛错
  assert.equal(await store.wasEscrowNotified("E1"), true);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("notified：批次收件人按 (batch, leafIndex) 去重", async () => {
  const { store, dir } = tmpStore();
  await store.markBatchRecipientNotified("B1", 0, "a@x.com");
  await store.markBatchRecipientNotified("B1", 0, "a@x.com");
  await store.markBatchRecipientNotified("B1", 1, "b@x.com");
  assert.equal(await store.wasBatchRecipientNotified("B1", 0), true);
  assert.equal(await store.wasBatchRecipientNotified("B1", 1), true);
  assert.equal(await store.wasBatchRecipientNotified("B1", 2), false);
  assert.equal(await store.wasBatchRecipientNotified("B2", 0), false);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("removeNotifiedForBatch 只清指定批次", async () => {
  const { store, dir } = tmpStore();
  await store.markEscrowNotified("E1", "a@x.com");
  await store.markBatchRecipientNotified("B1", 0, "a@x.com");
  await store.markBatchRecipientNotified("B2", 0, "b@x.com");
  await store.removeNotifiedForBatch("B1");
  assert.equal(await store.wasBatchRecipientNotified("B1", 0), false);
  assert.equal(await store.wasBatchRecipientNotified("B2", 0), true);
  assert.equal(await store.wasEscrowNotified("E1"), true); // escrow 行不受影响
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("跨实例持久化（模拟重启）", async () => {
  const { store, dir } = tmpStore();
  await store.markEscrowNotified("E1", "a@x.com");
  store.close();
  const store2 = createSqliteStore(path.join(dir, "t.db"));
  assert.equal(await store2.wasEscrowNotified("E1"), true);
  store2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
