# 基于 zkEmail 的 Solana 邮箱临时钱包 —— 产品与技术需求文档

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v1.7（在 v1.5 之上：恢复邮件 nullifier——`Poseidon(PoseidonLarge(DKIM 签名))`，claim/sweep 共享、全局 exactly-once；电路 To 地址哈希绑定兑现 relayer 1:1；DKIM 时间窗改链上 `ProtocolConfig.timestamp_window_past` 可配、默认 30 天。v1.5 的"防重放 = 账户关闭 + dest 绑定 + 48h 窗口"被取代，见 §7.2 / §10 修订注记） |
| 状态 | 草案 |
| 目标链 | Solana（主网） |
| 核心技术 | zkEmail（Circom / Groth16 / BN254）、Solana `alt_bn128` syscall |
| 读者 | 产品、电路工程师、链上工程师、后端（Relayer）工程师 |

---

## 1. 背景与目标

### 1.1 背景

向 Web2 用户发送链上资产的最大障碍是：接收方没有钱包、不懂助记词。邮箱是所有人都有的账户体系，且主流邮件服务商（Gmail、Outlook、QQ 邮箱等）发出的邮件天然携带 DKIM 签名，可以作为"邮箱所有权"的密码学证明来源。zkEmail 提供了在零知识电路中验证 DKIM 签名并提取邮件字段的成熟组件。

Solana 自 v1.18 起在主网激活 `alt_bn128` 系列 syscall，原生支持 BN254 配对运算，Groth16 证明可在链上以约 8 万～11 万 CU 完成验证，费用可忽略。业界已有生产先例（OKX 在 Solana 上部署的 zkEmail 智能钱包恢复系统，经 BlockSec 审计）。

### 1.2 产品目标

1. **发送方（Solana 用户/应用）输入一个邮箱地址 + 代币金额，即可向该邮箱"发送"SPL 代币**。接收方无需提前注册、无需有钱包。
2. **接收方收到通知邮件后，在领取网页粘贴收款地址、点击生成的回复按钮（标题自动带上地址），发送邮件即可领取资产，并在同一笔链上交易中原子地转入该地址**。收款地址由 ZK 电路从 DKIM 签名的邮件标题中提取并绑定，Relayer 无法篡改。
3. 邮箱钱包是**临时性的**：只做"接收 + 转出"一次，不维护持久账户、不生成/存储任何用户密钥。
4. 全流程可验证：链上承诺（邮箱哈希）+ ZK 证明 + 领取记录，任何人可审计"资产确实被该邮箱的持有者领走"。

### 1.3 非目标（v1 不做）

- 持久化的邮箱钱包账户体系（zkEmail Email Wallet 那种"一个邮箱对应一个合约账户、可主动发交易"的模式）。注意：**邮箱常驻收款地址（Inbox PDA，见 §4.6）不在此列**——它只收不发，不视为账户体系。
- 接收方通过发邮件主动发起转账（要求用户按格式写邮件，不可行，见 §7）。
- 国际化名邮箱（EAI/UTF8SMTP，如 `用户@例子.中国`）。
- DKIM ed25519 签名算法（RFC 8463）、RSA-1024。
- 批量空投（一对多）。作为 Roadmap 项预留接口。

### 1.4 关键设计决策（与 zkEmail Email Wallet 的差异）

| 决策点 | zkEmail Email Wallet（EVM） | 本方案 |
| --- | --- | --- |
| 账户模型 | 每邮箱一个持久合约账户 | **每笔转账一个临时托管 PDA**，领取后即关闭 |
| 用户动作 | 按固定格式写邮件发命令（"Send 10 USDC to ..."） | **网页粘贴地址 → 一键生成预填邮件（标题=地址）→ 发送；正文任意，可为空** |
| 命令载体 | 邮件 Subject（电路内正则解析） | v1 **无命令载体**：回复 To 固定为系统邮箱 `claim@relay.xyz`，dest 走 Subject（由 mailto 预填，用户无需手输格式） |
| 目标地址传递 | 写在邮件里，电路解析 | **回复邮件 Subject（DKIM 签名字段），电路正则提取并约束进公开输出，Relayer 无法篡改** |

---

## 2. 名词定义

| 术语 | 定义 |
| --- | --- |
| Escrow（托管 PDA） | 链上临时托管账户，即"临时邮箱钱包"的实体，存放待领取代币 |
| Commitment | `Poseidon(email_address)`，邮箱的链上承诺，创建 Escrow 时写入 |
| Relayer | 链下服务：收发邮件、生成 ZK 证明、代交链上交易 |
| Claim Page | 领取网页，接收方在此粘贴收款地址，页面校验后生成"一键发信"按钮（mailto 预填收件人与标题） |
| DKIM Registry | 链上 DKIM 公钥注册表 PDA（按 域名 × selector 存储 RSA 公钥） |
| 系统邮箱 | `claim@relay.xyz`，Relayer 的入站接收地址；v1 所有领取回复都发到这里（v1.4 及之前曾用 plus-address 携带 escrow_id，v1.5 起移除） |
| claim_with_subject | 本方案核心电路模式：dest 由回复邮件的 Subject 携带（DKIM 签名字段），电路正则提取 base58 地址并约束为公开输出 |

---

## 3. 总体架构

```javascript
┌──────────┐   ①创建Escrow+存币    ┌─────────────────────────────┐
│ 发送方 dApp│ ──────────────────▶ │  Solana 程序                 │
│ (网页/SDK) │                      │  - Escrow PDA (临时钱包)      │
└──────────┘                      │  - DKIM Registry PDA        │
     │ 邮箱明文(链下)               │  - Groth16 Verifier         │
     ▼                             └───────▲───────────▲────────┘
┌──────────┐   ②发送通知邮件                │⑥提交claim交易│⑦验证证明+
│ Relayer  │ ─────────────────────────┐   │            │  转账到proof
│ - SMTP收信 │                          │   │            │  绑定的dest
│ - Prover  │ ◀──⑤发信(Subject=地址)─┐ │   │            │
└──────────┘                        │ │   │            │
     ▲                              │ │   │            │
     │④生成证明(DKIM+From+To+Subj)   │ │   │            │
┌────┴─────┐   ③粘地址→生成一键发信   │ │   │            │
│ Claim    │ ──────────────────▶ ┌──┴─┴─┐ │            │
│ Page     │  按钮(mailto预填)     │接收方  │─┘            │
└──────────┘                      │(邮箱)  │──────────────┘
                                  └──────┘
```

### 3.1 组件清单

| 组件 | 形态 | 职责 |
| --- | --- | --- |
| Solana 程序 | Anchor 程序 | Escrow 创建/领取、Inbox 清扫、DKIM Registry、Groth16 验证（`groth16-solana`） |
| Relayer | 链下服务（Node/Rust） | 发通知邮件、收回复（SMTP/Webhook）、调用 Prover、组装提交链上交易 |
| Prover | 链下服务（snarkjs / rapidsnark） | 对回复邮件生成 Groth16 证明 |
| Claim Page | 静态网页 | 收款地址粘贴与校验、生成 mailto 预填按钮（To=claim@relay.xyz、Subject=地址）、领取状态查询 |
| 发送方 dApp | 网页/SDK | 创建 Escrow、存入代币、通知 Relayer 发邮件 |

---

## 4. 核心流程

### 4.1 发送流程（FR-SND）

| 编号 | 需求 |
| --- | --- |
| FR-SND-1 | 发送方连接 Solana 钱包，输入：接收方邮箱、代币 mint、金额。v1 托管一律**不可退款**（无模式选择、无过期时间；可退款模式推迟到 v2，见 §4.4 备注） |
| FR-SND-2 | 前端本地计算 `commitment = Poseidon(lowercase(trim(email)))`，**邮箱明文不上链**，仅链下传给 Relayer |
| FR-SND-3 | 链上创建 Escrow PDA（seeds = `["escrow", commitment, sender]`），写入 `{commitment, sender, mint, amount}`，代币转入 Escrow 自有 ATA。**v1 同一 (邮箱, 发送方) 同时只允许一笔 Open 托管**（seeds 不含 nonce，重复创建直接失败）；前一笔被领取关闭后可再次创建。同一邮箱可同时收取**不同发送方**的多笔托管（v1.4 及之前用 nonce/escrow_id 支持同发送方多笔并存，v1.5 移除） |
| FR-SND-4 | 前端将 `{email, amount, mint, escrow 地址}` 通过 HTTPS API 提交给 Relayer（**注：此处仅为表单提交，发送方全程不接触邮件客户端、不发送任何邮件**）；Relayer 负责通过自身 SMTP 通道向接收方发送通知邮件（模板见 §6.2 与附录 A）。整个系统中邮件协议仅存在于 Relayer ↔ 接收方之间 |
| FR-SND-5 | ~~仅可退款模式：发送方在 Escrow 处于 Open 状态期间可随时调用 `refund` 取消/取回~~ **v1 移除**：发送方没有任何链上撤回手段；refund 能力推迟到 v2（见 §4.4 备注） |

### 4.2 领取流程（FR-CLM）—— 核心："回复即领取，领取即转账"

| 编号 | 需求 |
| --- | --- |
| FR-CLM-1 | 接收方打开通知邮件，点击领取链接 `https://app.xyz/c/<escrow 地址>`，进入 Claim Page |
| FR-CLM-2 | Claim Page 引导接收方**粘贴自己的 Solana 收款地址（dest）**，前端做 base58 格式校验并完整回显要求确认 |
| FR-CLM-3 | 确认后页面生成"一键发信"按钮：`mailto:claim@relay.xyz?subject=<dest>`。用户点击后邮件客户端弹出一封**新邮件**——收件人（系统邮箱 claim@relay.xyz）与标题（= dest）均已自动填好，**正文留空，用户只需点发送**。此为唯一指定的发信方式；若用户改用客户端"回复"按钮（标题为 `Re: 原标题`，不含地址），Relayer 收信后自动回信引导其使用 Claim Page 按钮 |
| FR-CLM-4 | Relayer 收到邮件后：(a) 解析 `Subject` 中的 dest 并定位对应的开放托管（同邮箱可能有多笔来自不同发送方的托管，v1.7 起一封邮件只能领取其中一笔，见 §10）；(b) 提取原始 `.eml`，送入 Prover 生成证明 |
| FR-CLM-5 | 电路证明（见 §7）：DKIM 签名有效 且 `From` 地址的 Poseidon 哈希 == commitment 且 `To` 地址（addr-spec）的 Poseidon 哈希 == `relayerEmailHash`（v1.7 起替换 v1.5 的"To 为系统邮箱"存在性匹配：兑现 relayer 1:1 绑定，链上 claim 时与 escrow 登记的 `relayer_email_hash` 比对，防 proof 跨 relayer 重放）且 `Subject` 恰为一个合法 base58 地址（作为公开输出 dest）且 DKIM `d=` 域名与 `From` 域名对齐 且 DKIM `t=` 在时间窗内 |
| FR-CLM-6 | Relayer 组装**单笔 Solana 交易**调用 `claim` 指令：验证 Groth16 证明 → 链上解码证明公开输出中的 dest → 将 Escrow ATA 中全部代币转入 dest → 关闭 Escrow（租金返还发送方）。**dest 来自电路公开输出，Relayer 无法替换；领取与转账在同一交易内原子完成** |
| FR-CLM-7 | 领取完成后，链上公开记录 `commitment + dest + amount`；应用内展示邮箱（打码或明文，见 §11 隐私策略），任何人可重算哈希验证承诺一致 |

#### 4.2.1 dest 的密码学绑定：为什么用 Subject 而不是正文/表单

三条候选通道的取舍：

| 通道 | 电路可行性 | 用户负担 | 结论 |
| --- | --- | --- | --- |
| 正文（Body） | 差：quoted-printable/base64 编码、多层引用、变长 SHA256 成本爆炸（§6.3） | 低 | ❌ 放弃 |
| 网页表单 | 不进电路，无任何密码学背书，Relayer 可篡改 | 低 | ❌ 放弃（v1.1 曾采用） |
| **标题（Subject）** | **好：DKIM 通常签名字段、定长短文本、Solana 地址为纯 ASCII base58（32–44 字符 < 78 折叠线）** | 由 mailto 预填归零 | ✅ **采用** |

**落地要点**：

- 用户**不需要手动编辑标题**——Claim Page 生成 `mailto:` 链接时把地址写进 `subject=` 参数，邮件客户端自动预填（§FR-CLM-3）。用户感知只有"粘贴地址、点按钮、点发送"。
- 标题内容 = 纯 base58 地址（ASCII），因此**不会触发 RFC 2047 encoded-word 编码**；长度 ≤ 44 < 78，**不会触发折叠**（§6.3 事实一的两个坑在本格式下均不出现，但电路仍按 unfolded/canonicalized 头部处理，见 §7）。
- dest 自此成为电路公开输出：链上程序直接使用证明里的 dest，**Relayer 替换 dest 会导致证明/输入不匹配而验证失败**。SIWS 方案（v1.1 的表单+签名路线）随之废弃。
- 残余信任：Relayer 仍可审查（不发信/不出证明）与看到明文邮箱，缓解不变（开源、多 Relayer、状态页）。

### 4.3 退款流程（FR-RFD）—— **v1 移除，整体推迟到 v2**

| 编号 | 需求 |
| --- | --- |
| FR-RFD-1 | （v2 候选）发送方（且仅发送方）可调用 `refund` 取回全部代币——过期前调用 = 主动取消，过期后调用 = 清理回收 |
| FR-RFD-2 | （v2 候选）`claim` 与 `refund` 互斥：Escrow 状态机 `Open → Claimed / Refunded`，终态关闭账户，先到先生效 |

### 4.4 托管模式：v1 仅不可退款（可退款推迟到 v2）

**v1 决策：只保留单一创建指令 `create_escrow`，语义为不可撤销承诺（对应 v1.3 的 Permanent 模式）：无 expiry、无 refund 代码路径。**

v1.3 曾将创建拆为 `create_escrow`（可退款）/ `create_escrow_permanent`（不可退款）两个指令。v1 为压缩交付面与审计面，先只交付不可退款路径。

> **v2 备注（届时再决策是否恢复）**：恢复方案沿用 v1.3 设计——双指令拆分（可退款指令强制校验 `0 < expiry-now ≤ 30 天`；不可退款指令无 refund 代码路径）、`refund` 仅发送方可调用、`claim`/`refund` 互斥状态机 `Open → Claimed / Refunded`。拆分理由（防 SDK 默认值 footgun、校验互斥、领取路径零分叉）仍然成立，v2 直接采用无需重新设计。

⚠️ 不可退款的资金风险（v1 即存在）：若接收方永不领取，代币与租金将永久锁定在 Escrow/Vault 中。发送方 UI 必须二次确认并明示"无法撤回"。

### 4.5 信任模型说明

dest 已由电路从 DKIM 签名的 Subject 中提取并绑定（§4.2.1），**Relayer 对资金去向无任何裁量权**。残余信任仅剩两点：审查（不发通知邮件/不提交证明——缓解：Relayer 开源、多 Relayer 部署、状态页可查）与可见明文邮箱（Email Wallet 架构固有）。本方案可直接面向公开运营，无需额外的地址签名机制。

### 4.6 邮箱常驻收款地址（Inbox PDA）

| 编号 | 需求 |
| --- | --- |
| FR-INB-1 | 派生 `Inbox PDA`，seeds = `["inbox", commitment]`，作为该邮箱的**公开收款地址**：任何人可像普通地址一样直接向其转入 SPL 代币，无需发送方创建任何链上状态 |
| FR-INB-2 | 邮箱主人走与 §4.2 相同的领取流程（粘贴地址 → 一键发信），`sweep_inbox` 指令将全部代币原子转入证明绑定的 dest；支持一次交易扫描多个 mint（多个 ATA）。**v1.7 起 sweep 与 claim 共享全局邮件 nullifier**（PDA seeds = `["nullifier", email_nullifier]`）：同一封邮件的证明只能用一次，v1.5 的"一证终身扫新增"作废——sweep 之后再进账的余额需再发一封邮件出新的证明 |
| FR-INB-3 | Inbox 不持有任何密钥、不能签名、只收不发（除 sweep）——保持"临时钱包只做转账"的定位，它仅是收款入口 |
| FR-INB-4 | 发送方创建 Escrow 与直接转入 Inbox 两种路径并存：前者适合"指定金额+独立托管账户+领取记录"的定向发放，后者适合开放式收款 |

### 4.7 时序图

```mermaid
sequenceDiagram
    participant S as 发送方
    participant P as Solana程序
    participant R as Relayer
    participant U as 接收方

    S->>P: create_escrow(commitment, amount, nonce)
    P-->>P: 代币转入Escrow ATA
    S->>R: 通知(email明文, escrow地址)
    R->>U: 通知邮件(Reply-To: claim@relay.xyz)
    U->>R: 打开Claim Page, 粘贴收款地址
    U->>U: 点击mailto按钮(客户端预填 To/Subject=地址)
    U->>R: 发送邮件(标题=dest, 正文空)
    R->>R: 生成Groth16证明(DKIM/From/To/Subject→dest)
    R->>P: claim(proof[含dest公开输出])
    P->>P: 验证证明 + 解码dest + 转账dest + 关闭Escrow
    Note over P: 原子完成: 领取=转账到dest; Relayer无法篡改dest
```

---

## 5. 功能需求汇总

| 编号 | 需求 | 优先级 |
| --- | --- | --- |
| FR-1 | 发送方凭邮箱地址创建临时托管并存币 | P0 |
| FR-2 | 接收方"粘贴地址 → 一键发信（标题=地址）"两步领取，dest 电路绑定 | P0 |
| FR-3 | 领取与转账到接收方 EOA 原子完成 | P0 |
| FR-4 | ~~过期退款~~（v1 移除，v2 候选，见 §4.4 备注） | — |
| FR-5 | DKIM 公钥链上注册表（支持多 selector 与轮换） | P0 |
| FR-6 | Relayer 收发邮件、证明生成、交易代付 | P0 |
| FR-7 | Claim Page 多语言（至少中/英） | P1 |
| FR-8 | 领取状态追踪页（对发送方可见：待领取/已领取） | P1 |
| FR-9 | 批量空投模式（一个 Merkle Root 对应 N 个邮箱承诺） | P2 |
| FR-10 | Token-2022 支持 | P2 |
| FR-11 | 邮箱常驻收款地址 Inbox PDA（§4.6）及 `sweep_inbox` 指令 | P1 |
| FR-12 | ~~SIWS 地址绑定~~ 已废弃（v1.2 起 dest 由 Subject 电路绑定，见 §4.2.1） | — |

非功能需求：

| 编号 | 需求 | 指标 |
| --- | --- | --- |
| NFR-1 | claim 交易 CU | < 150,000 CU（证明验证 ~109k + 转账，无签名验证步骤）（v1 实测 173,868 CU，超目标，原因：9 公开输入+SPL CPI+账户关闭；v2 优化项） |
| NFR-2 | 单笔交易大小 | < 1232 B（证明 256 B + 公开输入 9 field = 288 B + 账户，满足） |
| NFR-3 | 证明生成延迟 | Relayer 服务器端 rapidsnark < 30 s |
| NFR-4 | 用户端到端领取时长 | < 2 min（不含邮件投递时间） |
| NFR-5 | 支持的邮箱服务商覆盖率 | 个人邮箱 Top 10（Gmail/Outlook/QQ/163/iCloud/Yahoo/Proton 等）出站 DKIM 全覆盖 |

---

## 6. 邮件协议设计（重点）

### 6.1 设计原则

> **让用户规范地写邮件是不可能的。任何依赖用户输入格式的方案（在 Subject/Body 里写命令、地址、金额）在生产环境都会失败。**

因此本方案的铁律：

1. **机器可读的指令绝不依赖用户手写的格式**。用户对邮件的全部操作 = 点击 Claim Page 生成的 mailto 按钮 + 点"发送"：收件人（系统邮箱）与标题（=收款地址）由链接参数自动预填，正文留空。
2. 机器数据分两处携带，均为 DKIM 签名字段：`To: claim@relay.xyz`（系统邮箱，意图绑定）与 `Subject: <dest 地址>`（收款地址）。Solana 地址为 32–44 字符纯 ASCII base58，不触发折叠与 encoded-word 编码（§6.3）。
3. 电路**只解析 5 个头部字段**：`DKIM-Signature`、`From`、`To`、`Subject`、`Date`。**完全不解析 Body。**

### 6.2 出站邮件（Relayer → 接收方）规范

通知邮件本身不进电路，但仍需工程规范以保证投递率和回复兼容性：

| 字段 | 规范 | 原因 |
| --- | --- | --- |
| `From` | `Token Airdrop <noreply@relay.xyz>` | 展示友好 |
| `Reply-To` | `claim@relay.xyz` | **核心**：回复时自动进入 `To` |
| `Subject` | 纯文本 ≤ 60 字符，单行 | 避免 RFC 5322 折叠（78 字符/行软上限、998 硬上限）与 RFC 2047 encoded-word 编码（非 ASCII 会被编成 `=?UTF-8?B?...?=`）。虽然电路不解析它，但折叠/编码后的 Subject 在部分客户端回复时可能被改写，保持简单最稳 |
| `MIME` | `multipart/alternative`：text/plain + text/html | 兼容性 |
| 正文 | 包含：金额与代币、发送方标识、领取链接、`mailto:` 一键回复按钮、防钓鱼提示（官方域名说明） | 见附录 A 模板 |
| 认证 | 出站必须配置 SPF + DKIM + DMARC | 投递率与防伪造 |
| 其他 | `List-Unsubscribe`、`Message-ID` 规范生成 | 投递率 |

### 6.3 入站邮件（接收方回复）面临的三个事实与对策

#### 事实一：邮件标题长度限制与折叠

- RFC 5322：每行建议 ≤ 78 字符，硬上限 998；超长头部会被**折叠**（CRLF + 空白续行）。
- 非 ASCII 标题会被 RFC 2047 编码为 encoded-word（`=?UTF-8?B?base64?=` / `=?UTF-8?Q?quoted?=`），回复时还会被客户端自动加 `Re:` / `回复:` / `答复:` / `AW:` 等本地化前缀。

**对策：Subject 只承载一种受控格式——纯 base58 地址。**
本方案 v1.2 起电路解析 Subject，但通过 Claim Page 的 mailto 预填把内容锁死为 32–44 字符的 ASCII 地址：

- 长度 ≤ 44 < 78，**天然不触发折叠**；
- 纯 ASCII，**天然不触发 RFC 2047 encoded-word 编码**（客户端只会在含非 ASCII 字符时才编码整个标题）；
- 电路仍在 unfolded 后的头部上匹配，并要求**整行（去首尾空白后）严格等于** `^[1-9A-HJ-NP-Za-km-z]{32,44}$`——带 `Re:` 前缀、encoded-word 或任何多余字符的标题一律拒绝，Relayer 收到此类邮件后自动回信引导用户改用 Claim Page 按钮（FR-CLM-3）。

`To`/`From` 地址头部按 relaxed canonicalization 做 unfold 处理（zk-email-verify 已支持）。

#### 事实二：邮件正文编码格式

- 正文常见 `Content-Transfer-Encoding: quoted-printable` 或 `base64`，且回复邮件通常携带多层引用原文（`> ...`）、HTML 副本，长度不可控（可达数百 KB）。
- 在电路里解码 quoted-printable/base64 极其昂贵；对变长正文做 SHA256 也随长度线性膨胀。

**对策：电路跳过 Body Hash 校验（`ignore_body_hash_check`）。**
DKIM 的 RSA 签名覆盖头部哈希，头部哈希中把 `bh=`（正文哈希值）当作**不透明文本**签进去即可——电路验证 RSA 签名不需要真的重算正文哈希。

安全性论证：跳过正文校验意味着攻击者可以拿着受害者某封真实邮件的头部换上任意正文。但本方案**不从正文取任何信息**（金额、目标地址都不在正文里），所以正文可替换性不构成攻击面。这正是 zk-email-verify 提供该开关的适用场景。附带收益：电路去掉变长 SHA256，约束数大幅下降，证明更快。

#### 事实三：DKIM 签名字段是可变的

- RFC 6376：`h=` 标签列出被签名的头部，**`From` 强制必签**，其余由服务商决定。`To`/`Date` 绝大多数主流服务商会签，但不保证。
- 一封邮件可能有**多个 DKIM-Signature**（如经转发列表）。
- canonicalization 算法有 `simple`/`relaxed` 之分，头部常用 `relaxed`（小写化头部名、压缩空白、展开折叠）。
- `d=`（签名域）不一定等于 `From` 域（如 ESP 代发）。

**对策（全部固化进电路约束）：**

1. 电路解析 `h=` 列表，**强制断言 `h=` 至少包含 `from`、`to`、`subject` 与 `date`**（缺则证明失败，Relayer 提示用户换邮箱或改用兜底流程，见 §6.4；主流服务商均签 `subject`）。
2. 存在多个签名时，电路/Relayer 选取 **`d=` 与 `From` 域名对齐**的那个签名（DMARC 式对齐），防跨域伪造：攻击者可以任意写 `From: victim@gmail.com`，但只有真正经由 Gmail 服务器（以 victim 身份认证）发出的邮件才带 `d=gmail.com` 的有效签名。
3. 电路实现 `relaxed` 与 `simple` 两种头部 canonicalization（zk-email-verify 均支持）。
4. v1 仅支持 RSA-2048/SHA256（`a=rsa-sha256`）；遇到 RSA-1024（旧域名）或 ed25519 DKIM 走人工/兜底流程。

### 6.4 兜底流程（邮件链路失败时）

触发条件：服务商不签 `To`、企业网关改写收件人地址、DKIM 验证失败、回复超时等。

- **Claim Page 直接领取**：通知邮件中带有一次性高熵链接 `https://app.xyz/c/<escrow_id>?k=<128bit_secret>`。持有链接 + 填写收款地址即可领取（不走 ZK）。秘密只在邮件里，链上存 `hash(secret)`。**注意：该路径下任何拿到链接的人都能领取**（无邮箱所有权校验），安全性完全依赖邮件通道机密性——v1 默认关闭，仅在确认邮件链路失败后由运营手动开启，且默认 48 小时后方可使用（优先 ZK 路径）。
- 所有失败案例 Relayer 记录并进入服务商兼容性清单（§12）。

---

## 7. 电路设计（Claim Circuit）

### 7.1 电路职责

证明一个六元组关系：

> "存在一封 DKIM 签名有效的邮件，其 `From` 是某个邮箱 E（Poseidon(E) = commitment），其 `To` 地址的 Poseidon 哈希 == relayerEmailHash（relayer 入站邮箱，链上与 escrow 登记值比对），其 `Subject` 恰为某个合法 base58 地址 D，签名域与 E 的域名对齐，且 DKIM `t=` 在时间窗内" —— 且不泄露 E 本身，但公开 D（dest）、邮件 nullifier 与 relayerEmailHash。

### 7.2 输入输出

**私有输入：**

| 输入 | 说明 |
| --- | --- |
| `header` | 邮件头部字节（ padded 至 `MAX_HEADER_LEN` ） |
| `email_address` | From 地址明文字节（ padded ） |
| `rsa_signature` | DKIM RSA-2048 签名（17 × 121 bit limb 表示） |
| `rsa_pubkey_n` | DKIM 公钥模数 n |
| `header_selector` | 各字段在 header 中的起止位置（电路内断言一致） |

**公开输出（9 个 field，v1.7 起；顺序固定，链上依赖）：**

| 输出 | 说明 |
| --- | --- |
| `pubkey_hash` | `Poseidon(rsa_pubkey_n)`，链上与 DKIM Registry PDA 中存储值比对 |
| `commitment` | `Poseidon(email_address)`，与 Escrow.commitment 比对 |
| `timestamp` | DKIM `t=` 的 Unix 时间，链上校验在窗口内：`now - ProtocolConfig.timestamp_window_past ≤ ts ≤ now + 600s`（窗口默认 30 天、authority 可更新，见 §8.2；防重放主责已移交 nullifier，窗口退居 DKIM revoke 失效边界） |
| `relayer` | Relayer 地址（绑定证明，防止第三方抢跑偷取代领手续费） |
| `dest_a` / `dest_b` | Subject 中的 base58 地址（≤ 44 字符）按字节打包进 2 个 field；**链上负责 bs58 解码为 32 字节公钥**（电路内不做 base58 数学，省约束） |
| `domain_commitment` | `Poseidon(From 域)`，链上 Registry PDA 直接以它为 seed，结构性实现 d= 与 From 域对齐 |
| `emailNullifier` | `Poseidon(PoseidonLarge(rsa_signature))`（C9）：对 DKIM RSA 签名做双重 Poseidon，与 zkEmail 生态 email-nullifier 同构；链上 nullifier PDA 的 seed，一封邮件全局 exactly-once（claim 与 sweep 共享），且不可关联（观察者无法从 nullifier 推知邮箱） |
| `relayerEmailHash` | `Poseidon(To 地址)`（C6'）：链上 claim 与 escrow 登记的 `relayer_email_hash` 比对（RelayerEmailHashMismatch 即拒绝），兑现 relayer 1:1 绑定 |

> v1.5 移除 `escrow_id`（原 C6）与 `nullifier`（原 C9）：不再区分同一(发送方,邮箱)的多笔托管；且去掉 escrow_id 后 nullifier = Poseidon(email) 与 commitment 恒等，失去存在意义。防重放改为 = 账户关闭（同一笔资金不可能被领两次）+ dest 绑定（旧证明"重放"只会付款给同一合法收款人）+ 48h 时间窗。
>
> **v1.7 注记**：nullifier 以 `Poseidon(PoseidonLarge(signature))` 恢复——preimage 是 DKIM 签名而非邮箱，与 commitment 无恒等关系，v1.5 的死结已解。防重放 = **nullifier exactly-once**（claim/sweep 共享全局 nullifier PDA，`init` 语义天然拒绝重复，租金 ~0.001 SOL 由 relayer 代付）+ 账户关闭 + dest 绑定；48h 硬编码窗口改为链上 `ProtocolConfig.timestamp_window_past`（默认 30 天、authority 可更新）。语义变化：**一封回复邮件 = 一次领取**，同邮箱多笔 escrow 需多封回复；v1.5 的"跨托管领取"与"一证终身扫新增"同时作废（见 §10）。

### 7.3 约束清单

| # | 约束 | 组件 |
| --- | --- | --- |
| C1 | RSA-2048 签名验证：`sig^e mod n == PKCS1v15(SHA256(dkim_signed_header_hash))` | zk-email-verify RSA 组件 |
| C2 | 头部 SHA256（定长，relaxed/simple canonicalization） | SHA256 组件 |
| C3 | 跳过 body hash（`bh=` 作为不透明已签文本），见 §6.3 | 配置项 |
| C4 | `h=` 列表 ⊇ {from, to, subject, date}（结构性强制：未签字段不在被哈希头部内，提取必失败） | — |
| C5 | `From` 提取（zk-regex：`<addr>` 或裸地址两种格式）→ 小写化 → `Poseidon == commitment` | from 正则电路 |
| C6'（v1.7 替换 C6） | `To` 提取（ToAddrRegex 捕获 addr-spec）→ `AssertNotUppercase`（原始 To 必须全小写——电路无法改动已签名头）→ `Poseidon == relayerEmailHash` | to_addr 正则电路 |
| C7 | DKIM `d=` 域 == `From` 域（对齐约束，v1.5 起由 Registry PDA 以 `domain_commitment` 为 seed 结构性实现） | 比较器 / Registry seed |
| C8 | DKIM `t=` 解析 → `timestamp` 输出 | date 正则电路 |
| C9（v1.7 恢复） | 邮件 nullifier：`Poseidon(PoseidonLarge(rsa_signature))` == `emailNullifier`（签名 17×121bit limbs 相邻合并为 9 后双重 Poseidon） | email-nullifier 组件（zk-email-verify 同款） |
| C10 | 每个正则电路独立审计（zk-regex 的 DFA 编译是已知形式化风险点） | 审计要求 |
| C11 | `Subject` 提取：unfold 后整行严格匹配 `^[1-9A-HJ-NP-Za-km-z]{32,44}$`（拒绝 `Re:` 前缀、encoded-word、多余字符）；地址字节打包为 `dest_a`/`dest_b` 公开输出 | subject 正则电路 |

### 7.4 关键参数

| 参数 | 值 | 说明 |
| --- | --- | --- |
| 证明系统 | Groth16 / BN254 | Solana 唯一有 syscall 支持的配对曲线（~100 bit 安全，对本场景足够） |
| 证明格式 | snarkjs 标准 | `groth16-solana` 直接兼容 circom/snarkjs 的证明与 vkey |
| `MAX_HEADER_LEN` | 1024 B（实现值；Gmail/QQ canonicalized 头部实测 ~320B） | 覆盖主流服务商头部；超出走兜底 |
| Body | 不进电路 | §6.3 |
| proving key | 电路编译产物，Relayer 持有 | vkey 上链/硬编码于程序 |

---

## 8. 链上程序设计

### 8.1 账户结构

```javascript
Escrow PDA   seeds = ["escrow", commitment, sender]   // v1.5 起：同(邮箱,发送方)同时只一笔 Open
  - commitment:  [u8;32]        // Poseidon(email)
  - sender:      Pubkey
  - mint:        Pubkey
  - amount:      u64
  // v1 无 mode/expiry/status/nullifier/escrow_id 字段：账户存在即 Open，claim 即关闭（租金返还 sender）
  // v2 若恢复可退款模式：重新引入 mode/expiry/status（见 §4.4 备注）

Vault ATA    owner = Escrow PDA, 存放待领代币

Inbox PDA    seeds = ["inbox", commitment]
  - commitment:  [u8;32]
  说明：任何人可直接向其 ATA 转币，无需初始化指令（惰性创建）；v1.7 起 sweep 记录邮件 nullifier（见 FR-INB-2）

Nullifier PDA  seeds = ["nullifier", email_nullifier]   // v1.7：零数据标记账户，存在即"该邮件已用过"
  说明：claim 与 sweep 共享；init 语义天然 exactly-once（重复提交账户已存在即拒绝，
        NullifierAlreadyUsed / AccountInUse 兜底）；租金 ~0.001 SOL 由 relayer（payer）代付

DkimRegistry PDA  seeds = ["dkim", domain_commitment, selector]
  - pubkey_n_hash: [u8;32]      // Poseidon(n)，与电路输出比对
  - status: Active | Revoked
  - updated_at / expires_at
```

### 8.2 指令集

| 指令 | 权限 | 逻辑 |
| --- | --- | --- |
| `create_escrow(commitment, amount)` | 发送方签名 | 建**不可退款** Escrow + Vault，转入代币；同一 (commitment, sender) 已有 Open 托管时创建失败（PDA 已存在）；v1 不存在任何退款代码路径（v2 候选：恢复双指令，见 §4.4 备注） |
| `claim(proof, public_inputs)` | 无需 Escrow 相关方签名（Relayer 代付） | ① Groth16 验证（`groth16-solana`，~105k CU）② `commitment == escrow.commitment`、`pubkey_hash` 在 Registry 中 Active ③ `timestamp` 在窗口内（`ProtocolConfig.timestamp_window_past`，默认 30 天；未来偏移常量 600s）④ 对 `dest_a/dest_b` 做 bs58 解码得到 dest 公钥（解码失败则拒绝）⑤ Vault → dest 全额转账 ⑥ 关闭 Escrow，租金返还 sender ⑦ init nullifier PDA（已存在即拒绝，`NullifierAlreadyUsed`——一封邮件全局只能领一次）⑧ `pi.relayer_email_hash == escrow.relayer_email_hash`（`RelayerEmailHashMismatch`——proof 不可跨 relayer 重放）。**dest 完全来自证明公开输出**。同一笔资金不可能被领两次（账户已关闭 + nullifier 双保险）；同邮箱多笔托管需逐笔回复领取（§10） |
| `sweep_inbox(proof, public_inputs, mints[])` | 无需相关方签名（Relayer 代付） | 与 `claim` 相同的证明校验与 dest 解码，将 Inbox 各 mint ATA 余额原子转入 dest；commitment 由 seeds 中的 Inbox PDA 保证；v1.7 起同样 init nullifier PDA 消费邮件 nullifier（与 claim 共享全局 exactly-once） |
| `registry_upsert(domain, selector, pubkey_n_hash, expires)` | Registry Authority（v1 团队多签） | 新增/轮换公钥 |
| `registry_revoke(domain, selector)` | Registry Authority | 紧急吊销（密钥泄露/服务商弃用） |

### 8.3 安全校验要点

- `claim`/`sweep_inbox` 中 `dest` 由电路公开输出经链上 bs58 解码得到，任何链下参与方无法指定或替换（§4.2.1）。
- 状态机校验（账户存在即 Open，claim 终态关闭）；重放安全性论证见 §10（邮件 nullifier）与 FR-INB-2。
- Registry 仅接受 Authority 更新；前端/Relayer 必须读取链上 Registry 而非自备公钥，保证"电路证明所引用的公钥 = 链上注册公钥"。
- `initialize_registry` 为先到先得（任何首个调用者成为 authority）——公共集群部署时必须与程序部署同一批次完成。

---

## 9. Relayer 设计

| 模块 | 说明 |
| --- | --- |
| 出站 | 交易邮件服务（SES/Mailgun/自建 Postfix），SPF+DKIM+DMARC 齐全，专用域名 `relay.xyz`（与主品牌域名隔离，保护主域信誉） |
| 入站 | SMTP 接收或 Inbound Webhook，解析 `.eml`，按 `From` 邮箱定位其开放托管 |
| DKIM 公钥获取 | 定期从 DNS `<selector>._domainkey.<domain>` 抓取，经 Registry Authority 审核上链；轮换时保留旧钥至 `expires_at` |
| Prover | rapidsnark 服务器集群，目标 < 30 s/证明；队列化 |
| dest 暂存 | `{email → (dest, submitted_at, 来源IP/UA)}`，与邮件证明配对后上链；留存供争议取证 |
| 交易提交 | 代付 gas，失败重试；监控 Escrow 全生命周期 |
| 信任模型 | Relayer **可作恶点**：审查（不发邮件/不提交证明）、看到邮箱明文与邮件内容。**不可作恶点**：替换收款地址（dest 由电路公开输出绑定，篡改即验证失败）、伪造邮箱所有权（DKIM+ZK）、挪用资金（链上状态机）。审查风险用多 Relayer/开源自建缓解 |

---

## 10. 威胁模型与安全分析

| 威胁 | 攻击者 | 缓解 |
| --- | --- | --- |
| 伪造 `From` 冒充接收方回复 | 任何人 | DKIM 签名 + `d=` 与 From 域对齐约束（C7）；攻击者无法让 Gmail 为他签出 From=victim@gmail.com 的邮件 |
| Relayer 替换收款 EOA 截胡 | Relayer | **不成立**：dest 由电路从 DKIM 签名的 Subject 中提取并作为公开输出，Relayer 篡改 dest 会导致证明验证失败（C11） |
| 用户绕过 Claim Page 直接回复（标题为 `Re: ...`） | 接收方误操作 | 电路严格匹配（C11）拒绝 → Relayer 自动回信引导使用一键发信按钮；不构成资金风险（无法出证明即无法领取） |
| 攻击者向系统邮箱发信（标题=自己的地址） | 任何人 | `From` 哈希必须 == commitment（C5）：攻击者的发件邮箱不匹配，证明失败 |
| 重放：同一封回复邮件对同一笔资金重复领取 | 任何人 | 不成立：claim 即关闭 Escrow 账户，第二次提交账户已不存在；v1.7 起再加 nullifier exactly-once 双保险（`NullifierAlreadyUsed`） |
| 一封回复邮件领走同 commitment 的多笔 escrow（v1.5 曾记为"跨托管领取 · 可接受"） | 持有窗口期内有效证明者（含 Relayer） | **不成立**（v1.7 起）：claim 与 sweep 共享全局 nullifier，同一封邮件的证明第二次提交即被链上拒绝，与邮件年龄、时间窗无关。同邮箱多笔托管需逐笔回复、逐笔领取；发送方"每笔支付需一次新鲜回复"的确认语义随之恢复 |
| 同一封邮件重复 sweep（v1.5 语义下可用旧证明继续扫新增） | 任何人 | **不成立**（v1.7 起）：sweep 与 claim 共享同一 nullifier，重复 sweep 被 `NullifierAlreadyUsed` 拒绝；新增余额需新邮件新证明 |
| 用历史邮件伪造新领取（领未来创建的 escrow / 未来 sweep inbox） | 接收方历史邮件泄露 | **不成立**（v1.7 起）：nullifier 使旧邮件的证明永远不可用，与年龄无关；`t=` 窗口（`ProtocolConfig.timestamp_window_past`，默认 30 天）退居纵深防御——配合 DKIM Registry revoke 作为签名失效边界 |
| 正文替换攻击 | 任何人 | 不成立：电路忽略正文，正文不含任何指令（§6.3） |
| DKIM 私钥泄露/轮换 | 外部 | Registry 支持吊销与多 selector；轮换期间新旧并存 |
| 邮箱承诺被字典反查 | 链上观察者 | 邮箱空间低熵，无盐哈希可被已知邮箱批量碰撞。**本场景可接受**：发送方本就需知道邮箱（否则无法发送），链上只存哈希是卫生习惯而非强隐私；需要强隐私的场景（如匿名空投）在 commitment 加盐，salt 链下告知接收方，作为配置项 |
| Claim 链接泄露（邮件被转发/截获） | 邮件路径上的攻击者 | ZK 主路径免疫：转发出去的回复 `From` 不是接收方邮箱，证明无法生成。兜底链接路径（§6.4）下持链接者即可领取，故 v1 默认关闭、人工开启 |
| 证明抢跑（旁人代提交） | 链上观察者 | 无害：资金固定流向证明内绑定的 dest，任何人代提交都改变不了去向；`relayer` 公开输入保护手续费归属 |
| 恶意发送方钓鱼（假空投邮件诱导操作） | 发送方 | 邮件模板固定、官方域名校验提示；Claim Page 明确展示 escrow 金额与来源；永远不索取助记词 |

---

## 11. 隐私设计

- **链上**：仅出现 `commitment`（Poseidon 哈希）、金额、dest。无邮箱明文。
- **Relayer**：可见邮箱明文与邮件内容（Email Wallet 架构的固有权衡——ZK 保护的是"链上"，不是"对 Relayer"）。缓解：Relayer 开源可自建；声明数据保留策略（证明生成后删除 `.eml`）。
- **应用内揭示**（对应业务方需求）：领取完成后，业务方前端可从自己的元数据库展示邮箱（打码 `c***@gmail.com` 或明文），任何人重算 `Poseidon(email)` 与链上 commitment 比对即完成验证——链上哈希负责不可抵赖，应用内展示负责可读性，二者解耦。

---

## 12. 兼容性清单与边界情况

| 情况 | 处理 |
| --- | --- |
| 服务商出站无 DKIM | 极少见；走 §6.4 兜底 |
| `h=` 未签 `To` | 电路拒绝 → 兜底流程；记入兼容性清单 |
| 企业网关改写收件人地址 | 回复 `To` 变化 → 电路拒绝 → 兜底流程 |
| 转发（Fwd）而非回复 | `From` 变为转发者 → 证明失败；邮件中明确提示"请直接回复" |
| 自动回复/假期回复 | Subject 不为合法地址（C11 拒绝）→ Relayer 直接忽略 |
| 多 DKIM 签名（列表转发） | 选取与 From 域对齐者；无对齐者拒绝 |
| 接收方无 Solana 钱包 | Claim Page 提供 Passkey 嵌入式钱包创建选项（Face ID 生成地址后复制粘贴到地址输入框）——P1 |
| 邮件客户端拦截/改写 mailto 参数 | 少数企业客户端剥离 subject 参数 → 用户发出的邮件标题为空 → C11 拒绝 → Relayer 回信引导手动复制地址作为标题（降级路径，此时标题为纯 ASCII 地址，仍可通过电路） |
| 同一邮箱多笔未领空投（不同发送方） | 各 sender 独立 Escrow PDA，互不影响 |
| 同一邮箱多笔未领空投（同一发送方） | v1 同时只允许一笔 Open（seeds 不含 nonce）：需等前一笔被领取关闭后再创建；v1.7 起一封邮件只对应一次领取（nullifier），前一笔领完需再回复一封新邮件才能创建并领取下一笔 |

---

## 13. 里程碑

| 阶段 | 内容 | 周期 |
| --- | --- | --- |
| M1 | 电路开发（基于 zk-email-verify 改造：C1–C10）+ 单元测试 | 3 周 |
| M2 | Solana 程序（Escrow/Registry/claim/sweep_inbox）+ 本地验证器联调 | 3 周 |
| M3 | Relayer（收发邮件、DNS 抓取、Prover 集成）+ Claim Page | 3 周 |
| M4 | 端到端测试（Top 10 邮箱服务商兼容性矩阵）+ 电路与合约审计 | 4 周 |
| M5 | 测试网公测 → 主网灰度（限额） | 2 周 |

审计必查项：zk-regex 全部 DFA 电路（重点：subject 地址提取 C11 的严格整行匹配）、RSA 组件、跳过 body hash 的安全论证、Escrow 状态机、链上 bs58 解码实现、Registry 权限。

---

## 附录 A：通知邮件模板（出站）

**纯文本部分：**

```javascript
Subject: You received 50 USDC — reply to claim

Hi,

<sender_domain_or_name> sent you 50 USDC on Solana.

To claim it:
1. Open your claim page: https://app.xyz/c/7f3k9x2mq1
2. Paste your Solana receiving address.
3. Tap "Send claim email" — your mail app opens with
   everything pre-filled. Just hit send (empty body is fine).

This transfer cannot be revoked once sent. Claim it whenever you're ready.

Security: only trust emails from @relay.xyz. We never ask for your seed phrase.
```

**HTML 部分**：同内容，含两个按钮——「Open claim page」（https 链接）与说明文字（发信按钮在 Claim Page 内生成，因为需要用户先粘贴地址）。

**头部：**

```javascript
From: Token Airdrop <noreply@relay.xyz>
Reply-To: claim+7f3k9x2mq1@relay.xyz
List-Unsubscribe: <https://app.xyz/u/7f3k9x2mq1>
```

> 中文版本 Subject 同样 ≤ 60 字符（会被 RFC 2047 编码，不影响任何电路逻辑，因电路不读 Subject）。

## 附录 B：接收方动作清单（UX 验收标准）

1. 收到邮件 → 点链接（1 次点击）
2. Claim Page 粘贴收款地址 → 确认（1 次粘贴 + 1 次点击）
3. 点「Send claim email」→ 邮件客户端弹出新邮件（收件人/标题已预填）→ 点发送（2 次点击）

**合计 4 次点击 + 1 次地址粘贴，邮件零编辑。** 与"空回复"方案 UX 基本持平，但换来 dest 的电路级绑定：简单不是来自教会用户格式，而是来自 mailto 预填把格式负担转移给了网页。