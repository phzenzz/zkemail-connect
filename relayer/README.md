# relayer

链上索引 → 邮件通知 → 收回复 → 代付 claim 的长驻服务。编排入口 `index.ts`（indexer + inbound + claimer 三任务 supervise）。

## 本地存储（SQLITE_PATH）

派生状态存本地 SQLite（默认 `relayer/data/relayer.db`，已 gitignore；可用 `SQLITE_PATH` 覆盖）：

- `batches` 表：批次空投缓存（merkle root + 收件人列表），供入站匹配与 claim_batch 路径重建。
- `notified` 表：已通知记录——重启回填 / 事件重放不重复发信的唯一依据。语义 at-least-once：先查后发，`notify` 成功后才插入；SMTP 失败不插入，重启自动补发。

schema 与迁移在 `store/`（Drizzle，SQLite 方言）；生产目标 Cloudflare D1，同一套 schema/迁移 SQL，届时新增 D1 driver 实现同一 `RelayerStore` 接口。**DB 只存派生状态，不存任何密钥**（x25519 / Gmail / 钱包私钥仍在 `.env`）。

### 旧 JSON 缓存

老版本批次缓存为 `relayer/data/batches/*.json`。启动时若 `batches` 表为空且该目录存在，自动一次性导入（日志见 `[batch-store] imported N legacy batch cache(s)`）。JSON 文件不删除；表非空即跳过，重复启动安全。确认导入无误后可自行清空该目录。

## 测试

```bash
npm run relayer:test            # relayer 存储/管线（node:test + tsx，无网络/链依赖）
cd circuits && npx jest tests/relayer --runInBand   # relayer 既有 jest 套件（inbound/claimer/config/notify）
```

链上 e2e：`npm run e2e:relayer`（本地 validator + prover 容器，见 `e2e/relayer-claim.ts`）。
