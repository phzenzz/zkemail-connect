# Cloudflare Dapp MVP 设计文档

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-09-21 |
| 状态 | 已确认（分节评审通过） |
| 上游文档 | `docs/Solana邮箱临时钱包需求文档.md`（PRD v1.7）、`README.md` |
| 技术底座 | [cloudflare-fullstack-starter](https://github.com/claudio-silva/cloudflare-fullstack-starter) `minimal` 分支 |

## 1. 目标与非目标

**目标**：基于现有 `email-wallet` Solana 程序（ circuits / onchain / prover 已完成），用 Cloudflare starter 的 `minimal` 分支构建 Dapp 前端 + 最简 Hono API，并扩展本地 relayer，打通完整 MVP 闭环：

1. 发送者链接钱包，填写表单（邮箱 / mint / 金额），发送 `create_escrow` 交易上链。
2. relayer 从链上读取 escrow（含 `email_cipher`），解密得到接收者邮箱，用个人 Gmail 发送通知邮件。
3. 接收者打开 claim 页，粘贴收款地址，点击 mailto 按钮回复邮件；relayer 收到回复后**自动**出证明并提交 `claim` 交易完成兑现，资产转入回复标题中的地址。

**非目标（v1 MVP 不做）**：
- 主页 / 营销页（`/` 重定向到 `/send`）。
- 账号体系 / Better Auth / D1 / 任何服务器端存储。
- 批量空投、Inbox PDA sweep 页面、退款、多语言。
- 接收方嵌入式钱包（Passkey）创建。

**已确认的决策**：

| 决策点 | 结论 |
| --- | --- |
| 是否包含 claim 页 | 包含最简 `/claim/:escrow` |
| starter 分支 | `minimal`（无 auth / 无 DB） |
| 链环境 | Solana devnet（部署前探测 `alt_bn128` 可用性，不可用则回退本地 validator） |
| relayer 形态 | 本地 Node 进程（prover 沿用 docker 容器） |
| 交互架构 | 方案 A：前端直连链上 RPC，Hono 仅提供 config/health |
| 部署路径 | 本地测试通过后 `npm run deploy` 到 Cloudflare |

## 2. 总体架构

```javascript
浏览器(React, Cloudflare Pages/Workers, minimal 分支)
  │  ① /send: 连钱包 → 填表单(邮箱/mint/金额)
  │     本地计算 commitment=Poseidon(email) + email_cipher=sealEmailForRelayer(x25519)
  │     钱包签名 create_escrow(commitment, amount, email_cipher, relayer_email_hash) + 协议手续费
  │  ② /claim/:escrow: 从 RPC 读 escrow 账户 → 粘贴地址 → mailto 按钮 → 轮询等待关闭
  ▼
Solana devnet(email-wallet 程序,重新部署 + 一次性初始化)
  │  escrowCreated 事件(email_cipher 上链,邮箱可恢复)
  ▼
Relayer(本地 Node 进程,无 DB)
  indexer.ts(已有,RPC 指向 devnet) → 回填/监听事件 → 解密 email_cipher → 校验 commitment → GmailNotifier
  inbound.ts(新)  → Gmail IMAP 轮询收件箱 → 校验 Subject=base58 地址 → 导出 .eml
  claimer.ts(新)  → load-email → prover(docker) → 组装并提交 claim 交易(自动兑现,失败重试)
  index.ts(新入口) → 并发编排 indexer + inbound/claimer 流水线,graceful shutdown
```

**状态来源（无 DB 的落地方式）**：

| 状态 | 来源 |
| --- | --- |
| 托管是否存在 / 金额 / mint / 接收进度 | 链上 escrow 账户（存在=待领取，关闭=已领取） |
| 接收者邮箱 | 链上 `email_cipher`，relayer 用 x25519 私钥解密并校验 commitment |
| 回复邮件是否已处理 | IMAP `UID` 内存游标（重启后靠链上邮件 nullifier 拒绝重复提交，天然幂等） |
| 防重放 | 链上 nullifier PDA（`NullifierAlreadyUsed`） |
| 配置常量 | Hono `GET /api/config`（programId / rpcUrl / relayEmail / relayX25519Pk / claimBaseUrl） |

## 3. 前端设计（`src/react-app/`）

### 3.1 路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 重定向 → `/send` | 无主页 |
| `/send` | SendPage | 发送页（核心页面） |
| `/claim/:escrow` | ClaimPage | 领取页 |

### 3.2 `/send` — 发送页

1. 连接 Solana 钱包：`@solana/wallet-adapter-react` + `@solana/wallet-adapter-wallets`（仅浏览器插件钱包：Phantom / OKX / Solflare），适配器 UI 自绘（shadcn 按钮 + 下拉）。
2. 表单字段：接收方邮箱、代币 mint（devnet 测试 mint，下拉，默认值来自 config）、金额（带 decimals 换算）。
3. 提交（全部本地完成，邮箱明文不出浏览器）：
   - `commitment = Poseidon(lowercase(trim(email)))`
   - `email_cipher = sealEmailForRelayer(email, relayX25519Pk)`（`tweetnacl` 密封盒，≤64B 明文 → ≤137B 密文）
   - `relayer_email_hash = Poseidon(relayEmail)`（常量，电路 C6' 绑定）
   - 调用 `create_escrow(commitment, amount, email_cipher, relayer_email_hash)` + 协议手续费，钱包弹签。
4. 成功后展示 escrow 地址与 claim 链接（可一键复制），明示"**发送后不可撤回**"（FR-SND 风险提示，发送前二次确认）。
5. 已发送列表：`getProgramAccounts(programId, memcmp(sender=钱包公钥))` 实时读取，展示每笔托管：金额 / mint / 状态（账户存在=待领取，不存在=已领取）。

### 3.3 `/claim/:escrow` — 领取页

1. 按地址参数从 RPC 读 escrow 账户：展示金额、mint；账户不存在（已领取）→ 提示"该托管已关闭/已领取"。
2. 粘贴收款地址 → base58 校验（`^[1-9A-HJ-NP-Za-km-z]{32,44}$`）→ 完整回显要求确认。
3. 生成"一键发信"按钮：`mailto:<relayEmail>?subject=<dest>`，附操作说明（"收件人与标题已自动填好，正文留空，直接点发送"）。
4. 用户发送后，页面每 5s 轮询 escrow 账户，关闭即显示"领取完成"；30s 未关闭提示"relayer 处理中，请稍后刷新查看"。

### 3.4 共享代码抽取

- 将 `circuits/scripts/poseidon.ts` 与 `relayer/crypto.ts` 抽为前后端共用包（如 `shared/` 或 workspace 包），确认无 Node 专属 API；前端依赖 `circomlibjs` + `tweetnacl`。
- 链上IDL / 程序常量：前端经 `@coral-xyz/anchor` 或直接 `@solana/web3.js` + 手排 instruction 调用（MVP 倾向直接 web3.js，避免 anchor Provider 与钱包适配器的耦合，实现时按代码量取舍）。

## 4. Hono API（`src/worker/`，无状态）

| 端点 | 返回 | 说明 |
| --- | --- | --- |
| `GET /api/config` | `{ programId, rpcUrl, relayEmail, relayX25519Pk, claimBaseUrl }` | 前端建交易所需公开常量；随 wrangler 环境变量切换 local/preview/production |
| `GET /api/health` | `{ ok: true }` | 部署后健康检查 |

明确不做：不引入 Better Auth、不建 D1、不读写 cookie/session、不经手邮箱明文。

## 5. Relayer 扩展（`relayer/`，本地 Node 进程）

| 模块 | 文件 | 职责 |
| --- | --- | --- |
| 通知 | `notify.ts` 新增 `GmailNotifier` | Gmail SMTP（465 端口，账号 `penghe1996@gmail.com`，app password 走 `.env` 的 `GMAIL_APP_PASSWORD`）。通知邮件：`From` 该 Gmail、`Reply-To` 同地址（回复即入站收件箱）、正文含金额/mint/claim 链接。模板遵循 PRD §6.2 与附录 A（单行短标题、纯文本+HTML、防钓鱼提示） |
| 入站 | `inbound.ts`（新） | `imapflow` 轮询收件箱；`UID` 内存游标增量拉新；对每封邮件：From 域名须有链上 DKIM registry（否则忽略并日志）；提取 Subject，严格匹配 `^[1-9A-HJ-NP-Za-km-z]{32,44}$`——不匹配则自动回信引导用户使用 claim 页按钮；匹配则导出 `.eml` 到临时目录，交给 claimer |
| 兑现 | `claimer.ts`（新） | 复用 e2e 管线：circuits 的 load-email 解析 → `POST {prover}/prove`（本地 docker 容器）→ 组装 `claim` 交易（relayer 出 gas + nullifier 租金）→ 提交 devnet；失败重试 3 次后放弃并 `console.error` 告警 |
| 索引 | `indexer.ts`（已有，改配置） | `RPC_URL` 指向 devnet；其余逻辑不变（回填 + 事件监听 → 解密 → commitment 校验 → GmailNotifier） |
| 编排 | `index.ts`（新入口） | 并发启动 indexer 与 inbound→claimer 流水线；SIGINT/SIGTERM graceful shutdown |

**邮件与托管的对应**：一封回复邮件按 `From 邮箱 → commitment → 该邮箱的开放 escrow` 定位；同一邮箱存在多笔开放托管时，MVP 领最早一笔；电路 nullifier 保证一封邮件全局只能用一次（重复回复被链上拒绝）。

**密钥边界**：x25519 私钥（`RELAYER_X25519_SECRET_HEX`）、Gmail app password 只存在于本地 relayer 的 `.env`，不上 Cloudflare。

## 6. Devnet 部署与初始化

一次性初始化脚本 `onchain/scripts/devnet-init.ts`（幂等，可重复执行）：

1. `anchor deploy` 到 devnet。**前置探测**：先提交一笔最小 `alt_bn128` 配对交易，失败则回退本地 validator 方案（README 已知本地可用）。
2. `initialize_registry` + `initialize_protocol_config`（首调者即 authority，必须与部署同批完成）。
3. `registry_upsert`：从 DNS 抓 Gmail DKIM 公钥（`selector._domainkey.gmail.com` 的 RSA-2048 模数）。
4. `register_relayer`：`penghe1996@gmail.com` + x25519 公钥 + claim 地址 + 手续费。
5. 铸造 devnet 测试 SPL mint，登记进前端 config。

## 7. 测试与验收

**本地测试（部署 Cloudflare 之前）**：
- 启动：`npm run dev`（starter）+ `npm run relayer`（本地进程）+ prover docker + devnet。
- 端到端主流程：发送页建托管 → Gmail 真实收到通知 → 接收邮箱回复 → relayer 自动 claim → 资产到账 dest，发送页状态翻转为已领取。
- 边界：重复回复同一封邮件（链上 nullifier 拒绝）；Subject 乱写/带 `Re:` 前缀（自动回信引导）；不存在的 escrow 地址访问 claim 页。

**Cloudflare 部署**：
- `npm run deploy:preview` 先行验证，再 `deploy:production`；secrets 只放 RPC URL 等公开/低敏常量。
- 部署后验证：`/api/health`、`/send` 建一笔托管、relayer 日志跑通。

**验收标准**：
1. 发送者：连接钱包 → 填表 → 签名 → 链上出现 escrow，页面显示 claim 链接。
2. 接收者：收到 Gmail 通知 → claim 页粘贴地址 → 点发送 → 无需其他操作，资产到账 dest。
3. 全程 server 零存储；重启 relayer 不丢状态（全部从链上 / Gmail 重建）。

## 8. 风险与备注

| 风险 | 缓解 |
| --- | --- |
| devnet 未激活 `alt_bn128` syscall | 部署前探测，失败回退本地 validator（前端 RPC 配置切换即可） |
| Gmail 个人账号 SMTP/IMAP 限制（每日发送上限 ~500、app password 需 2FA） | MVP 可接受；IMAP 轮询间隔 ≥30s；文档记录限制 |
| DKIM `h=` 未签 Subject / 企业网关改写 | 电路拒绝 → 自动回信引导（PRD §6.4 兜底的 MVP 版：人工介入） |
| 浏览器 poseidon（circomlibjs）性能 | 单次 Poseidon 计算 <1s，可接受 |
