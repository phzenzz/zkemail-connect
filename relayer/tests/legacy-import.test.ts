// importLegacyCaches：relayer/data/batches/*.json → store 的一次性导入。
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";
import { createSqliteStore } from "../store/sqlite";
import { importLegacyCaches } from "../batch-store";

function setup(): { storeDir: string; legacyDir: string } {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayer-legacy-"));
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayer-legacyjson-"));
  return { storeDir, legacyDir };
}

test("表空 + JSON 存在 → 导入；重复调用不重复导入", async () => {
  const { storeDir, legacyDir } = setup();
  fs.writeFileSync(path.join(legacyDir, "B1.json"), JSON.stringify({ batch: "B1", root: "aa", emails: ["a@x.com"] }));
  fs.writeFileSync(path.join(legacyDir, "bad.json"), "not json"); // 坏文件跳过不阻断
  const store = createSqliteStore(path.join(storeDir, "t.db"));
  assert.equal(await importLegacyCaches(store, legacyDir), 1);
  assert.equal((await store.listBatches()).length, 1);
  assert.equal(await importLegacyCaches(store, legacyDir), 0); // 表非空，跳过
  store.close();
});

test("目录不存在 → 0", async () => {
  const { storeDir } = setup();
  const store = createSqliteStore(path.join(storeDir, "t.db"));
  assert.equal(await importLegacyCaches(store, "/tmp/no-such-dir-xyz"), 0);
  store.close();
});
