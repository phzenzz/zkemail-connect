// 本地/单进程实现：better-sqlite3 + Drizzle，启动时自动应用迁移。
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { and, eq } from "drizzle-orm";
import { batches, notified } from "./schema";
import { BatchCache, RelayerStore } from "./index";

const MIGRATIONS_DIR = path.resolve(__dirname, "migrations");

/** 打开（不存在则创建）本地 SQLite 存储并应用迁移。 */
export function createSqliteStore(dbPath: string): RelayerStore {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  return {
    async listBatches(): Promise<BatchCache[]> {
      const rows = db.select().from(batches).all();
      return rows.map((r) => ({ batch: r.address, root: r.root, emails: r.emails }));
    },
    async saveBatch(c: BatchCache): Promise<void> {
      db.insert(batches)
        .values({ address: c.batch, root: c.root, emails: c.emails })
        .onConflictDoUpdate({ target: batches.address, set: { root: c.root, emails: c.emails } })
        .run();
    },
    async removeBatch(address: string): Promise<void> {
      db.delete(batches).where(eq(batches.address, address)).run();
    },
    async wasEscrowNotified(escrowAddr: string): Promise<boolean> {
      return !!db.select({ id: notified.id }).from(notified)
        .where(eq(notified.escrowAddr, escrowAddr)).get();
    },
    async wasBatchRecipientNotified(batchAddr: string, leafIndex: number): Promise<boolean> {
      return !!db.select({ id: notified.id }).from(notified)
        .where(and(eq(notified.batchAddr, batchAddr), eq(notified.leafIndex, leafIndex))).get();
    },
    async markEscrowNotified(escrowAddr: string, recipient: string): Promise<void> {
      db.insert(notified)
        .values({ escrowAddr, recipient, notifiedAt: new Date().toISOString() })
        .onConflictDoNothing().run();
    },
    async markBatchRecipientNotified(batchAddr: string, leafIndex: number, recipient: string): Promise<void> {
      db.insert(notified)
        .values({ batchAddr, leafIndex, recipient, notifiedAt: new Date().toISOString() })
        .onConflictDoNothing().run();
    },
    async removeNotifiedForBatch(batchAddr: string): Promise<void> {
      db.delete(notified).where(eq(notified.batchAddr, batchAddr)).run();
    },
    close(): void {
      sqlite.close();
    },
  };
}
