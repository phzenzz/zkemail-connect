// relayer 存储层 schema（Drizzle / SQLite 方言）。
// 生产目标 Cloudflare D1，本地用 better-sqlite3 跑同一套 schema——
// 只用两者 SQL 交集，不用 D1 不支持的 pragma/特性。
import { sqliteTable, text, integer, unique } from "drizzle-orm/sqlite-core";

/** 批次派生缓存（原 relayer/data/batches/*.json 的表化；链上仍是唯一事实源）。 */
export const batches = sqliteTable("batches", {
  address: text("address").primaryKey(), // batch PDA, base58
  root: text("root").notNull(), // merkle root, hex
  emails: text("emails", { mode: "json" }).$type<string[]>().notNull(),
});

/** 已通知记录：重启回填/事件重放的去重依据（at-least-once：notify 成功后才插入）。 */
export const notified = sqliteTable(
  "notified",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    escrowAddr: text("escrow_addr"), // 单发路径；批次路径为 NULL
    batchAddr: text("batch_addr"), // 批次路径；单发为 NULL
    leafIndex: integer("leaf_index"), // 批次内叶子序号（= emails 数组下标）
    recipient: text("recipient").notNull(), // 收件邮箱（观测用）
    notifiedAt: text("notified_at").notNull(), // ISO 8601
  },
  (t) => [
    unique("notified_escrow_uq").on(t.escrowAddr),
    unique("notified_batch_leaf_uq").on(t.batchAddr, t.leafIndex),
  ],
);
