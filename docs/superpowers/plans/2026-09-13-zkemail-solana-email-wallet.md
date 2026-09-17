# zkEmail Solana 邮箱临时钱包（电路 + 链上程序 + e2e 脚本）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现需求文档 v1.4 的 Claim 电路（zkEmail/Circom）与 Solana Anchor 程序（Escrow 创建/领取、Inbox 清扫、DKIM Registry），并用脚本完成"真实 DKIM 邮件（.eml）→ prover 容器生成 Groth16 证明 → 本地验证器上创建托管并领取"的端到端验证。

**Architecture:** 四层结构，按依赖顺序构建：① `circuits/` —— 基于 `@zk-email/circuits` EmailVerifier（ignoreBodyHashCheck=1，只验头部）+ zk-regex 字段提取（From/To/Subject/Date(t=)），公开输出 9 个 BN254 field；② `onchain/` —— Anchor 0.32.1 程序，用 `groth16-solana 0.2.0`（`alt_bn128` syscall，8-9 个公开输入约 109–113k CU）在 `claim`/`sweep_inbox` 中验证证明并原子转账，dest 由证明公开输出经链上 base58 解码得到；③ `prover/` —— 容器化 rapidsnark 出证服务（Docker，HTTP API：`POST /prove`，内部 witness 用 circom 生成的 wasm 计算器、证明用 rapidsnark 原生二进制），e2e 通过它出证以验证 NFR-3；④ `e2e/` —— TypeScript 脚本，加载人工导出的真实 `.eml` 邮件（DKIM 公钥经 DoH 走真实 DNS，不 mock），经 prover 容器出证明，驱动本地 `solana-test-validator` 全流程。Relayer 与 Claim Page 不在本计划范围（e2e 脚本 + prover 容器覆盖了 Relayer 的证明职责，邮件收发与代付调度不在内）。

**Tech Stack:** Circom 2.1.6 + `@zk-email/circuits@6.3.4` + `@zk-email/helpers@6.4.2` + `@zk-email/zk-regex-circom@2.3.2` + snarkjs + circomlibjs；Anchor 0.32.1（`anchor-lang`/`anchor-spl` 0.32.1，`@coral-xyz/anchor@0.32.1`）+ `groth16-solana@0.2.0` + `five8@0.2`（链上 base58 解码）+ Solana CLI 2.1.x+（本地测试验证器）；TypeScript + ts-mocha。

**Spec:** `Solana邮箱临时钱包需求文档.md`（v1.4，本计划实现其 §4.1/§4.2、§4.6、§7、§8 中除 Relayer/前端/FR-9/FR-10 外的全部内容；§4.3/§4.4 的可退款模式与 refund 已推迟到 v2，本计划不实现）

## Global Constraints

- 目标链 Solana，`alt_bn128` syscall（≥1.18，本地测试验证器默认启用）。
- **版本锁定**：circom 编译器 2.1.6（编译用 `--O1`，**禁止 `--O2`**）；`groth16-solana` 固定 `=0.2.0`（注意其结构体字段拼写为 `vk_gamme_g2`，是 crate 内的 typo，master 已修复但未发布，不要混用 master API）；Anchor 全栈 0.32.1（CLI、`anchor-lang`、`anchor-spl`、`@coral-xyz/anchor` 必须同版本）；Node ≥ 20。
- 电路公开信号**固定 9 个 field**（spec §7.2 写的是 8 个；为在链上实现 C7 的"d= 与 From 域对齐"，增加第 9 个 `domainCommitment`——Registry 直接以 `Poseidon(From 域)` 为 PDA seed，结构性绑定"证明所用公钥属于 From 域"。CU ≈ 113k 仍满足 NFR-1 <150k，交易大小 256+9×32+账户 < 1232 B 满足 NFR-2）。**链上 `public_inputs` 数组顺序必须与电路 main public 列表严格一致**：
  `[pubkeyHash, commitment, escrowId, timestamp, nullifier, relayer, destA, destB, domainCommitment]`
- **字节打包约定（电路 ↔ 链下 TS ↔ 链上 Rust 三处必须一致，用测试向量锁死）**：field 元素打包字节 = **31 字节/field、小端**（`chunk = Σ byte_j · 256^j`，零填充）。链上公开输入是 32 字节**大端**整数，解包时整体逆序后取低 31 字节（最高字节必须为 0），再去尾部零。
- `commitment = Poseidon(11)(emailChunks)`：邮箱 `lowercase(trim(email))` UTF-8 字节零填充到 **341 字节**（=11×31，spec 写 320，取 31 的整数倍以简化电路，超 341 字节的邮箱不支持），分 11 chunk。
- `escrow_id`：16 随机字节，plus-address 中为 **32 个小写 hex 字符**；链上 Escrow 存 `[u8;16]`，PDA seeds 用它（即 spec 中的 `nonce`）；电路 `HexToField` 转 field（大端语义）。Inbox 清扫时 `escrow_id` 为调用方随机选取的一次性值。
- `domainCommitment = Poseidon(4)(domainChunks)`：From 域字节零填充到 **124 字节**（=4×31）。
- `destA/destB`：Subject 中的 base58 地址（32–44 字符）字节，前 31 字节→`destA`，第 32–44 字节（零填充）→`destB`，均 31 字节小端打包；**链上负责拼回、校验字符集、`five8::decode_32` 解码为 32 字节公钥**。
- `timestamp`：取 DKIM-Signature 头的 `t=` 标签（DKIM-Signature 头以 b= 置空形式参与签名哈希，故在电路输入的头部字节内）。**已知弱化**：`t=` 本身不被签名字段覆盖，可被证明者伪造；时间窗仅是纵深防御，真正的防重放 = escrow_id 唯一性 + Escrow 一次性状态机 + nullifier（见 Task 4 安全注记）。链上窗口：`now-48h ≤ timestamp ≤ now+600s`。
- `relayer`：公开信号，电路透传不约束；链上校验 `payer_pubkey mod Fr == relayer`（Fr = BN254 标量域 = `21888242871839275222246405745257275088548364400416034343698204186575808495617`，32 字节 pubkey 最多减 5 次）。
- `nullifier = Poseidon(12)(emailChunks..., escrowIdField)`。
- C4（`h=` 必须签 from/to/subject/date）**不单独做正则**：被提取的字段若未在 `h=` 中则不在被哈希的头部字节内，C5/C6/C11 提取必然失败——结构性强制。t= 代替 Date（上一条）；Gmail 等主流服务商的 `h=` 均覆盖 from/to/subject/date，不满足的服务商在 `loadClaimEmail` / 电路提取阶段即明确失败。
- 证明格式 snarkjs 标准；`pi_a` 必须**在链下取负**（y → q−y，q = `21888242871839275222246405745257275088696311157297823662689037894645226208583`）；G2 点坐标序为 **c1,c0**（`x_im,x_re,y_im,y_re`，各 32 字节大端）——这是 groth16-solana 第一集成坑。
- **v1 仅不可退款托管**：单一 `create_escrow`（无 mode/expiry 参数），无 `refund` 指令；Escrow 账户存在即 Open，claim 即关闭。可退款模式（双指令拆分、expiry ≤30d、refund、Open→Claimed/Refunded 状态机）整体推迟到 v2——恢复设计见 PRD §4.4 备注，v2 直接采用无需重新设计。
- **测试邮件 = 真实 `.eml`**：由人工用真实邮箱（如 Gmail）发出（`To: claim+<32hex>@relay.xyz`、`Subject: <base58 地址>`、正文任意）后导出原文，放入 `circuits/testdata/emails/`（`claim.eml` / `sweep.eml` / `e2e.eml`）。**不 mock DNS**：DKIM 公钥由 `@zk-email/helpers` 经 DoH 从真实 DNS 解析；Registry upsert 的 `pubkeyHash` 由真实公钥计算。**时效约束**：链上时间窗为 `now-48h`，`.eml` 签名时间超过 48 小时后 e2e/链上测试必然失败，需要重新导出邮件（测试代码检测到过期时报错并提示重新导出，不允许跳过）。
- v1 范围外（不做）：Relayer 服务、Claim Page、批量空投（FR-9）、Token-2022（FR-10）、§6.4 兜底链接、加盐 commitment。

## ⚠️ v1.5 Amendment（2026-09-17，用户决策，优先级高于上文 Global Constraints 与各 Task 文本）

**移除 escrow_id。** v1 不再区分同一(发送方,邮箱)的多笔托管；邮件 `To` 固定为系统邮箱 `claim@relay.xyz`（不再用 plus-address 携带 id）。防重放 = 账户关闭（同一笔资金不可能被领两次）+ dest 绑定（旧证明"重放"只会付款给同一合法收款人）+ 48h 时间窗。窗口期内同一邮箱的任一有效证明可领取指向该邮箱的任何开放托管（"跨托管领取"，资金必然流向邮箱主人地址，PRD §10 已记录该语义）。

上文被本条取代的内容：公开信号 9 个的清单（第 17-18 行）、escrow_id 条（第 21 行）、nullifier 条（第 26 行）、防重放描述中的"escrow_id 唯一性 + nullifier"（第 24 行）、测试邮件 To 格式（第 30 行）。各 Task 中所有 `escrowId/escrow_id/escrowIdHex/escrowIdIdx/HexToField 主电路接线/nullifier/NullifierRecord/claim_to_regex（捕获组版）` 相关规格均以本节为准。

具体变更：

1. **公开信号 9 → 7 个**，main public 顺序严格为：
   `[pubkeyHash, commitment, timestamp, relayer, destA, destB, domainCommitment]`
   （链上 `parse_public_inputs` 索引同步：timestamp=2、relayer=3、destA=4、destB=5、domainCommitment=6；`vk_ic.len() = 8`。）
2. **电路**：To 正则从"捕获 32hex"改为 **match-only 存在性断言**：`ToPresenceRegex(msg_bytes)`，模式 `(\r\n|^)to:claim@relay\.xyz(\r\n)`（无捕获组，out===1 即可；用 zk-regex decomposed 全 private 或 raw 模式生成）。删除：escrowId/escrowIdIdx 输入与 HexToField 接线、nullifier 输出（去掉 escrowId 后与 commitment 恒等）、lib/hex.circom 的主电路引用（文件可保留但不接线）。
3. **TS（load-email.ts / poseidon.ts）**：MAX_HEADER_LEN 修正为 **1024**（与编译产物一致，原 2048 是遗留 bug）；移除 escrowIdHex 解析、escrowIdField/escrowId 输入、computeNullifier/escrowIdToField（及对应测试）；To 校验改为必须包含 `claim@relay.xyz`（canonicalized 头部内）。
4. **链上**：Escrow = `{commitment:[u8;32], sender, mint, amount, bump}`（SIZE=8+32+32+32+8+1），seeds = `[b"escrow", commitment, sender]`——同一(邮箱,发送方)同时只一笔 Open（重复创建 init 失败），领取关闭后可再创建。`create_escrow(commitment, amount)`（去掉 escrow_id 参数）。`claim` 删除 escrow_id 与 nullifier 校验。`sweep_inbox` 删除 NullifierRecord（重复 sweep 只会把新增余额继续付给同一 dest，无害；FR-INB-2）。错误码删除 EscrowIdMismatch/NullifierUsed/InboxNullifierConflict。
5. **测试邮件**：To 一律 `claim@relay.xyz`（不再需要 32 位 hex id）；Subject 仍为 base58 地址；导出方式不变（新邮件 + Bcc 自己，收件箱导出原件）。
6. **转换/生成脚本**：`convertProofForSolana` 断言 7 个公开信号；`gen-vk-rust.mjs` 断言 nPub===7、IC 8 个；`prove-for.ts` 参数去掉 escrowIdHex。
7. **Trusted setup**：pot22_final.ptau（Hermez 仪式，Wayback 快照，4.8GB）**复用**——电路变更只需重跑 `groth16 setup` + `zkey export verificationkey` + `gen-vk-rust.mjs`（约 5 分钟），不需重新生成/下载 ptau。

## File Structure

```
circuits/                          # Node 包：电路 + 证明管线
├── package.json                   # @zk-email/* 依赖（Task 1）
├── src/
│   ├── claim.circom               # 主电路 ClaimCircuit（Task 4）
│   ├── lib/pack.circom            # PackBytesLE / PackBytes31xN / AssertNotUppercase（Task 4）
│   ├── lib/hex.circom             # HexToField（Task 4）
│   ├── lib/digits.circom          # Digit2IntStrict（Task 4）
│   └── regexes/                   # zk-regex CLI 生成物（Task 3，生成后入库）
│       ├── claim_to_regex.circom      # To: claim+<32hex>@relay.xyz → 提取 escrow_id
│       └── subject_addr_regex.circom  # Subject 整行严格匹配 base58 地址 → 提取 dest
├── regex-specs/claim_to.json / subject_addr.json   # zk-regex decomposed 输入（Task 3）
├── scripts/
│   ├── load-email.ts              # 真实 .eml 加载：DKIM 验签（真实 DNS）+ 计算全部电路输入（Task 2/5）
│   ├── poseidon.ts                # TS 侧 Poseidon 打包（与电路约定一致）（Task 2）
│   ├── compile.sh                 # circom 编译（Task 4）
│   ├── setup.sh                   # ptau + groth16 setup + contribute + vkey 导出（Task 6）
│   ├── gen-vk-rust.mjs            # verification_key.json → onchain verifying_key.rs（Task 6）
│   └── convert-proof.ts           # proof.json/public.json → 链上字节格式（Task 6）
├── testdata/emails/               # 人工导出的真实邮件原文（claim.eml / sweep.eml / e2e.eml）
└── tests/claim.test.ts            # circom_tester 电路单测（Task 5）

prover/                            # 容器化 rapidsnark 出证服务（Task 13）
├── Dockerfile                     # 编译 rapidsnark + node witness 计算器运行时
├── server.ts                      # HTTP API：GET /health、POST /prove（内部串行队列）
└── README.md                      # 构建/运行/接口说明（Task 13 内创建）

docker-compose.yml                 # prover 服务定义，挂载 circuits/build 产物（Task 13）

onchain/                           # Anchor 工作区（Task 7 `anchor init`）
├── Anchor.toml
├── programs/email-wallet/src/
│   ├── lib.rs                     # #[program] 指令入口（Task 7 起逐 Task 增加）
│   ├── state.rs                   # Escrow / DkimRegistry / RegistryConfig / 枚举（Task 7）
│   ├── errors.rs                  // ErrorCode（Task 7）
│   ├── zk.rs                      // PublicInputs 解析、field 解包、pubkey→field、Groth16 调用（Task 7/11）
│   ├── verifying_key.rs           // 由 gen-vk-rust.mjs 生成的 VERIFYING_KEY const（Task 6）
│   └── instructions/
│       ├── mod.rs
│       ├── registry.rs            // initialize_registry / registry_upsert / registry_revoke（Task 10）
│       ├── create_escrow.rs       // create_escrow（v1 仅不可退款）（Task 8）
│       ├── claim.rs               // claim（Task 11）
│       └── sweep_inbox.rs         // sweep_inbox（Task 12）
└── tests/
    ├── email-wallet.ts            // ts-mocha 全部链上单测
    └── fixtures/                  // admin.json / proof.json / public.json（Task 6 产出）

e2e/
└── e2e.ts                         // 端到端脚本：真实 .eml→prover 容器出证明→本地验证器全流程（Task 14）
```

依赖方向：`circuits/`（Task 1–6）产出 `onchain` 的 `verifying_key.rs`、测试证明 fixtures 与 `prover/` 的运行时产物（`claim.wasm` + `claim_final.zkey`）→ `onchain/`（Task 7–12）与 `prover/`（Task 13）并行 → `e2e/`（Task 14）串联三者。

---

## Task 1: 仓库脚手架与依赖锁定

**Files:**
- Create: `package.json`、`tsconfig.json`、`circuits/package.json`、`.gitignore`
- Test: 无（脚手架任务，验证 = 安装成功 + circom/snarkjs 可用）

**Interfaces:**
- Produces: 后续所有任务依赖的目录结构与锁定版本；`circuits/node_modules` 内含 `@zk-email/circuits`、`@zk-email/helpers`、`@zk-email/zk-regex-circom`、`circomlib`（供 circom `-l node_modules` 引用）。

- [ ] **Step 1: 初始化 git 与根目录**

```bash
cd /Users/hepeng/Documents/dev/project/zkemail-connect
git init 2>/dev/null || true
mkdir -p circuits/src/lib circuits/src/regexes circuits/regex-specs circuits/scripts circuits/tests circuits/build
mkdir -p e2e
```

- [ ] **Step 2: 写根 `package.json` 与 `tsconfig.json`**

`package.json`：

```json
{
  "name": "zkemail-solana-connect",
  "private": true,
  "workspaces": ["circuits"],
  "scripts": {
    "circuit:compile": "bash circuits/scripts/compile.sh",
    "circuit:setup": "bash circuits/scripts/setup.sh",
    "circuit:test": "cd circuits && npx jest tests/claim.test.ts --runInBand",
    "prover:up": "docker compose up -d --build prover",
    "prover:down": "docker compose down",
    "e2e": "npx tsx e2e/e2e.ts"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "@types/node": "^22.0.0"
  }
}
```

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "commonjs", "moduleResolution": "node",
    "esModuleInterop": true, "strict": true, "skipLibCheck": true,
    "resolveJsonModule": true, "outDir": "dist"
  },
  "include": ["circuits/scripts", "circuits/tests", "e2e"]
}
```

`.gitignore`：`node_modules/`、`circuits/build/`、`onchain/target/`、`onchain/test-ledger/`、`onchain/.anchor/`。

- [ ] **Step 3: 写 `circuits/package.json`（版本全部锁定）并安装**

```json
{
  "name": "circuits",
  "private": true,
  "jest": { "preset": "ts-jest", "testEnvironment": "node" },
  "dependencies": {
    "@zk-email/circuits": "6.3.4",
    "@zk-email/helpers": "6.4.2",
    "@zk-email/zk-regex-circom": "2.3.2",
    "circomlib": "2.0.5",
    "circomlibjs": "0.1.7",
    "snarkjs": "^0.7.4",
    "ffjavascript": "^0.3.1",
    "@noble/curves": "^1.6.0"
  },
  "devDependencies": {
    "circom_tester": "^0.0.20",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.0"
  }
}
```

```bash
cd circuits && npm install && cd ..
which circom || cargo install --locked circom --version 2.1.6   # 或按 docs.circom.io 从源码装 2.1.6
circom --version        # 期望 2.1.6
npx snarkjs --version   # 期望 0.7.x
cargo install --path /dev/null 2>/dev/null; which zk-regex || true
# zk-regex CLI: cargo install zk-regex 不可得时，clone zkemail/zk-regex@v2.3.2 后
#   cargo install --path packages/compiler   （二进制名 zk-regex）
```

- [ ] **Step 4: 验证 circom 能引用 npm 包里的电路**

```bash
cd circuits
echo 'pragma circom 2.1.6;
include "@zk-email/circuits/email-verifier.circom";
component main = EmailVerifier(1024, 0, 121, 17, 1, 0, 0, 0);' > /tmp/smoke.circom
circom -l node_modules /tmp/smoke.circom --r1cs --O1 -o /tmp
# 期望：编译成功（无 "Not found" 错误）
```

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json .gitignore circuits/package.json circuits/package-lock.json
git commit -m "chore: scaffold repo, pin zk-email/circom dependencies"
```

---

## Task 2: 真实邮件加载器与 Poseidon 打包（TS 侧）

**Files:**
- Create: `circuits/scripts/poseidon.ts`
- Create: `circuits/scripts/load-email.ts`
- Create: `circuits/testdata/emails/README.md`（导出指引；`.eml` 文件由人工提供，不入库大文件也在此说明命名）
- Test: `circuits/tests/poseidon.test.ts`

**Interfaces:**
- Produces（Task 5、6、11、12、14 依赖）：
  - `packBytesLE(bytes: Uint8Array, totalLen: number): bigint[]` — 31 字节/块小端零填充打包。
  - `poseidonHash(inputs: bigint[]): Promise<bigint>`。
  - `computeCommitment(email: string): Promise<bigint>`（= `poseidonHash(packBytesLE(emailBytes, 341))`）。
  - `computeDomainCommitment(domain: string): Promise<bigint>`（totalLen=124）。
  - `computeNullifier(email: string, escrowIdField: bigint): Promise<bigint>`。
  - `computePubkeyHash(rsaModulus: bigint): Promise<bigint>` — PoseidonLarge(121,17)：模数按 121 bit 小端拆 17 limb，相邻两两合并 `in[2i] + 2^121·in[2i+1]` 成 9 个输入后 `Poseidon(9)`。
  - `escrowIdToField(id: Uint8Array /*16B*/): bigint`（大端语义）。
  - `relayerToField(pubkeyBytes32: Uint8Array): bigint`（大端整数 mod Fr）。
  - `loadClaimEmail(emlPath: string, relayerField: bigint): Promise<LoadedEmail>` — 读取真实 `.eml`，用 `@zk-email/helpers` 走**真实 DNS**（DoH）验 DKIM，解析 `To`/`Subject`/`From`/`t=`/`d=`/`s=`，计算全部电路输入与公开信号。返回：
    ```ts
    interface LoadedEmail {
      rawEmail: Buffer;
      inputs: Record<string, unknown>;   // 完整电路输入（含 index 见证与 9 个公开信号）
      meta: {
        fromEmail: string;               // From 地址（小写）
        domain: string;                  // From 域；已断言 == DKIM d=（对齐，C7）
        selector: string;                // DKIM s=（Registry upsert 用）
        escrowIdHex: string;             // 从 To 的 plus-address 解析，32 位小写 hex
        destBase58: string;              // 从 Subject 解析（整行严格匹配）
        timestamp: number;               // DKIM t=
        commitment: string; escrowIdField: string; nullifier: string;
        pubkeyHash: string; domainCommitment: string; destA: string; destB: string;
      };
    }
    ```
    失败即抛错（DKIM 无效 / d= 与 From 域不对齐 / 缺 `t=` / To 或 Subject 格式不符 / 邮件超过 48h 时间窗），不允许静默降级。

- [ ] **Step 1: 写失败的打包/哈希测试**

`circuits/tests/poseidon.test.ts`：

```ts
import { packBytesLE, computeCommitment, computeDomainCommitment, computeNullifier, escrowIdToField, relayerToField } from "../scripts/poseidon";

test("packBytesLE: 31 bytes per chunk, little-endian, zero pad", () => {
  const chunks = packBytesLE(new Uint8Array([1, 2, 3]), 62); // 2 chunks
  expect(chunks.length).toBe(2);
  expect(chunks[0]).toBe(1n + 2n * 256n + 3n * 65536n);
  expect(chunks[1]).toBe(0n);
});

test("escrowIdToField: big-endian", () => {
  const id = new Uint8Array(16); id[15] = 0x2a;
  expect(escrowIdToField(id)).toBe(42n);
});

test("relayerToField: pubkey mod Fr", () => {
  const FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const pk = new Uint8Array(32); pk[31] = 0xff;
  expect(relayerToField(pk)).toBe(255n % FR);
});

test("computeCommitment: deterministic + case-insensitive + trim", async () => {
  const a = await computeCommitment("Alice@Test.com");
  const b = await computeCommitment("  alice@test.com ");
  expect(a).toBe(b);
});

test("computeNullifier / computeDomainCommitment: stable shape", async () => {
  const n = await computeNullifier("alice@test.com", 42n);
  const d = await computeDomainCommitment("test.com");
  expect(typeof n).toBe("bigint");
  expect(d).toBeGreaterThan(0n);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd circuits && npx jest tests/poseidon.test.ts
# 期望：FAIL（模块不存在）
```

- [ ] **Step 3: 实现 `circuits/scripts/poseidon.ts`**

```ts
import { buildPoseidon } from "circomlibjs";

const FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const EMAIL_PADDED_LEN = 341;   // 11 * 31
export const DOMAIN_PADDED_LEN = 124;  // 4 * 31

let poseidonPromise: Promise<any> | null = null;
async function getPoseidon() {
  if (!poseidonPromise) poseidonPromise = buildPoseidon();
  return poseidonPromise;
}

export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const p = await getPoseidon();
  return BigInt(p.F.toString(p(inputs)));
}

/** 31 bytes per chunk, little-endian within chunk, zero-padded to totalLen. */
export function packBytesLE(bytes: Uint8Array, totalLen: number): bigint[] {
  if (bytes.length > totalLen) throw new Error("input too long");
  const nChunks = Math.ceil(totalLen / 31);
  const chunks: bigint[] = [];
  for (let c = 0; c < nChunks; c++) {
    let v = 0n;
    for (let j = 30; j >= 0; j--) {
      const idx = c * 31 + j;
      v = (v << 8n) | (idx < bytes.length ? BigInt(bytes[idx]) : 0n);
    }
    chunks.push(v);
  }
  return chunks;
}

export async function computeCommitment(email: string): Promise<bigint> {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  return poseidonHash(packBytesLE(bytes, EMAIL_PADDED_LEN));
}

export async function computeDomainCommitment(domain: string): Promise<bigint> {
  const bytes = new TextEncoder().encode(domain.trim().toLowerCase());
  return poseidonHash(packBytesLE(bytes, DOMAIN_PADDED_LEN));
}

export async function computeNullifier(email: string, escrowIdField: bigint): Promise<bigint> {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  return poseidonHash([...packBytesLE(bytes, EMAIL_PADDED_LEN), escrowIdField]);
}

/** PoseidonLarge(121,17): RSA modulus n split into 17 limbs of 121 bits (LE), merged pairwise. */
export async function computePubkeyHash(modulus: bigint): Promise<bigint> {
  const limbs: bigint[] = [];
  let rem = modulus;
  const mask = (1n << 121n) - 1n;
  for (let i = 0; i < 17; i++) { limbs.push(rem & mask); rem >>= 121n; }
  const merged: bigint[] = [];
  for (let i = 0; i < 9; i++) merged.push(limbs[2 * i] + (limbs[2 * i + 1] << 121n));
  return poseidonHash(merged);
}

export function escrowIdToField(id: Uint8Array): bigint {
  if (id.length !== 16) throw new Error("escrow id must be 16 bytes");
  let v = 0n;
  for (const b of id) v = (v << 8n) | BigInt(b); // big-endian
  return v;
}

export function relayerToField(pubkeyBytes32: Uint8Array): bigint {
  let v = 0n;
  for (const b of pubkeyBytes32) v = (v << 8n) | BigInt(b); // big-endian
  return v % FR;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd circuits && npx jest tests/poseidon.test.ts
# 期望：PASS 5/5
```

- [ ] **Step 5: 准备真实测试邮件 + 实现 `circuits/scripts/load-email.ts`**

**测试邮件怎么来（人工一次性操作）**：用真实邮箱（Gmail 即可）**发送**一封新邮件（不是回复）：

- 收件人：`claim+<32 位小写 hex>@relay.xyz`（如 `claim+0123456789abcdef0123456789abcdef@relay.xyz`；地址不存在没关系，Gmail 出站服务器照常 DKIM 签名，之后从"已发送"里导出）
- 标题：一个合法 Solana base58 地址（如 `4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM`），**不加任何多余字符**
- 正文：任意（可为空）

然后在 Gmail「显示原始邮件」→ 下载为 `.eml`，放入 `circuits/testdata/emails/`：`claim.eml`（claim 测试）、`sweep.eml`（Inbox 清扫，用**另一个** 32hex id）、`e2e.eml`（端到端，再用一个 id）。三封可以同一次发。注意 **48 小时时效**（链上时间窗）：过期后 e2e 会明确报错提示重新导出。`circuits/testdata/emails/README.md` 里写清上述步骤与命名约定。

**load-email.ts**：不拦截任何网络请求，DKIM 公钥由 `@zk-email/helpers` 经 DoH 从真实 DNS 解析。

```ts
import fs from "fs";
import {
  generateEmailVerifierInputsFromDKIMResult,
  verifyDKIMSignature,
} from "@zk-email/helpers";
import {
  computeCommitment, computeDomainCommitment, computeNullifier,
  computePubkeyHash, escrowIdToField,
} from "./poseidon";

export const MAX_HEADER_LEN = 2048;
export const MAX_DEST_LEN = 44;
const FRESHNESS_SECS = 48 * 3600; // 与链上 TIMESTAMP_WINDOW_PAST 对齐

export interface LoadedEmail {
  rawEmail: Buffer;
  inputs: Record<string, unknown>;
  meta: {
    fromEmail: string; domain: string; selector: string;
    escrowIdHex: string; destBase58: string; timestamp: number;
    commitment: string; escrowIdField: string; nullifier: string;
    pubkeyHash: string; domainCommitment: string; destA: string; destB: string;
  };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** Find byte offset of `needle` in canonicalized headers; throws if absent. */
function indexOfHeader(headers: Buffer, needle: string): number {
  const idx = headers.indexOf(needle);
  if (idx < 0) throw new Error(`header substring not found: ${JSON.stringify(needle)}\n${headers.toString()}`);
  return idx;
}

export async function loadClaimEmail(emlPath: string, relayerField: bigint): Promise<LoadedEmail> {
  const rawEmail = fs.readFileSync(emlPath);

  // 1. DKIM verify via REAL DNS (DoH). skipBodyHash=true matches the circuit config.
  const dkimResult = await verifyDKIMSignature(rawEmail, "", true, false, true);
  const headers = dkimResult.headers; // canonicalized signed header bytes
  const headerStr = headers.toString("utf8");

  // 2. Parse fields from the canonicalized headers (relaxed: lowercase names,
  //    unfolded, single spaces; values had leading/trailing WSP stripped).
  const fromMatch = headerStr.match(/(?:^|\r\n)from:[^\r\n]*?([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})/i);
  if (!fromMatch) throw new Error("cannot parse From address");
  const fromEmail = fromMatch[1].toLowerCase();
  const fromDomain = fromEmail.split("@")[1];

  const toMatch = headerStr.match(/(?:^|\r\n)to:[^\r\n]*?claim\+([0-9a-f]{32})@relay\.xyz/i);
  if (!toMatch) throw new Error("To does not carry claim+<32hex>@relay.xyz");
  const escrowIdHex = toMatch[1];

  const subjectMatch = headerStr.match(/(?:^|\r\n)subject:([1-9A-HJ-NP-Za-km-z]{32,44})(?=\r\n)/);
  if (!subjectMatch) {
    throw new Error("Subject is not a bare base58 address (Re:/extra chars/encoding?) — resend via the claim-page format");
  }
  const destBase58 = subjectMatch[1];

  const tMatch = headerStr.match(/(?:^|\r\n)dkim-signature:[^\r\n]*?(\bt=([0-9]+))/);
  if (!tMatch) throw new Error("DKIM-Signature has no t= tag — provider unsupported in v1");
  const timestamp = Number(tMatch[2]);

  // 3. Alignment + freshness guards (mirror on-chain/circuit checks, fail fast off-chain)
  if (dkimResult.signingDomain !== fromDomain) {
    throw new Error(`d=${dkimResult.signingDomain} does not align with From domain ${fromDomain}`);
  }
  const age = Math.floor(Date.now() / 1000) - timestamp;
  if (age > FRESHNESS_SECS) {
    throw new Error(`.eml is ${Math.round(age / 3600)}h old (>48h window) — re-export a fresh email (see testdata/emails/README.md)`);
  }

  // 4. Base circuit inputs (header-only)
  const baseInputs = await generateEmailVerifierInputsFromDKIMResult(dkimResult, {
    ignoreBodyHashCheck: true,
    maxHeadersLength: MAX_HEADER_LEN,
  });

  // 5. Reveal start indices on the canonicalized header buffer
  const fromIdx = indexOfHeader(headers, fromEmail);
  const escrowIdx = indexOfHeader(headers, escrowIdHex);
  const subjectIdx = indexOfHeader(headers, destBase58);
  const tsIdx = indexOfHeader(headers, `t=${timestamp}`) + 2;
  const atPos = fromEmail.indexOf("@");

  // 6. Public signals
  const commitment = await computeCommitment(fromEmail);
  const domainCommitment = await computeDomainCommitment(fromDomain);
  const escrowIdField = escrowIdToField(hexToBytes(escrowIdHex));
  const nullifier = await computeNullifier(fromEmail, escrowIdField);
  const pubkeyHash = await computePubkeyHash(dkimResult.publicKey);

  const destBytes = new TextEncoder().encode(destBase58);
  const chunkLE = (b: Uint8Array) => {
    let v = 0n;
    for (let j = b.length - 1; j >= 0; j--) v = (v << 8n) | BigInt(b[j]);
    return v;
  };
  const destA = chunkLE(destBytes.subarray(0, 31));
  const destB = chunkLE(destBytes.subarray(31, MAX_DEST_LEN));

  const inputs: Record<string, unknown> = {
    ...baseInputs,
    fromAddrIdx: String(fromIdx),
    escrowIdIdx: String(escrowIdx),
    subjectAddrIdx: String(subjectIdx),
    timestampIdx: String(tsIdx),
    domainIdx: String(atPos + 1),
    pubkeyHash: pubkeyHash.toString(),
    commitment: commitment.toString(),
    escrowId: escrowIdField.toString(),
    timestamp: String(timestamp),
    nullifier: nullifier.toString(),
    relayer: relayerField.toString(),
    destA: destA.toString(),
    destB: destB.toString(),
    domainCommitment: domainCommitment.toString(),
  };

  return {
    rawEmail, inputs,
    meta: {
      fromEmail, domain: fromDomain, selector: dkimResult.selector,
      escrowIdHex, destBase58, timestamp,
      commitment: commitment.toString(), escrowIdField: escrowIdField.toString(),
      nullifier: nullifier.toString(), pubkeyHash: pubkeyHash.toString(),
      domainCommitment: domainCommitment.toString(),
      destA: destA.toString(), destB: destB.toString(),
    },
  };
}
```

> 真实邮件注意点（踩坑记录写进 testdata README）：Gmail 的 DKIM `h=` 必含 `from:to:subject:date`，满足电路要求；`d=gmail.com` 与 From 域对齐；t= 存在。若换其他服务商导致解析/对齐失败，`loadClaimEmail` 会给出具体原因的报错——这正是 spec §12 兼容性清单要收集的信息。

- [ ] **Step 6: 用真实邮件验证加载器**

前置：`circuits/testdata/emails/claim.eml` 已按 Step 5 指引导出。

```bash
cd circuits && npx tsx -e "
import('./scripts/load-email.ts').then(async (m) => {
  const r = await m.loadClaimEmail('testdata/emails/claim.eml', 123n);
  console.log('OK', { from: r.meta.fromEmail, selector: r.meta.selector,
    escrowId: r.meta.escrowIdHex, dest: r.meta.destBase58, ts: r.meta.timestamp });
});"
# 期望：打印 OK 与解析出的字段；DKIM 验签走真实 DNS（需要外网）
```

- [ ] **Step 7: Commit**

```bash
git add circuits/scripts/poseidon.ts circuits/scripts/load-email.ts \
        circuits/tests/poseidon.test.ts circuits/testdata
git commit -m "feat(circuits): poseidon packing helpers + real .eml loader (real DNS DKIM verify)"
```

---

## Task 3: 自定义 zk-regex 电路（To / Subject）

**Files:**
- Create: `circuits/regex-specs/claim_to.json`、`circuits/regex-specs/subject_addr.json`
- Create（CLI 生成）: `circuits/src/regexes/claim_to_regex.circom`、`circuits/src/regexes/subject_addr_regex.circom`
- Test: `circuits/tests/regexes.test.ts`

**Interfaces:**
- Produces（Task 4 的 claim.circom 引用）：两个模板，信号形状与 `@zk-email/zk-regex-circom` 生成的所有电路一致：
  - `ClaimToRegex(msg_bytes)`：`signal input msg[msg_bytes]` → `signal output out` + `signal output reveal0[msg_bytes]`（reveal0 = 仅 32 个 hex 字符位置非零的字节数组）。
  - `SubjectAddrRegex(msg_bytes)`：同上，reveal0 = 仅 base58 地址位置非零。

- [ ] **Step 1: 写 decomposed regex 规格**

`circuits/regex-specs/claim_to.json`（注意 relaxed canonicalization 后头部名为小写、值前导空白已去除；`[^@\r\n ]*` 允许 `To:` 值里 plus-address 前有显示名或其他字符——真实邮件的 To 一般是裸地址，该前缀兼容显示名形态）：

```json
{
  "parts": [
    { "is_public": false, "regex_def": "(\r\n|^)to:" },
    { "is_public": false, "regex_def": "[^@\r\n]*claim\\+" },
    { "is_public": true,  "regex_def": "[0-9a-f]{32}" },
    { "is_public": false, "regex_def": "@relay\\.xyz" }
  ]
}
```

`circuits/regex-specs/subject_addr.json`（整行严格匹配：地址前后只能是行边界，带 `Re:` 前缀或多余字符必然不匹配）：

```json
{
  "parts": [
    { "is_public": false, "regex_def": "(\r\n|^)subject:" },
    { "is_public": true,  "regex_def": "[1-9A-HJ-NP-Za-km-z]{32,44}" },
    { "is_public": false, "regex_def": "\r\n" }
  ]
}
```

> 若 canonicalized 头部中值前保留了一个空格（`subject: <addr>`，取决于 mailauth 对 relaxed 规则的实现细节），把第一个 part 改为 `"(\r\n|^)subject: "`。Task 5 的电路测试会锁死实际格式——先按无空格实现，失败时打印 `dkimResult.headers` 确认。

- [ ] **Step 2: 用 zk-regex CLI 生成电路**

```bash
cd circuits
zk-regex decomposed -d regex-specs/claim_to.json \
  -c src/regexes/claim_to_regex.circom -t ClaimToRegex -g true
zk-regex decomposed -d regex-specs/subject_addr.json \
  -c src/regexes/subject_addr_regex.circom -t SubjectAddrRegex -g true
# 期望：生成两个 .circom 文件，各自包含 template <Name>(msg_bytes)
```

- [ ] **Step 3: 写 regex 测试包装电路与失败的单测**

生成的 regex 电路没有 main 组件，circom_tester 需要入口文件。创建两个包装：

`circuits/tests/claim_to_test.circom`：

```circom
pragma circom 2.1.6;
include "../src/regexes/claim_to_regex.circom";
component main = ClaimToRegex(4096);
```

`circuits/tests/subject_addr_test.circom`：

```circom
pragma circom 2.1.6;
include "../src/regexes/subject_addr_regex.circom";
component main = SubjectAddrRegex(4096);
```

`circuits/tests/regexes.test.ts`：

```ts
import path from "path";
import { wasm as wasmTester } from "circom_tester";

const headerOf = (subject: string) =>
  Buffer.from(
    `from:alice@test.com\r\nto:claim+${"a".repeat(32)}@relay.xyz\r\nsubject:${subject}\r\ndate:x\r\n`,
    "utf8"
  );

const load = (file: string) =>
  wasmTester(path.join(__dirname, file), {
    output: path.join(__dirname, "../build"),
    include: path.join(__dirname, "../node_modules"),
    recompile: true, O: 1,
  });

const pad = (h: Buffer) => Array.from(h).concat(Array(4096 - h.length).fill(0));

test("ClaimToRegex reveals 32 hex chars", async () => {
  const c = await load("claim_to_test.circom");
  const w = await c.calculateWitness({ msg: pad(headerOf("4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM")) });
  await c.checkConstraints(w);
  await c.assertOut(w, { out: 1 });
});

test("SubjectAddrRegex strict full-line: plain address matches", async () => {
  const c = await load("subject_addr_test.circom");
  const w = await c.calculateWitness({ msg: pad(headerOf("4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM")) });
  await c.checkConstraints(w);
  await c.assertOut(w, { out: 1 });
});

test("SubjectAddrRegex rejects Re: prefix / trailing chars / too-short / bad alphabet", async () => {
  const c = await load("subject_addr_test.circom");
  for (const bad of [
    "Re: 4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM",
    "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM extra",
    "4uQeVj5tqViQh7yWWGStvkEG1Z",           // 25 chars
    "0uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", // '0' not in base58
  ]) {
    const w = await c.calculateWitness({ msg: pad(headerOf(bad)) });
    await c.assertOut(w, { out: 0 });
  }
});
```

（circom_tester 的 msg_bytes 用 4096 仅为测试；Task 4 主电路实例化时用 2048。）

- [ ] **Step 4: 跑测试；若编译器报 regex 不支持（如 `{32,44}` 变长 + 后缀的 DFA 冲突），调整规格后重生成**

```bash
cd circuits && npx jest tests/regexes.test.ts --runInBand
# 期望：PASS 3/3。若 zk-regex 拒绝 `{32,44}` 的确定性（已知限制：无贪婪歧义、单接受态），
# 退路：把 subject_addr.json 的公开 part 改为 "[1-9A-HJ-NP-Za-km-z]+"（贪婪前缀确定），
# 把 32–44 长度约束移入 Task 4 主电路（reveal 后非零字节计数 ∈ [32,44]）。
```

- [ ] **Step 5: Commit**

```bash
git add circuits/regex-specs circuits/src/regexes circuits/tests/regexes.test.ts
git commit -m "feat(circuits): zk-regex circuits for To escrow-id and strict Subject address"
```

---

## Task 4: Claim 主电路与工具电路

**Files:**
- Create: `circuits/src/lib/pack.circom`、`circuits/src/lib/hex.circom`、`circuits/src/lib/digits.circom`
- Create: `circuits/src/claim.circom`
- Create: `circuits/scripts/compile.sh`
- Test: 本任务验证 = 编译成功 + 约束数在预算内；行为测试在 Task 5

**Interfaces:**
- Consumes: Task 3 的 `ClaimToRegex`/`SubjectAddrRegex`；`@zk-email/circuits` 的 `EmailVerifier(maxHeadersLength, maxBodyLength, n, k, ignoreBodyHashCheck, enableHeaderMasking, enableBodyMasking, removeSoftLineBreaks)`（输入 `emailHeader[N]`、`emailHeaderLength`、`pubkey[k]`、`signature[k]`，输出 `pubkeyHash`）与 `SelectRegexReveal(maxArrayLen, maxRevealLen)(reveal, startIndex)`（在 `@zk-email/circuits/utils/regex.circom`，断言窗口外为零并输出窗口内字节）；`@zk-email/zk-regex-circom` 的 `FromAddrRegex(N)`、`EmailDomainRegex(N)`、`TimestampRegex(N)`（均为 `msg[N]` → `out` + `reveal0[N]`）。
- Produces（Task 5/6/11 依赖）：主组件 `ClaimCircuit(2048, 121, 17)`，main public 列表严格为：
  `component main {public [pubkeyHash, commitment, escrowId, timestamp, nullifier, relayer, destA, destB, domainCommitment]} = ClaimCircuit(2048, 121, 17);`
  输入信号（私有）：`emailHeader[2048]`、`emailHeaderLength`、`pubkey[17]`、`signature[17]`、`fromAddrIdx`、`escrowIdIdx`、`subjectAddrIdx`、`timestampIdx`。

- [ ] **Step 1: 写 `circuits/src/lib/pack.circom`**

```circom
pragma circom 2.1.6;

include "circomlib/circuits/comparators.circom";

// Pack N bytes into one field element, little-endian: out = sum in[j] * 256^j. N <= 31.
template PackBytesLE(N) {
    signal input in[N];
    signal output out;
    signal sums[N + 1];
    sums[0] <== 0;
    for (var j = 0; j < N; j++) {
        sums[j + 1] <== sums[j] + (1 << (8 * j)) * in[j];
    }
    out <== sums[N];
}

// Pack N bytes into CHUNKS field elements (31 bytes each, LE). N must equal CHUNKS*31.
template PackBytes31xN(N, CHUNKS) {
    signal input in[N];
    signal output out[CHUNKS];
    component packers[CHUNKS];
    for (var c = 0; c < CHUNKS; c++) {
        packers[c] = PackBytesLE(31);
        for (var j = 0; j < 31; j++) packers[c].in[j] <== in[c * 31 + j];
        out[c] <== packers[c].out;
    }
}

// Assert no byte is uppercase ASCII A-Z (65..90). Zero bytes (padding) are allowed.
template AssertNotUppercase(N) {
    signal input in[N];
    component geLo[N];
    component leHi[N];
    for (var i = 0; i < N; i++) {
        geLo[i] = LessEqThan(8);
        geLo[i].in[0] <== 65; geLo[i].in[1] <== in[i];   // 65 <= b
        leHi[i] = LessEqThan(8);
        leHi[i].in[0] <== in[i]; leHi[i].in[1] <== 90;   // b <= 90
        geLo[i].out * leHi[i].out === 0;                 // not (both)
    }
}
```

- [ ] **Step 2: 写 `circuits/src/lib/hex.circom`**

```circom
pragma circom 2.1.6;

include "circomlib/circuits/comparators.circom";

// N lowercase hex chars ([0-9a-f], no padding) -> one field element (big-endian semantics).
template HexToField(N) {
    signal input in[N];
    signal output out;

    component isNumLo[N]; component isNumHi[N];
    component isAlphaLo[N]; component isAlphaHi[N];
    signal isNum[N]; signal isAlpha[N]; signal nib[N];
    signal sums[N + 1];
    sums[0] <== 0;
    for (var i = 0; i < N; i++) {
        isNumLo[i] = LessEqThan(8); isNumLo[i].in[0] <== 48; isNumLo[i].in[1] <== in[i];
        isNumHi[i] = LessEqThan(8); isNumHi[i].in[0] <== in[i]; isNumHi[i].in[1] <== 57;
        isNum[i] <== isNumLo[i].out * isNumHi[i].out;

        isAlphaLo[i] = LessEqThan(8); isAlphaLo[i].in[0] <== 97; isAlphaLo[i].in[1] <== in[i];
        isAlphaHi[i] = LessEqThan(8); isAlphaHi[i].in[0] <== in[i]; isAlphaHi[i].in[1] <== 102;
        isAlpha[i] <== isAlphaLo[i].out * isAlphaHi[i].out;

        isNum[i] + isAlpha[i] === 1; // exactly one class
        nib[i] <== isNum[i] * (in[i] - 48) + isAlpha[i] * (in[i] - 87);
        sums[i + 1] <== sums[i] * 16 + nib[i];
    }
    out <== sums[N];
}
```

- [ ] **Step 3: 写 `circuits/src/lib/digits.circom`**

```circom
pragma circom 2.1.6;

include "circomlib/circuits/comparators.circom";

// ASCII decimal digits followed by zero padding -> integer.
// First char must be a digit; once a zero byte appears, the rest must be zero.
template Digit2IntStrict(N) {
    signal input in[N];
    signal output out;

    component geLo[N]; component leHi[N]; component isZero[N];
    signal isDigit[N]; signal seenZero[N + 1];
    signal digit[N]; signal sums[N + 1];
    sums[0] <== 0; seenZero[0] <== 0;
    for (var i = 0; i < N; i++) {
        isZero[i] = IsZero();
        isZero[i].in <== in[i];
        geLo[i] = LessEqThan(8); geLo[i].in[0] <== 48; geLo[i].in[1] <== in[i];
        leHi[i] = LessEqThan(8); leHi[i].in[0] <== in[i]; leHi[i].in[1] <== 57;
        isDigit[i] <== geLo[i].out * leHi[i].out;
        // valid iff digit or zero-padding
        isDigit[i] + isZero[i].out === 1;
        // padding must be contiguous: if seenZero, current must be zero
        seenZero[i] * (1 - isZero[i].out) === 0;
        seenZero[i + 1] <== seenZero[i] + isZero[i].out - seenZero[i] * isZero[i].out;
        digit[i] <== isDigit[i] * (in[i] - 48);
        sums[i + 1] <== sums[i] * 10 + digit[i];
    }
    seenZero[0] === 0; // first byte must be a digit (enforced by isDigit+isZero on i=0 with seenZero check below)
    // first byte must be a digit:
    (1 - isDigit[0]) * (1 - 0) === 0;
    out <== sums[N];
}
```

- [ ] **Step 4: 写主电路 `circuits/src/claim.circom`**

安全注记（写进文件头注释）：`timestamp` 取自 DKIM-Signature 头的 `t=` 标签；该标签位于被哈希的头部字节内（DKIM-Signature 头以 b= 置空参与哈希），但 `t=` 的值本身不被其他字段绑定，恶意证明者可伪造时间戳通过窗口校验。真正防重放依赖：escrow_id 每托管唯一（旧邮件不含新 id）+ Escrow 状态机一次性 + Inbox nullifier PDA。生产强化项：把 `t=` 混入 nullifier 或改用 RFC5322 `Date:` 解析电路（成本高，留作后续）。

```circom
pragma circom 2.1.6;

include "@zk-email/circuits/email-verifier.circom";
include "@zk-email/circuits/utils/regex.circom";
include "@zk-email/zk-regex-circom/circuits/common/from_addr_regex.circom";
include "@zk-email/zk-regex-circom/circuits/common/email_domain_regex.circom";
include "@zk-email/zk-regex-circom/circuits/common/timestamp_regex.circom";
include "circomlib/circuits/poseidon.circom";
include "./lib/pack.circom";
include "./lib/hex.circom";
include "./lib/digits.circom";
include "./regexes/claim_to_regex.circom";
include "./regexes/subject_addr_regex.circom";

// Claim circuit: proves "a DKIM-valid email exists whose From hashes to commitment,
// whose To carries escrowId, whose Subject is exactly a base58 address (dest)",
// revealing dest + relayer + timestamp, hiding the email address.
//
// Public signals (order fixed, on-chain program depends on it):
//   [pubkeyHash, commitment, escrowId, timestamp, nullifier, relayer, destA, destB, domainCommitment]
template ClaimCircuit(maxHeadersLength, n, k) {
    var MAX_EMAIL_LEN = 341;   // 11 chunks of 31 bytes
    var EMAIL_CHUNKS = 11;
    var MAX_DOMAIN_LEN = 124;  // 4 chunks
    var DOMAIN_CHUNKS = 4;
    var MAX_DEST_LEN = 44;
    var MAX_TS_DIGITS = 12;

    // ---- private inputs
    signal input emailHeader[maxHeadersLength];
    signal input emailHeaderLength;
    signal input pubkey[k];
    signal input signature[k];
    signal input fromAddrIdx;
    signal input escrowIdIdx;
    signal input subjectAddrIdx;
    signal input timestampIdx;

    // ---- public signals (constrained equal to computed values below)
    signal input pubkeyHash;
    signal input commitment;
    signal input escrowId;
    signal input timestamp;
    signal input nullifier;
    signal input relayer;
    signal input destA;
    signal input destB;
    signal input domainCommitment;

    // C1-C3: DKIM RSA-2048 verify over canonicalized signed headers, body hash ignored.
    component ev = EmailVerifier(maxHeadersLength, 0, n, k, 1, 0, 0, 0);
    ev.emailHeader <== emailHeader;
    ev.emailHeaderLength <== emailHeaderLength;
    ev.pubkey <== pubkey;
    ev.signature <== signature;
    ev.pubkeyHash === pubkeyHash;

    // C5: From address -> lowercase -> Poseidon == commitment
    signal fromOut; signal fromReveal[maxHeadersLength];
    (fromOut, fromReveal) <== FromAddrRegex(maxHeadersLength)(emailHeader);
    fromOut === 1;
    signal fromAddr[MAX_EMAIL_LEN] <== SelectRegexReveal(maxHeadersLength, MAX_EMAIL_LEN)(fromReveal, fromAddrIdx);
    AssertNotUppercase(MAX_EMAIL_LEN)(fromAddr);
    signal emailChunks[EMAIL_CHUNKS] <== PackBytes31xN(MAX_EMAIL_LEN, EMAIL_CHUNKS)(fromAddr);
    commitment === Poseidon(EMAIL_CHUNKS)(emailChunks);

    // C6: To carries claim+<32 lower hex>@relay.xyz -> escrowId
    signal toOut; signal toReveal[maxHeadersLength];
    (toOut, toReveal) <== ClaimToRegex(maxHeadersLength)(emailHeader);
    toOut === 1;
    signal escrowHex[32] <== SelectRegexReveal(maxHeadersLength, 32)(toReveal, escrowIdIdx);
    escrowId === HexToField(32)(escrowHex);

    // C7 (structural): from-domain -> Poseidon == domainCommitment.
    // On-chain, the DKIM registry PDA is derived from domainCommitment and must hold
    // pubkeyHash as Active, i.e. the proving key belongs to the From domain.
    signal fdOut; signal fdReveal[MAX_EMAIL_LEN];
    (fdOut, fdReveal) <== EmailDomainRegex(MAX_EMAIL_LEN)(fromAddr);
    fdOut === 1;
    // EmailDomainRegex reveals the domain at its position inside fromAddr (after '@').
    // Repack the reveal window into a zero-left-padded 124-byte array: find first non-zero.
    // Simpler: domain sits contiguously; we shift it out via SelectRegexReveal on the
    // domain regex reveal, using fromAddrIdx + (index of '@') + 1 computed off-chain.
    signal input domainIdx;   // index of first domain byte within fromAddr window
    signal domainBytes[MAX_DOMAIN_LEN] <== SelectRegexReveal(MAX_EMAIL_LEN, MAX_DOMAIN_LEN)(fdReveal, domainIdx);
    signal domainChunks[DOMAIN_CHUNKS] <== PackBytes31xN(MAX_DOMAIN_LEN, DOMAIN_CHUNKS)(domainBytes);
    domainCommitment === Poseidon(DOMAIN_CHUNKS)(domainChunks);

    // C8: DKIM t= -> timestamp (see security note above)
    signal tsOut; signal tsReveal[maxHeadersLength];
    (tsOut, tsReveal) <== TimestampRegex(maxHeadersLength)(emailHeader);
    tsOut === 1;
    signal tsDigits[MAX_TS_DIGITS] <== SelectRegexReveal(maxHeadersLength, MAX_TS_DIGITS)(tsReveal, timestampIdx);
    timestamp === Digit2IntStrict(MAX_TS_DIGITS)(tsDigits);

    // C9: nullifier = Poseidon(emailChunks, escrowId)
    component nul = Poseidon(EMAIL_CHUNKS + 1);
    for (var i = 0; i < EMAIL_CHUNKS; i++) nul.inputs[i] <== emailChunks[i];
    nul.inputs[EMAIL_CHUNKS] <== escrowId;
    nullifier === nul.out;

    // C11: Subject strictly one base58 address -> destA/destB (31-byte LE chunks)
    signal sOut; signal sReveal[maxHeadersLength];
    (sOut, sReveal) <== SubjectAddrRegex(maxHeadersLength)(emailHeader);
    sOut === 1;
    signal destBytes[MAX_DEST_LEN] <== SelectRegexReveal(maxHeadersLength, MAX_DEST_LEN)(sReveal, subjectAddrIdx);
    component packA = PackBytesLE(31);
    for (var i = 0; i < 31; i++) packA.in[i] <== destBytes[i];
    destA === packA.out;
    component packB = PackBytesLE(13);
    for (var i = 0; i < 13; i++) packB.in[i] <== destBytes[31 + i];
    destB === packB.out;

    // relayer: pass-through public signal, bound into the proof; checked on-chain
    // against the fee payer (pubkey mod Fr). No constraint needed here.
    signal relayerBound <== relayer;
}

component main {public [pubkeyHash, commitment, escrowId, timestamp, nullifier, relayer, destA, destB, domainCommitment]} = ClaimCircuit(2048, 121, 17);
```

- [ ] **Step 5: 写 `circuits/scripts/compile.sh` 并编译**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
circom src/claim.circom -l node_modules --r1cs --wasm --sym --O1 -o build
npx snarkjs r1cs info build/claim.r1cs
```

```bash
bash circuits/scripts/compile.sh
# 期望：编译成功；constraints 预计 1.0M–1.8M（EmailVerifier 头部-only ~700k + 5 个 regex
# 各 ~100–200k）。必须 < 2^22 = 4,194,304（ptau22 容量）。若超限，把 MAX_HEADER_LEN
# 与 regex msg_bytes 降到 1024（真实 Gmail 回复的 canonicalized 头部 ~1–1.5KB，先量后定）后重编。
```

- [ ] **Step 6: Commit**

```bash
git add circuits/src circuits/scripts/compile.sh
git commit -m "feat(circuits): claim circuit composing DKIM verify + field extraction"
```

---

## Task 5: 电路单元测试（真实 witness，真实邮件）

**Files:**
- Create: `circuits/tests/claim.test.ts`
- Test: 本文件即测试

**Interfaces:**
- Consumes: Task 2 `loadClaimEmail` + `circuits/testdata/emails/claim.eml`（人工导出，见 Task 2 Step 5）、Task 4 编译产物 `build/claim_js/claim.wasm`。
- Produces: 证明可用的输入 JSON 形状（Task 6、14 复用 `loadClaimEmail` 输出）。

- [ ] **Step 1: 写电路测试（基于真实 claim.eml）**

`circuits/tests/claim.test.ts`：

```ts
import path from "path";
import fs from "fs";
import { wasm as wasmTester } from "circom_tester";
import { loadClaimEmail, LoadedEmail } from "../scripts/load-email";

jest.setTimeout(600_000);

const EML = path.join(__dirname, "../testdata/emails/claim.eml");

let circuit: any;
let good: LoadedEmail;

beforeAll(async () => {
  if (!fs.existsSync(EML)) {
    throw new Error("missing testdata/emails/claim.eml — 按 testdata/emails/README.md 导出真实邮件");
  }
  circuit = await wasmTester(path.join(__dirname, "../src/claim.circom"), {
    output: path.join(__dirname, "../build"),
    include: path.join(__dirname, "../node_modules"),
    recompile: false, // compile once via compile.sh; set true for first local run
    O: 1,
  });
  good = await loadClaimEmail(EML, 42n);
});

test("valid claim email satisfies constraints and public signals", async () => {
  // 9 个公开信号是 main 的 public inputs，与计算值的相等性由电路内 `===` 约束强制：
  // witness 能算出且 checkConstraints 通过 ⇔ TS 侧 poseidon/打包与电路完全一致（测试向量锁死）。
  const w = await circuit.calculateWitness(good.inputs, true);
  await circuit.checkConstraints(w);
});

test("tampered dest in public signals fails", async () => {
  const bad = { ...good.inputs, destA: "1" };
  await expect(circuit.calculateWitness(bad, true)).rejects.toThrow();
});

test("tampered commitment fails", async () => {
  const bad = { ...good.inputs, commitment: "12345" };
  await expect(circuit.calculateWitness(bad, true)).rejects.toThrow();
});

test("wrong escrow id fails", async () => {
  const bad = { ...good.inputs, escrowId: "999" };
  await expect(circuit.calculateWitness(bad, true)).rejects.toThrow();
});

test("email with tampered subject (Re: prefix) fails DKIM verify at input generation", async () => {
  // 真实邮件改一个字节就破坏 DKIM——同时验证 SubjectAddrRegex 的严格匹配语义由
  // Task 3 的 regex 单测覆盖（Re: 前缀 / 多余字符 / 长度越界 / 非法字符四例）。
  const tampered = Buffer.from(
    good.rawEmail.toString().replace(`Subject: ${good.meta.destBase58}`, `Subject: Re: ${good.meta.destBase58}`)
  );
  const { generateEmailVerifierInputs } = await import("@zk-email/helpers");
  await expect(generateEmailVerifierInputs(tampered, { ignoreBodyHashCheck: true })).rejects.toThrow();
});

test("loader rejects stale email (>48h window)", async () => {
  // 用一个超出时间窗的 timestamp 直接驱动 loader 的新鲜度检查：
  // 不重新验签，仅验证检查逻辑——把 loadClaimEmail 的检查拆不出来时，
  // 改为导出一份旧邮件 fixture 放到 testdata/emails/stale.eml 并 expect rejects。
  // v1 做法：人工保留一封旧邮件为 stale.eml；若不存在则跳过。
  const stale = path.join(__dirname, "../testdata/emails/stale.eml");
  if (!fs.existsSync(stale)) return;
  await expect(loadClaimEmail(stale, 42n)).rejects.toThrow(/48h/);
});
```

- [ ] **Step 2: 跑测试确认行为**

```bash
cd circuits && bash scripts/compile.sh && npx jest tests/claim.test.ts --runInBand
# 期望：全部 PASS。首个用例若报 "Assert Failed" 且行号指向某个 SelectRegexReveal：
# 下标算错——打印 dkimResult.headers 核对真实 canonicalized 格式（尤其 subject: 后有无空格、
# Gmail 的 To 是否带显示名），必要时回到 Task 3 调整 regex 规格。
```

- [ ] **Step 3: Commit**

```bash
git add circuits/scripts/load-email.ts circuits/tests/claim.test.ts
git commit -m "test(circuits): claim circuit witness tests on real gmail .eml"
```

---

## Task 6: Trusted setup、vkey 上链格式、证明转换器

**Files:**
- Create: `circuits/scripts/setup.sh`、`circuits/scripts/gen-vk-rust.mjs`、`circuits/scripts/convert-proof.ts`
- Create: `onchain/programs/email-wallet/src/verifying_key.rs`（生成物，onchain 目录在 Task 7 才 init——先生成到 `circuits/build/verifying_key.rs`，Task 7 拷贝）
- Create: `onchain/tests/fixtures/proof.json`、`onchain/tests/fixtures/public.json`（先生成到 `circuits/build/`，Task 7 拷贝；用 Task 5 的 good inputs 出一份真实证明）
- Test: `snarkjs groth16 verify` 本地验证通过 + 生成的 rs 文件可被 rustc 解析（Task 7 里 `cargo check` 兜底）

**Interfaces:**
- Produces（Task 7/11/13 依赖）：
  - `circuits/build/claim_final.zkey`（rapidsnark/snarkjs 出证明用）
  - `circuits/build/verification_key.json`
  - `verifying_key.rs`：`pub static VERIFYING_KEY: Groth16Verifyingkey = Groth16Verifyingkey { nr_pubinputs: 9, vk_alpha_g1: [..64], vk_beta_g2: [..128], vk_gamme_g2: [..128], vk_delta_g2: [..128], vk_ic: &[..10 个 [u8;64]] };`
  - `convertProofForSolana(proofJson, publicJson): { proofA: number[64], proofB: number[128], proofC: number[64], publicInputs: number[9][32] }`（pi_a 已取负，G2 已 c1/c0 交换，全部大端）。

- [ ] **Step 1: 写 `setup.sh` 并执行（下载 ptau22，约 800MB，耐心）**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
PTAU=build/powersOfTau28_hez_final_22.ptau
if [ ! -f "$PTAU" ]; then
  curl -L -o "$PTAU" \
    https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_22.ptau
fi
npx snarkjs groth16 setup build/claim.r1cs "$PTAU" build/claim_0000.zkey
ENTROPY=$(openssl rand -hex 32)
npx snarkjs zkey contribute build/claim_0000.zkey build/claim_final.zkey \
  --name="local-dev" -e="$ENTROPY"
npx snarkjs zkey export verificationkey build/claim_final.zkey build/verification_key.json
echo "setup done"
```

```bash
bash circuits/scripts/compile.sh && bash circuits/scripts/setup.sh
# 期望：生成 build/claim_final.zkey 与 build/verification_key.json
# 内存不足时：NODE_OPTIONS=--max-old-space-size=16384 bash circuits/scripts/setup.sh
```

- [ ] **Step 2: 写 `gen-vk-rust.mjs` 并生成 verifying_key.rs**

坐标转换规则（来自 groth16-solana 0.2.0 约定）：G1 = `BE32(x)||BE32(y)`（去掉 snarkjs 投影尾巴 `"1"`）；G2 = `BE32(x1)||BE32(x0)||BE32(y1)||BE32(y0)`（每个 Fq2 坐标 **c1 在前**）；IC 原样逐个转，`vk_ic.len()` 必须 = 公开输入数 + 1 = 10。

```js
// circuits/scripts/gen-vk-rust.mjs
import fs from "fs";

const vk = JSON.parse(fs.readFileSync(new URL("../build/verification_key.json", import.meta.url)));

function be32(dec) {
  let v = BigInt(dec);
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}
function g1(p) { // [x, y, "1"] -> 64 bytes BE
  return [...be32(p[0]), ...be32(p[1])];
}
function g2(p) { // [[x0,x1],[y0,y1],["1","0"]] -> c1,c0 per coord, 128 bytes BE
  return [...be32(p[0][1]), ...be32(p[0][0]), ...be32(p[1][1]), ...be32(p[1][0])];
}
const rustArr = (bytes, indent) => {
  // 16 numbers per line; never split a token
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) lines.push(bytes.slice(i, i + 16).join(", "));
  return `[\n${indent}    ${lines.join(`,\n${indent}    `)},\n${indent}]`;
};

const ic = vk.IC.map(g1);
const nPub = ic.length - 1;
if (nPub !== 9) throw new Error(`expected 9 public inputs, got ${nPub}`);

const out = `// GENERATED by gen-vk-rust.mjs — do not edit by hand.
use groth16_solana::groth16::Groth16Verifyingkey;

pub static VERIFYING_KEY: Groth16Verifyingkey = Groth16Verifyingkey {
    nr_pubinputs: ${nPub},
    vk_alpha_g1: ${rustArr(g1(vk.vk_alpha_1), "    ")},
    vk_beta_g2: ${rustArr(g2(vk.vk_beta_2), "    ")},
    vk_gamme_g2: ${rustArr(g2(vk.vk_gamma_2), "    ")}, // sic: crate typo in groth16-solana 0.2.0
    vk_delta_g2: ${rustArr(g2(vk.vk_delta_2), "    ")},
    vk_ic: &[
${ic.map((b) => `        ${rustArr(b, "        ")},`).join("\n")}
    ],
};
`;
fs.writeFileSync(new URL("../build/verifying_key.rs", import.meta.url), out);
console.log("written circuits/build/verifying_key.rs, nr_pubinputs =", nPub);
```

```bash
cd circuits && node scripts/gen-vk-rust.mjs
# 期望：written ... nr_pubinputs = 9
```

- [ ] **Step 3: 写 `convert-proof.ts`**

```ts
// circuits/scripts/convert-proof.ts
const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n; // BN254 Fq

function be32(dec: string | bigint): number[] {
  let v = BigInt(dec);
  const out = new Array<number>(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

export interface SolanaProof {
  proofA: number[];        // [64]  pi_a NEGATED
  proofB: number[];        // [128] c1,c0 per coordinate
  proofC: number[];        // [64]
  publicInputs: number[][]; // [9][32] big-endian, order = main public list
}

export function convertProofForSolana(proof: any, publicSignals: string[]): SolanaProof {
  if (publicSignals.length !== 9) throw new Error("expected 9 public signals");
  const negY = (Q - BigInt(proof.pi_a[1])) % Q;
  return {
    proofA: [...be32(proof.pi_a[0]), ...be32(negY)],
    proofB: [
      ...be32(proof.pi_b[0][1]), ...be32(proof.pi_b[0][0]),
      ...be32(proof.pi_b[1][1]), ...be32(proof.pi_b[1][0]),
    ],
    proofC: [...be32(proof.pi_c[0]), ...be32(proof.pi_c[1])],
    publicInputs: publicSignals.map(be32),
  };
}
```

- [ ] **Step 4: 出一份真实证明做 fixtures 并本地验证**

`circuits/scripts/make-fixture.ts`：

```ts
import fs from "fs";
import { execFileSync } from "child_process";
import { loadClaimEmail } from "./load-email";
import { convertProofForSolana } from "./convert-proof";

async function main() {
  // 真实邮件 + 真实 DNS；relayer 用占位值（链上测试会按 payer 重出证明，见 Task 11）
  const r = await loadClaimEmail("testdata/emails/claim.eml", 42n);
  fs.writeFileSync("build/fixture-input.json", JSON.stringify(r.inputs));
  fs.writeFileSync("build/fixture-meta.json", JSON.stringify(r.meta, null, 2));

  execFileSync("node", [
    "build/claim_js/generate_witness.js", "build/claim_js/claim.wasm",
    "build/fixture-input.json", "build/witness.wtns",
  ], { stdio: "inherit" });
  execFileSync("npx", ["snarkjs", "groth16", "prove",
    "build/claim_final.zkey", "build/witness.wtns",
    "build/proof.json", "build/public.json"], { stdio: "inherit" });
  execFileSync("npx", ["snarkjs", "groth16", "verify",
    "build/verification_key.json", "build/public.json", "build/proof.json"], { stdio: "inherit" });

  const proof = JSON.parse(fs.readFileSync("build/proof.json", "utf8"));
  const pub = JSON.parse(fs.readFileSync("build/public.json", "utf8"));
  const sol = convertProofForSolana(proof, pub);
  fs.writeFileSync("build/solana-proof.json", JSON.stringify({ ...sol, meta: r.meta }, null, 2));
  console.log("fixture ok");
}
main();
```

```bash
cd circuits && NODE_OPTIONS=--max-old-space-size=16384 npx tsx scripts/make-fixture.ts
# 期望：snarkjs verify 打印 OK，生成 build/solana-proof.json（含 meta）
# 前置：testdata/emails/claim.eml 就位且在 48h 时效内
# 纯 JS 证明 ~1.5M 约束需要数分钟；也可先起 Task 13 的 prover 容器后改走 HTTP（见 prove-for.ts）
```

- [ ] **Step 5: Commit**

```bash
git add circuits/scripts/setup.sh circuits/scripts/gen-vk-rust.mjs circuits/scripts/convert-proof.ts circuits/scripts/make-fixture.ts
git commit -m "feat(circuits): trusted setup pipeline + solana vk/proof converters"
```

---

## Task 7: Anchor 工作区、状态定义、ZK 工具模块

**Files:**
- Create: `onchain/`（`anchor init` 产出，重命名默认程序为 `email-wallet`）
- Create: `onchain/programs/email-wallet/src/{state.rs, errors.rs, zk.rs, verifying_key.rs}`
- Modify: `onchain/programs/email-wallet/Cargo.toml`、`onchain/Anchor.toml`
- Test: `zk.rs` 的纯函数用 `cargo test`（host 侧单测，无需验证器）

**Interfaces:**
- Consumes: Task 6 的 `circuits/build/verifying_key.rs`。
- Produces（Task 8–12 依赖）：
  - `Escrow { commitment:[u8;32], sender:Pubkey, mint:Pubkey, amount:u64, escrow_id:[u8;16], bump:u8 }`；seeds = `[b"escrow", commitment, sender, escrow_id]`；`Escrow::SIZE = 8+32+32+32+8+16+1`。
  - `DkimRegistry { pubkey_hash:[u8;32], status:RegistryStatus, expires_at:i64, bump:u8 }`；seeds = `[b"dkim", domain_commitment(32B), selector.as_bytes()]`（≤32B selector 直接做 seed，替代 spec 的 selector_hash，语义相同）。
  - `RegistryConfig { authority: Pubkey, bump: u8 }`；seeds = `[b"config"]`。
  - `RegistryStatus::{Active, Revoked}`（`#[repr(u8)]` + AnchorSerialize）。
  - `zk::PublicInputs { pubkey_hash, commitment, escrow_id:[u8;32]field, timestamp:u64, nullifier, relayer, dest_a, dest_b, domain_commitment }`（各 `[u8;32]` BE 除非注明）。
  - `zk::parse_public_inputs(&[[u8;32];9]) -> Result<PublicInputs>`、`zk::field_to_bytes31(&[u8;32]) -> Result<[u8;31]>`、`zk::decode_dest(&[u8;32], &[u8;32]) -> Result<Pubkey>`、`zk::pubkey_to_field(&Pubkey) -> [u8;32]`、`zk::escrow_id_matches(&[u8;32], &[u8;16]) -> bool`。
  - `errors.rs::ErrorCode`（见下）。

- [ ] **Step 1: 初始化 Anchor 工作区（0.32.1）**

```bash
avm install 0.32.1 && avm use 0.32.1   # 或按 anchor-lang.com 安装指引锁定 0.32.1
anchor --version                        # 期望 anchor-cli 0.32.1
anchor init onchain --template single --no-git
cd onchain
# 把默认程序名改为 email-wallet：
mv programs/onchain programs/email-wallet
# programs/email-wallet/Cargo.toml 中 name = "email-wallet"
# Anchor.toml 中 [programs.localnet] onchain = ... → email_wallet = "<declare_id 的地址>"
# lib.rs 中 declare_id! 保持生成值，pub mod onchain → pub mod email_wallet
```

`onchain/programs/email-wallet/Cargo.toml` 依赖：

```toml
[dependencies]
anchor-lang = { version = "0.32.1", features = ["init-if-needed"] }
anchor-spl = "0.32.1"
groth16-solana = "=0.2.0"
five8 = "0.2"
```

拷贝验证密钥与测试 fixtures：

```bash
cp ../circuits/build/verifying_key.rs programs/email-wallet/src/verifying_key.rs
mkdir -p tests/fixtures
cp ../circuits/build/solana-proof.json tests/fixtures/proof.json
```

- [ ] **Step 2: 写 `state.rs` / `errors.rs`**

`state.rs`：

```rust
use anchor_lang::prelude::*;

#[derive(Clone, Copy, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
#[repr(u8)]
pub enum RegistryStatus { Active = 0, Revoked = 1 }

/// v1: 仅不可退款托管。账户存在即 Open；claim 成功即关闭（租金退 sender）。
/// v2 若恢复可退款模式：重新引入 mode/expiry/status 字段（见 PRD §4.4 备注）。
#[account]
pub struct Escrow {
    pub commitment: [u8; 32],
    pub sender: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub escrow_id: [u8; 16],  // plus-address id; doubles as the PDA nonce
    pub bump: u8,
}
impl Escrow {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 16 + 1;
}

#[account]
pub struct DkimRegistry {
    pub pubkey_hash: [u8; 32],
    pub status: RegistryStatus,
    pub expires_at: i64,
    pub bump: u8,
}
impl DkimRegistry {
    pub const SIZE: usize = 8 + 32 + 1 + 8 + 1;
}

#[account]
pub struct RegistryConfig {
    pub authority: Pubkey,
    pub bump: u8,
}
impl RegistryConfig {
    pub const SIZE: usize = 8 + 32 + 1;
}
```

`errors.rs`：

```rust
use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("unauthorized registry authority")] Unauthorized,
    #[msg("registry entry not active")] RegistryNotActive,
    #[msg("registry key expired")] RegistryExpired,
    #[msg("pubkey hash mismatch")] PubkeyHashMismatch,
    #[msg("commitment mismatch")] CommitmentMismatch,
    #[msg("escrow id mismatch")] EscrowIdMismatch,
    #[msg("timestamp outside allowed window")] TimestampOutOfWindow,
    #[msg("nullifier already used")] NullifierUsed,
    #[msg("relayer mismatch")] RelayerMismatch,
    #[msg("invalid dest field encoding")] InvalidDestField,
    #[msg("invalid base58 dest address")] InvalidDestAddress,
    #[msg("dest owner mismatch")] DestOwnerMismatch,
    #[msg("groth16 verification failed")] ProofVerificationFailed,
    #[msg("vault balance mismatch")] VaultBalanceMismatch,
    #[msg("inbox sweep requires nonzero escrow id uniqueness")] InboxNullifierConflict,
    #[msg("amount must be positive")] InvalidAmount,
}
```

- [ ] **Step 3: 写 `zk.rs`（含 host 侧单测）**

```rust
use anchor_lang::prelude::*;

pub const NUM_PUBLIC_INPUTS: usize = 9;
pub const FR_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

#[derive(Debug, Clone)]
pub struct PublicInputs {
    pub pubkey_hash: [u8; 32],
    pub commitment: [u8; 32],
    pub escrow_id: [u8; 32],
    pub timestamp: u64,
    pub nullifier: [u8; 32],
    pub relayer: [u8; 32],
    pub dest_a: [u8; 32],
    pub dest_b: [u8; 32],
    pub domain_commitment: [u8; 32],
}

pub fn parse_public_inputs(raw: &[[u8; 32]; NUM_PUBLIC_INPUTS]) -> Result<PublicInputs> {
    let mut ts = [0u8; 8];
    // timestamp must fit u64: high 24 bytes must be zero
    require!(raw[3][..24].iter().all(|b| *b == 0), crate::errors::ErrorCode::TimestampOutOfWindow);
    ts.copy_from_slice(&raw[3][24..]);
    Ok(PublicInputs {
        pubkey_hash: raw[0],
        commitment: raw[1],
        escrow_id: raw[2],
        timestamp: u64::from_be_bytes(ts),
        nullifier: raw[4],
        relayer: raw[5],
        dest_a: raw[6],
        dest_b: raw[7],
        domain_commitment: raw[8],
    })
}

/// Unpack one 31-byte-LE-packed field element (given as 32-byte BE integer) to its 31 bytes.
/// The most significant byte of the BE integer must be zero (chunk < 2^248).
pub fn field_to_bytes31(field: &[u8; 32]) -> Result<[u8; 31]> {
    require!(field[0] == 0, crate::errors::ErrorCode::InvalidDestField);
    let mut out = [0u8; 31];
    for i in 0..31 { out[i] = field[31 - i]; } // reverse low 31 bytes
    Ok(out)
}

/// Decode dest pubkey from the two packed subject fields.
pub fn decode_dest(dest_a: &[u8; 32], dest_b: &[u8; 32]) -> Result<Pubkey> {
    let a = field_to_bytes31(dest_a)?;
    let b = field_to_bytes31(dest_b)?;
    let mut ascii = [0u8; 44];
    ascii[..31].copy_from_slice(&a);
    ascii[31..].copy_from_slice(&b[..13]);
    // length = last nonzero index + 1; trailing zeros are padding
    let len = ascii.iter().rposition(|c| *c != 0).map(|i| i + 1).unwrap_or(0);
    require!(len >= 32 && len <= 44, crate::errors::ErrorCode::InvalidDestAddress);
    // bytes after len must be zero (they are, by construction of rposition) — five8 enforces alphabet
    let mut out = [0u8; 32];
    five8::decode_32(&ascii[..len], &mut out)
        .map_err(|_| crate::errors::ErrorCode::InvalidDestAddress)?;
    Ok(Pubkey::new_from_array(out))
}

/// Compare BN254 field (BE) against a 16-byte escrow id (BE, left-padded with zeros).
pub fn escrow_id_matches(field: &[u8; 32], id: &[u8; 16]) -> bool {
    field[..16].iter().all(|b| *b == 0) && &field[16..] == id
}

/// Map a 32-byte pubkey to a BN254 field element: BE integer mod Fr (<= 5 subtractions).
pub fn pubkey_to_field(pk: &Pubkey) -> [u8; 32] {
    let mut x = pk.to_bytes();
    while ge_be(&x, &FR_MODULUS) { sub_be(&mut x, &FR_MODULUS); }
    x
}

fn ge_be(a: &[u8; 32], b: &[u8; 32]) -> bool {
    for i in 0..32 {
        if a[i] != b[i] { return a[i] > b[i]; }
    }
    true
}

fn sub_be(a: &mut [u8; 32], b: &[u8; 32]) {
    let mut borrow = 0u16;
    for i in (0..32).rev() {
        let d = a[i] as i32 - b[i] as i32 - borrow as i32;
        if d < 0 { a[i] = (d + 256) as u8; borrow = 1; } else { a[i] = d as u8; borrow = 0; }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack31_le(bytes: &[u8]) -> [u8; 32] {
        // mirror of the circuit/TS packing: chunk integer little-endian, stored BE
        let mut v = [0u8; 32];
        for (j, b) in bytes.iter().enumerate() {
            // v += b << 8j, all arithmetic fits in 31 bytes
            v[j] = *b;
        }
        let mut be = [0u8; 32];
        for i in 0..31 { be[31 - i] = v[i]; }
        be
    }

    #[test]
    fn roundtrip_dest() {
        let dest = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
        let bytes = dest.as_bytes();
        let fa = pack31_le(&bytes[..31]);
        let fb = pack31_le(&bytes[31..]);
        let pk = decode_dest(&fa, &fb).unwrap();
        assert_eq!(pk.to_string(), dest);
    }

    #[test]
    fn rejects_bad_alphabet() {
        let bytes = b"0uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM"; // '0' invalid
        let fa = pack31_le(&bytes[..31]);
        let fb = pack31_le(&bytes[31..]);
        assert!(decode_dest(&fa, &fb).is_err());
    }

    #[test]
    fn escrow_id_match() {
        let id = [0xabu8; 16];
        let mut f = [0u8; 32];
        f[16..].copy_from_slice(&id);
        assert!(escrow_id_matches(&f, &id));
        assert!(!escrow_id_matches(&[1u8; 32], &id));
    }

    #[test]
    fn pubkey_field_mod_fr() {
        let pk = Pubkey::new_from_array([0xffu8; 32]);
        let f = pubkey_to_field(&pk);
        assert!(ge_be(&[0xffu8; 32], &FR_MODULUS)); // sanity: reduction happened
        assert!(!ge_be(&f, &FR_MODULUS));
    }
}
```

- [ ] **Step 4: 写最小 `lib.rs` 让 `cargo test` 能跑**

`onchain/programs/email-wallet/src/lib.rs`（指令模块在后续 Task 逐个加入，本 Task 只挂模块与 declare_id）：

```rust
use anchor_lang::prelude::*;

pub mod errors;
pub mod state;
pub mod zk;
pub mod verifying_key;

declare_id!("<anchor init 生成的 program id>");

#[program]
pub mod email_wallet {
    use super::*;
    // instructions added by later tasks
}
```

`verifying_key.rs` 头部若引用 `groth16_solana::groth16::Groth16Verifyingkey`，`cargo test` host 编译需要 groth16-solana 可 host 编译（可以，syscalls 只在 SBF 生效）。

```bash
cd onchain && cargo test -p email-wallet
# 期望：4/4 PASS
```

- [ ] **Step 5: `anchor build` 验证链上编译**

```bash
cd onchain && anchor build
anchor keys sync   # 保证 declare_id! 与 target/deploy/email_wallet-keypair.json 一致（e2e 部署依赖）
# 期望：编译成功（含 verifying_key.rs 的 .rodata const）
```

- [ ] **Step 6: Commit**

```bash
git add onchain
git commit -m "feat(onchain): anchor workspace, state, errors, zk field/base58 utils"
```

---

## Task 8: create_escrow（v1 仅不可退款）

**Files:**
- Create: `onchain/programs/email-wallet/src/instructions/mod.rs`、`create_escrow.rs`
- Modify: `onchain/programs/email-wallet/src/lib.rs`（挂载 instructions 模块与入口）
- Test: `onchain/tests/email-wallet.ts`（新建）

**Interfaces:**
- Produces（Task 11/14 依赖）：
  - `create_escrow(ctx, commitment: [u8;32], escrow_id: [u8;16], amount: u64)` → 不可退款托管（v1 唯一创建入口；无 mode/expiry）。
  - Vault = Escrow PDA 的 ATA，创建后从 sender ATA 转入 amount。
  - PDA 派生（TS 侧复用）：`PublicKey.findProgramAddressSync([Buffer.from("escrow"), commitment, sender.toBuffer(), Buffer.from(escrow_id)], programId)`。

- [ ] **Step 1: 写指令 `instructions/create_escrow.rs`**

```rust
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::ErrorCode;
use crate::state::Escrow;

#[derive(Accounts)]
#[instruction(commitment: [u8; 32], escrow_id: [u8; 16])]
pub struct CreateEscrow<'info> {
    #[account(
        init,
        payer = sender,
        space = Escrow::SIZE,
        seeds = [b"escrow", commitment.as_ref(), sender.key().as_ref(), escrow_id.as_ref()],
        bump,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        init,
        payer = sender,
        associated_token::mint = mint,
        associated_token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = sender,
    )]
    pub sender_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub sender: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn create_escrow(
    ctx: Context<CreateEscrow>,
    commitment: [u8; 32],
    escrow_id: [u8; 16],
    amount: u64,
) -> Result<()> {
    require!(amount > 0, ErrorCode::InvalidAmount);
    let escrow = &mut ctx.accounts.escrow;
    escrow.commitment = commitment;
    escrow.sender = ctx.accounts.sender.key();
    escrow.mint = ctx.accounts.mint.key();
    escrow.amount = amount;
    escrow.escrow_id = escrow_id;
    escrow.bump = ctx.bumps.escrow;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.sender_ata.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.sender.to_account_info(),
            },
        ),
        amount,
    )?;
    Ok(())
}
```

`instructions/mod.rs`：

```rust
pub mod create_escrow;
pub use create_escrow::*;
```

`lib.rs` 的 `#[program]` 内加：

```rust
    pub fn create_escrow(ctx: Context<CreateEscrow>, commitment: [u8; 32], escrow_id: [u8; 16], amount: u64) -> Result<()> {
        instructions::create_escrow(ctx, commitment, escrow_id, amount)
    }
```

（`lib.rs` 顶部 `pub mod instructions;` 并 `use instructions::*;`。）

- [ ] **Step 2: 写公共测试工具 `onchain/tests/helpers.ts` 与失败的测试 `onchain/tests/email-wallet.ts`**

公共工具放独立文件（**不要**从含 `describe` 的测试文件 import，否则套件会重复执行）：

`onchain/tests/helpers.ts`：

```ts
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { EmailWallet } from "../target/types/email_wallet";
import { Keypair, PublicKey } from "@solana/web3.js";

export const program = anchor.workspace.EmailWallet as Program<EmailWallet>;
export const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

export function escrowPda(commitment: Buffer, sender: PublicKey, escrowId: Buffer) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), commitment, sender.toBuffer(), escrowId], program.programId)[0];
}
export function inboxPda(commitment: Buffer) {
  return PublicKey.findProgramAddressSync([Buffer.from("inbox"), commitment], program.programId)[0];
}
export function registryPda(domainCommitment: Buffer, selector: string) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("dkim"), domainCommitment, Buffer.from(selector)], program.programId)[0];
}
export function configPda() {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId)[0];
}
export const ata = (mint: PublicKey, owner: PublicKey) =>
  anchor.utils.token.associatedAddress({ mint, owner });

export async function fundSender(sender: Keypair, amount = 2e9) {
  const sig = await provider.connection.requestAirdrop(sender.publicKey, amount);
  await provider.connection.confirmTransaction(sig);
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const fieldToBE = (s: string) => { // decimal field -> 32-byte BE buffer
  let v = BigInt(s); const b = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
};
```

`onchain/tests/email-wallet.ts`：

```ts
import * as anchor from "@coral-xyz/anchor";
import {
  createMint, createAccount, mintTo, getAccount, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assert, expect } from "chai";
import { randomBytes } from "crypto";
import { program, provider, escrowPda, ata, fundSender } from "./helpers";

describe("create_escrow", () => {
  const sender = Keypair.generate();
  let mint: PublicKey;
  let senderAta: PublicKey;
  const commitment = randomBytes(32);

  before(async () => {
    await fundSender(sender);
    mint = await createMint(provider.connection, sender, sender.publicKey, null, 6);
    senderAta = await createAccount(provider.connection, sender, mint, sender.publicKey);
    await mintTo(provider.connection, sender, mint, senderAta, sender, 1_000_000_000);
  });

  it("creates escrow and funds vault", async () => {
    const escrowId = randomBytes(16);
    const escrow = escrowPda(commitment, sender.publicKey, escrowId);
    await program.methods
      .createEscrow(Array.from(commitment), Array.from(escrowId), new anchor.BN(500_000))
      .accounts({
        escrow, mint,
        vault: ata(mint, escrow),
        senderAta, sender: sender.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sender]).rpc();
    const acc = await program.account.escrow.fetch(escrow);
    assert.equal(acc.amount.toNumber(), 500_000);
    assert.equal(acc.sender.toBase58(), sender.publicKey.toBase58());
    const vault = await getAccount(provider.connection, ata(mint, escrow));
    assert.equal(vault.amount.toString(), "500000");
  });

  it("rejects zero amount", async () => {
    const escrowId = randomBytes(16);
    const escrow = escrowPda(commitment, sender.publicKey, escrowId);
    await expect(program.methods
      .createEscrow(Array.from(commitment), Array.from(escrowId), new anchor.BN(0))
      .accounts({ escrow, mint, vault: ata(mint, escrow), senderAta, sender: sender.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([sender]).rpc()).to.be.rejectedWith(/InvalidAmount/);
  });

  it("same (commitment, sender, escrow_id) cannot be created twice", async () => {
    const escrowId = randomBytes(16);
    const escrow = escrowPda(commitment, sender.publicKey, escrowId);
    const mk = () => program.methods
      .createEscrow(Array.from(commitment), Array.from(escrowId), new anchor.BN(1000))
      .accounts({ escrow, mint, vault: ata(mint, escrow), senderAta, sender: sender.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([sender]).rpc();
    await mk();
    await expect(mk()).to.be.rejected; // PDA already initialized
  });

  it("different escrow_id for same email+sender creates independent escrows", async () => {
    const id2 = randomBytes(16);
    const escrow2 = escrowPda(commitment, sender.publicKey, id2);
    await program.methods
      .createEscrow(Array.from(commitment), Array.from(id2), new anchor.BN(7))
      .accounts({ escrow: escrow2, mint, vault: ata(mint, escrow2), senderAta, sender: sender.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([sender]).rpc();
    const acc = await program.account.escrow.fetch(escrow2);
    assert.equal(acc.amount.toNumber(), 7);
  });
});
```

`onchain/package.json` 测试依赖与脚本（anchor init 已生成大部分，确认含）：

```json
{
  "scripts": { "test": "ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts" },
  "dependencies": { "@coral-xyz/anchor": "0.32.1" },
  "devDependencies": {
    "@solana/spl-token": "^0.4.9", "chai": "^4.3.4", "mocha": "^9.0.3",
    "ts-mocha": "^10.0.0", "@types/chai": "^4.3.0", "@types/mocha": "^9.0.0", "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 3: 跑测试**

```bash
cd onchain && anchor build && anchor test
# 期望：4/4 PASS（anchor test 自动起本地验证器）
```

- [ ] **Step 4: Commit**

```bash
git add onchain
git commit -m "feat(onchain): create_escrow (permanent-only in v1)"
```

---

## Task 9:（v1 已移除）refund —— v2 备注

**本任务在 v1 不实现任何代码。** 可退款模式（`refund` 指令、双创建指令拆分、`expiry ≤ 30 天` 校验、`Open → Claimed / Refunded` 状态机、过期后回收路径）已随 PRD v1.4 整体推迟到 v2 再决策是否恢复。

v2 恢复时直接采用 PRD §4.4 备注中的设计（v1.3 的原方案），要点：新增 `refund` 指令（sender 签名 + mode==Refundable 约束；Vault → sender ATA，`close_account` 退租金，Escrow `close = sender`）、Escrow 结构体重引入 `mode/expiry/status` 字段、`create_escrow_refundable` 强制校验 `0 < expiry-now ≤ 30×86400`、claim 对 Refundable 模式加 `now ≤ expiry` 校验。任务编号保留占位，后续任务号不变。

---

## Task 10: DKIM Registry（initialize / upsert / revoke）

**Files:**
- Create: `onchain/programs/email-wallet/src/instructions/registry.rs`
- Modify: `lib.rs`、`instructions/mod.rs`
- Test: `onchain/tests/registry.ts`

**Interfaces:**
- Produces（Task 11 claim 依赖）：
  - `initialize_registry(ctx, authority: Pubkey)` → 一次性创建 `RegistryConfig` PDA（seeds `[b"config"]`）。v1 由团队多签地址做 authority。
  - `registry_upsert(ctx, domain_commitment: [u8;32], selector: String, pubkey_hash: [u8;32], expires_at: i64)` → init-or-update `DkimRegistry` PDA（seeds `[b"dkim", domain_commitment, selector]`）。
  - `registry_revoke(ctx, domain_commitment, selector)` → status=Revoked（保留账户，防同 seed 重建）。
  - claim 侧读取约定：`registry.status == Active && registry.expires_at > now && registry.pubkey_hash == public_inputs[0]`。

- [ ] **Step 1: 写 `instructions/registry.rs`**

```rust
use anchor_lang::prelude::*;

use crate::errors::ErrorCode;
use crate::state::{DkimRegistry, RegistryConfig, RegistryStatus};

#[derive(Accounts)]
pub struct InitializeRegistry<'info> {
    #[account(init, payer = payer, space = RegistryConfig::SIZE, seeds = [b"config"], bump)]
    pub config: Account<'info, RegistryConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_registry(ctx: Context<InitializeRegistry>, authority: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.authority = authority;
    config.bump = ctx.bumps.config;
    Ok(())
}

#[derive(Accounts)]
#[instruction(domain_commitment: [u8; 32], selector: String)]
pub struct RegistryUpsert<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, RegistryConfig>,

    #[account(
        init_if_needed,
        payer = authority,
        space = DkimRegistry::SIZE,
        seeds = [b"dkim", domain_commitment.as_ref(), selector.as_bytes()],
        bump,
    )]
    pub registry: Account<'info, DkimRegistry>,

    #[account(mut, address = config.authority @ ErrorCode::Unauthorized)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn registry_upsert(
    ctx: Context<RegistryUpsert>,
    _domain_commitment: [u8; 32],
    _selector: String,
    pubkey_hash: [u8; 32],
    expires_at: i64,
) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    registry.pubkey_hash = pubkey_hash;
    registry.status = RegistryStatus::Active;
    registry.expires_at = expires_at;
    registry.bump = ctx.bumps.registry;
    Ok(())
}

#[derive(Accounts)]
#[instruction(domain_commitment: [u8; 32], selector: String)]
pub struct RegistryRevoke<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, RegistryConfig>,

    #[account(
        mut,
        seeds = [b"dkim", domain_commitment.as_ref(), selector.as_bytes()],
        bump = registry.bump,
    )]
    pub registry: Account<'info, DkimRegistry>,

    #[account(address = config.authority @ ErrorCode::Unauthorized)]
    pub authority: Signer<'info>,
}

pub fn registry_revoke(ctx: Context<RegistryRevoke>, _domain_commitment: [u8; 32], _selector: String) -> Result<()> {
    ctx.accounts.registry.status = RegistryStatus::Revoked;
    Ok(())
}
```

`lib.rs` 增加三个入口（`initialize_registry` / `registry_upsert` / `registry_revoke`），mod.rs 导出。

- [ ] **Step 2: 写测试 `onchain/tests/registry.ts`**

```ts
import * as anchor from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { assert, expect } from "chai";
import { randomBytes } from "crypto";
import { program, registryPda, configPda, fundSender } from "./helpers";

describe("registry", () => {
  // authority 固定为 provider 默认钱包：claim/sweep 套件共享同一 config
  const authority = provider.wallet.publicKey;
  const stranger = Keypair.generate();
  const domainCommitment = randomBytes(32);
  const pubkeyHash = randomBytes(32);

  before(async () => { await fundSender(stranger); });

  it("initializes config once", async () => {
    try {
      await program.methods.initializeRegistry(authority)
        .accounts({ config: configPda(), payer: authority }).rpc();
    } catch { /* 其他套件可能已初始化 */ }
    const cfg = await program.account.registryConfig.fetch(configPda());
    assert.equal(cfg.authority.toBase58(), authority.toBase58());
    await expect(program.methods.initializeRegistry(stranger.publicKey)
      .accounts({ config: configPda(), payer: stranger.publicKey })
      .signers([stranger]).rpc()).to.be.rejected; // already init
  });

  it("authority can upsert", async () => {
    const expires = Math.floor(Date.now() / 1000) + 90 * 24 * 3600;
    await program.methods.registryUpsert(Array.from(domainCommitment), "s1", Array.from(pubkeyHash), new anchor.BN(expires))
      .accounts({ config: configPda(), registry: registryPda(domainCommitment, "s1"), authority })
      .rpc();
    const r = await program.account.dkimRegistry.fetch(registryPda(domainCommitment, "s1"));
    assert.deepEqual(r.status, { active: {} });
  });

  it("stranger cannot upsert", async () => {
    await expect(program.methods.registryUpsert(Array.from(domainCommitment), "s2", Array.from(randomBytes(32)), new anchor.BN(0))
      .accounts({ config: configPda(), registry: registryPda(domainCommitment, "s2"), authority: stranger.publicKey })
      .signers([stranger]).rpc()).to.be.rejectedWith(/Unauthorized/);
  });

  it("authority can revoke; revoked entry stays", async () => {
    await program.methods.registryRevoke(Array.from(domainCommitment), "s1")
      .accounts({ config: configPda(), registry: registryPda(domainCommitment, "s1"), authority })
      .rpc();
    const r = await program.account.dkimRegistry.fetch(registryPda(domainCommitment, "s1"));
    assert.deepEqual(r.status, { revoked: {} });
  });
});
```

- [ ] **Step 3: 跑测试并 Commit**

```bash
cd onchain && anchor test
# 期望：email-wallet.ts 4 个 + registry.ts 4 个全部 PASS
git add onchain && git commit -m "feat(onchain): dkim registry with authority-gated upsert/revoke"
```

---

## Task 11: claim（Groth16 验证 + 原子转账）

**Files:**
- Create: `onchain/programs/email-wallet/src/instructions/claim.rs`
- Modify: `lib.rs`、`instructions/mod.rs`
- Test: `onchain/tests/claim.ts`

**Interfaces:**
- Consumes: `zk::parse_public_inputs/decode_dest/pubkey_to_field/escrow_id_matches`（Task 7）、`verifying_key::VERIFYING_KEY`（Task 6）、Registry（Task 10）、Escrow（Task 8）。
- Produces：`claim(ctx, args: ClaimArgs)`：
  ```rust
  pub struct ClaimArgs {
      pub proof_a: [u8; 64],
      pub proof_b: [u8; 128],
      pub proof_c: [u8; 64],
      pub public_inputs: [[u8; 32]; 9],
      pub selector: String,
  }
  ```
  执行顺序（先便宜后贵）：解析公开输入 → commitment/escrow_id 匹配 → Registry 校验 → 时间窗 → relayer 绑定 → dest 解码 → **Groth16 verify** → 转账 → 关闭 vault → 关闭 escrow（rent→sender）。

- [ ] **Step 1: 写 `instructions/claim.rs`**

```rust
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};
use groth16_solana::groth16::Groth16Verifier;

use crate::errors::ErrorCode;
use crate::state::{DkimRegistry, Escrow, RegistryStatus};
use crate::verifying_key::VERIFYING_KEY;
use crate::zk;

pub const TIMESTAMP_WINDOW_PAST: i64 = 48 * 3600;  // 48h
pub const TIMESTAMP_WINDOW_FUTURE: i64 = 600;      // 10min clock skew

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ClaimArgs {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub public_inputs: [[u8; 32]; 9],
    pub selector: String,
}

#[derive(Accounts)]
#[instruction(args: ClaimArgs)]
pub struct Claim<'info> {
    #[account(
        mut,
        close = sender,
        seeds = [b"escrow", escrow.commitment.as_ref(), escrow.sender.as_ref(), escrow.escrow_id.as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,

    /// CHECK: rent recipient, taken from escrow state
    #[account(mut, address = escrow.sender)]
    pub sender: UncheckedAccount<'info>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = escrow)]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [b"dkim", args.public_inputs[8].as_ref(), args.selector.as_bytes()],
        bump = registry.bump,
    )]
    pub registry: Account<'info, DkimRegistry>,

    /// CHECK: dest owner, decoded from the proof and compared in the handler
    pub dest_owner: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = dest_owner,
    )]
    pub dest_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn claim(ctx: Context<Claim>, args: ClaimArgs) -> Result<()> {
    let escrow = &ctx.accounts.escrow;
    let now = Clock::get()?.unix_timestamp;

    // 1. parse + bind public inputs to on-chain state
    let pi = zk::parse_public_inputs(&args.public_inputs)?;
    require!(pi.commitment == escrow.commitment, ErrorCode::CommitmentMismatch);
    require!(zk::escrow_id_matches(&pi.escrow_id, &escrow.escrow_id), ErrorCode::EscrowIdMismatch);

    // 2. registry: key must be registered, active, unexpired, matching the proven pubkey hash
    let registry = &ctx.accounts.registry;
    require!(registry.status == RegistryStatus::Active, ErrorCode::RegistryNotActive);
    require!(registry.expires_at > now, ErrorCode::RegistryExpired);
    require!(registry.pubkey_hash == pi.pubkey_hash, ErrorCode::PubkeyHashMismatch);

    // 3. timestamp window
    let ts = pi.timestamp as i64;
    require!(ts >= now - TIMESTAMP_WINDOW_PAST && ts <= now + TIMESTAMP_WINDOW_FUTURE, ErrorCode::TimestampOutOfWindow);

    // 4. relayer binding: proof binds the fee payer
    require!(zk::pubkey_to_field(&ctx.accounts.payer.key()) == pi.relayer, ErrorCode::RelayerMismatch);

    // 5. dest from proof (subject address), must match the provided dest_owner account
    let dest = zk::decode_dest(&pi.dest_a, &pi.dest_b)?;
    require!(dest == ctx.accounts.dest_owner.key(), ErrorCode::DestOwnerMismatch);

    // 6. Groth16 verify (~109-113k CU for 9 public inputs)
    let mut verifier = Groth16Verifier::new(&args.proof_a, &args.proof_b, &args.proof_c, &args.public_inputs, &VERIFYING_KEY)
        .map_err(|_| ErrorCode::ProofVerificationFailed)?;
    verifier.verify().map_err(|_| ErrorCode::ProofVerificationFailed)?;

    // 7. transfer everything out of the vault, then close it; escrow closed by `close = sender`
    let seeds: &[&[u8]] = &[
        b"escrow", escrow.commitment.as_ref(), escrow.sender.as_ref(),
        escrow.escrow_id.as_ref(), &[escrow.bump],
    ];
    let signer = &[seeds];
    let amount = ctx.accounts.vault.amount;
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.dest_ata.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            signer,
        ),
        amount,
    )?;
    token::close_account(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault.to_account_info(),
                destination: ctx.accounts.sender.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            signer,
        ),
    )?;
    Ok(())
}
```

`lib.rs` 加 `pub fn claim(ctx: Context<Claim>, args: ClaimArgs) -> Result<()>`，mod.rs 导出。

- [ ] **Step 2: 写测试前生成"relayer=payer"的证明 fixtures**

Task 6 的 fixture 用了占位 relayer（42n），过不了第 5 步绑定。写一个可在链上测试与 e2e 复用的证明生成脚本 `circuits/scripts/prove-for.ts`。**出证后端二选一**：设了 `PROVER_URL` 就走 Task 13 的 prover 容器（HTTP），否则本地 snarkjs（慢但无 Docker 依赖）：

```ts
// 用法: PROVER_URL=http://localhost:8080 npx tsx scripts/prove-for.ts <emlPath> <relayerPubkeyBase58> <outJson>
// escrow_id / dest / selector 全部从 .eml 解析（loadClaimEmail）
import fs from "fs";
import { execFileSync } from "child_process";
import { loadClaimEmail } from "./load-email";
import { convertProofForSolana } from "./convert-proof";
import { relayerToField } from "./poseidon";
import { PublicKey } from "@solana/web3.js"; // devDependency: @solana/web3.js

async function proveWithContainer(inputs: unknown): Promise<{ proof: any; publicSignals: string[]; ms: number }> {
  const t0 = Date.now();
  const resp = await fetch(`${process.env.PROVER_URL}/prove`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(inputs),
  });
  if (!resp.ok) throw new Error(`prover failed: ${resp.status} ${await resp.text()}`);
  const r = await resp.json();
  console.log(`[prove-for] prover container latency: ${r.ms}ms (http roundtrip ${Date.now() - t0}ms)`);
  return r;
}

function proveLocal(): { proof: any; publicSignals: string[] } {
  execFileSync("node", ["build/claim_js/generate_witness.js", "build/claim_js/claim.wasm",
    "build/pf-input.json", "build/pf-witness.wtns"], { stdio: "inherit" });
  execFileSync("npx", ["snarkjs", "groth16", "prove", "build/claim_final.zkey",
    "build/pf-witness.wtns", "build/pf-proof.json", "build/pf-public.json"], { stdio: "inherit" });
  return {
    proof: JSON.parse(fs.readFileSync("build/pf-proof.json", "utf8")),
    publicSignals: JSON.parse(fs.readFileSync("build/pf-public.json", "utf8")),
  };
}

async function main() {
  const [emlPath, relayerB58, out] = process.argv.slice(2);
  const relayerField = relayerToField(new PublicKey(relayerB58).toBytes());
  const r = await loadClaimEmail(emlPath, relayerField);
  fs.writeFileSync("build/pf-input.json", JSON.stringify(r.inputs));

  const { proof, publicSignals } = process.env.PROVER_URL
    ? await proveWithContainer(r.inputs)
    : proveLocal();

  const sol = convertProofForSolana(proof, publicSignals);
  fs.writeFileSync(out, JSON.stringify({
    ...sol,
    selector: r.meta.selector,
    meta: r.meta,
  }, null, 2));
  console.log("proof written to", out);
}
main();
```

（在 `circuits/package.json` 加 devDependency `"@solana/web3.js": "^1.95.0"`。）

- [ ] **Step 3: 写链上测试 `onchain/tests/claim.ts`**

测试流程：生成 payer keypair → 用 prove-for.ts 对 `claim.eml` 以其公钥出证明（escrow_id/dest/selector 从邮件解析）→ initialize_registry + registry_upsert（pubkeyHash/selector/domainCommitment 取自 meta，**selector 是真实 DKIM selector 如 `20230601`，不再是写死的 "s1"**）→ create_escrow（commitment 与 escrow_id 均来自 meta）→ claim → 断言 dest ATA 余额、escrow/vault 已关闭。

```ts
import * as anchor from "@coral-xyz/anchor";
import { createMint, createAccount, mintTo, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assert, expect } from "chai";
import { execFileSync } from "child_process";
import fs from "fs";
import { program, provider, escrowPda, registryPda, configPda, ata, fundSender, fieldToBE } from "./helpers";

const hexToBytes = (h: string) => Buffer.from(h, "hex");
const CLAIM_EML = "../circuits/testdata/emails/claim.eml";

describe("claim", () => {
  const sender = Keypair.generate();
  const payer = Keypair.generate(); // acts as relayer
  let mint: PublicKey; let senderAta: PublicKey;
  let fixture: any;
  const commitment = () => fieldToBE(fixture.meta.commitment);
  const selector = () => fixture.meta.selector as string;       // 真实 DKIM selector，如 gmail 的 20230601
  const escrowId = () => hexToBytes(fixture.meta.escrowIdHex);  // 从 claim.eml 的 To 解析
  const destB58 = () => fixture.meta.destBase58 as string;      // 从 claim.eml 的 Subject 解析

  before(async function () {
    this.timeout(900_000);
    await fundSender(sender); await fundSender(payer);
    mint = await createMint(provider.connection, sender, sender.publicKey, null, 6);
    senderAta = await createAccount(provider.connection, sender, mint, sender.publicKey);
    await mintTo(provider.connection, sender, mint, senderAta, sender, 1_000_000);

    // generate a proof over the REAL email, binding relayer = payer.publicKey
    // （邮件需在 48h 时效内；本地 snarkjs 慢时可先 `npm run prover:up` 并设 PROVER_URL）
    execFileSync("npx", ["tsx", "../circuits/scripts/prove-for.ts",
      CLAIM_EML, payer.publicKey.toBase58(), "build/onchain-proof.json"],
      { cwd: "../circuits", stdio: "inherit",
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=16384" } });
    fixture = JSON.parse(fs.readFileSync("../circuits/build/onchain-proof.json", "utf8"));

    // registry: authority = provider 默认钱包（所有测试套件共享同一 authority，
    // 避免不同套件 payer 不同导致 Unauthorized）；已初始化则跳过
    try {
      await program.methods.initializeRegistry(provider.wallet.publicKey)
        .accounts({ config: configPda(), payer: provider.wallet.publicKey })
        .rpc();
    } catch { /* already initialized by another suite */ }
    const expires = Math.floor(Date.now() / 1000) + 3600;
    await program.methods.registryUpsert(
        Array.from(fieldToBE(fixture.meta.domainCommitment)), selector(),
        Array.from(fieldToBE(fixture.meta.pubkeyHash)), new anchor.BN(expires))
      .accounts({
        config: configPda(),
        registry: registryPda(fieldToBE(fixture.meta.domainCommitment), selector()),
        authority: provider.wallet.publicKey })
      .rpc();

    // create the escrow the proof claims
    await program.methods.createEscrow(
        Array.from(commitment()), Array.from(escrowId()), new anchor.BN(123_456))
      .accounts({
        escrow: escrowPda(commitment(), sender.publicKey, escrowId()), mint,
        vault: ata(mint, escrowPda(commitment(), sender.publicKey, escrowId())),
        senderAta, sender: sender.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
      .signers([sender]).rpc();
  });

  it("claim transfers funds to proof-bound dest and closes escrow", async () => {
    const escrow = escrowPda(commitment(), sender.publicKey, escrowId());
    const destOwner = new PublicKey(destB58());
    await program.methods.claim({
      proofA: fixture.proofA, proofB: fixture.proofB, proofC: fixture.proofC,
      publicInputs: fixture.publicInputs, selector: selector(),
    } as any)
      .accounts({
        escrow, sender: sender.publicKey, vault: ata(mint, escrow), mint,
        registry: registryPda(fieldToBE(fixture.meta.domainCommitment), selector()),
        destOwner, destAta: ata(mint, destOwner), payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID })
      .signers([payer]).rpc();

    const destAta = await getAccount(provider.connection, ata(mint, destOwner));
    assert.equal(destAta.amount.toString(), "123456");
    assert.equal(await provider.connection.getAccountInfo(escrow), null);
    assert.equal(await provider.connection.getAccountInfo(ata(mint, escrow)), null);
  });

  it("second claim of the same escrow fails (account closed)", async () => {
    const escrow = escrowPda(commitment(), sender.publicKey, escrowId());
    const destOwner = new PublicKey(destB58());
    await expect(program.methods.claim({
      proofA: fixture.proofA, proofB: fixture.proofB, proofC: fixture.proofC,
      publicInputs: fixture.publicInputs, selector: selector(),
    } as any)
      .accounts({
        escrow, sender: sender.publicKey, vault: ata(mint, escrow), mint,
        registry: registryPda(fieldToBE(fixture.meta.domainCommitment), selector()),
        destOwner, destAta: ata(mint, destOwner), payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID })
      .signers([payer]).rpc()).to.be.rejected;
  });
});
```

> 账户名大小写：Anchor TS 客户端方法/账户名为 camelCase（`proof_a`→`proofA`、`dest_owner`→`destOwner`）。IDL 中 `[u8;128]` 等定长数组直接传 number[]。

- [ ] **Step 4: 跑测试（含真实 Groth16 验证，单交易约 115k CU）**

```bash
cd onchain && anchor test
# 期望：claim 2 个用例 PASS。若报 compute budget 超限：claim 指令前加
#   ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })（同一交易第一条指令）
# 若 groth16 verify 失败：先核对该 proof 在 snarkjs groth16 verify 下有效，
# 再核对 convert-proof.ts 的 c1/c0 交换与 pi_a 取负。
```

- [ ] **Step 5: Commit**

```bash
git add onchain circuits/scripts/prove-for.ts circuits/package.json
git commit -m "feat(onchain): claim with on-chain groth16 verify + atomic payout"
```

---

## Task 12: sweep_inbox（Inbox PDA 常驻收款）

**Files:**
- Create: `onchain/programs/email-wallet/src/instructions/sweep_inbox.rs`
- Modify: `lib.rs`、`instructions/mod.rs`
- Test: `onchain/tests/sweep-inbox.ts`

**Interfaces:**
- Consumes: 与 claim 相同的 `ClaimArgs`（电路不变；Inbox 清扫时 plus-address 中的 32hex 为调用方一次性随机 id，保证每次 sweep 的 nullifier 唯一）。
- Produces：`sweep_inbox(ctx, args: ClaimArgs)` —— Inbox PDA（`seeds=[b"inbox", commitment]`，零数据、仅作 token authority）名下各 mint ATA 余额原子转入 dest；每次 sweep 创建 `NullifierRecord` PDA（`seeds=[b"inboxnull", commitment, nullifier]`，`init` 即防重放——同 nullifier 第二次 init 失败）。mints 通过 remaining_accounts 传入，三元组 `[mint, inbox_ata, dest_ata]` 顺序排列；dest ATA 不存在时由 payer 付费创建（CPI `create_idempotent`）。

- [ ] **Step 1: 写 `instructions/sweep_inbox.rs`**

```rust
use anchor_lang::prelude::*;
use anchor_spl::associated_token::{self, AssociatedToken, CreateIdempotent};
use anchor_spl::token::{Mint, Token, TokenAccount, Transfer};
use groth16_solana::groth16::Groth16Verifier;

use crate::errors::ErrorCode;
use crate::instructions::claim::{ClaimArgs, TIMESTAMP_WINDOW_FUTURE, TIMESTAMP_WINDOW_PAST};
use crate::state::{DkimRegistry, RegistryStatus};
use crate::verifying_key::VERIFYING_KEY;
use crate::zk;

/// Zero-data marker so Anchor records the nullifier PDA rent payer; existence = used.
#[account]
pub struct NullifierRecord {
    pub bump: u8,
}
impl NullifierRecord { pub const SIZE: usize = 8 + 1; }

#[derive(Accounts)]
#[instruction(args: ClaimArgs)]
pub struct SweepInbox<'info> {
    /// CHECK: inbox PDA, token authority only (zero data). seeds bind it to the proven commitment.
    #[account(seeds = [b"inbox", args.public_inputs[1].as_ref()], bump)]
    pub inbox: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = NullifierRecord::SIZE,
        seeds = [b"inboxnull", args.public_inputs[1].as_ref(), args.public_inputs[4].as_ref()],
        bump,
    )]
    pub nullifier_record: Account<'info, NullifierRecord>,

    #[account(
        seeds = [b"dkim", args.public_inputs[8].as_ref(), args.selector.as_bytes()],
        bump = registry.bump,
    )]
    pub registry: Account<'info, DkimRegistry>,

    /// CHECK: dest owner decoded from proof, compared in handler
    pub dest_owner: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: repeating triples [mint, inbox_ata, dest_ata]
}

pub fn sweep_inbox<'info>(
    ctx: Context<'_, '_, '_, 'info, SweepInbox<'info>>,
    args: ClaimArgs,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pi = zk::parse_public_inputs(&args.public_inputs)?;

    // registry + timestamp + relayer checks identical to claim
    let registry = &ctx.accounts.registry;
    require!(registry.status == RegistryStatus::Active, ErrorCode::RegistryNotActive);
    require!(registry.expires_at > now, ErrorCode::RegistryExpired);
    require!(registry.pubkey_hash == pi.pubkey_hash, ErrorCode::PubkeyHashMismatch);
    let ts = pi.timestamp as i64;
    require!(ts >= now - TIMESTAMP_WINDOW_PAST && ts <= now + TIMESTAMP_WINDOW_FUTURE, ErrorCode::TimestampOutOfWindow);
    require!(zk::pubkey_to_field(&ctx.accounts.payer.key()) == pi.relayer, ErrorCode::RelayerMismatch);

    let dest = zk::decode_dest(&pi.dest_a, &pi.dest_b)?;
    require!(dest == ctx.accounts.dest_owner.key(), ErrorCode::DestOwnerMismatch);

    let mut verifier = Groth16Verifier::new(&args.proof_a, &args.proof_b, &args.proof_c, &args.public_inputs, &VERIFYING_KEY)
        .map_err(|_| ErrorCode::ProofVerificationFailed)?;
    verifier.verify().map_err(|_| ErrorCode::ProofVerificationFailed)?;

    // sweep every (mint, inbox_ata, dest_ata) triple
    let commitment = pi.commitment;
    let inbox_bump = ctx.bumps.inbox;
    let signer: &[&[&[u8]]] = &[&[b"inbox", commitment.as_ref(), &[inbox_bump]]];
    let remaining = &ctx.remaining_accounts;
    require!(remaining.len() % 3 == 0, ErrorCode::VaultBalanceMismatch);

    for triple in remaining.chunks(3) {
        let (mint_ai, inbox_ata, dest_ata) = (&triple[0], &triple[1], &triple[2]);
        // validate addresses against the program-derived expectations
        let mint = Mint::try_deserialize(&mut &mint_ai.try_borrow_data()?[..])?;
        let expected_inbox_ata = associated_token::get_associated_token_address(&ctx.accounts.inbox.key(), &mint_ai.key());
        require!(inbox_ata.key() == expected_inbox_ata, ErrorCode::VaultBalanceMismatch);
        let expected_dest_ata = associated_token::get_associated_token_address(&dest, &mint_ai.key());
        require!(dest_ata.key() == expected_dest_ata, ErrorCode::DestOwnerMismatch);

        // create dest ATA idempotently (payer funds)
        associated_token::create_idempotent(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            CreateIdempotent {
                funding_account: ctx.accounts.payer.to_account_info(),
                associated_token_account: dest_ata.clone(),
                wallet: ctx.accounts.dest_owner.to_account_info(),
                mint: mint_ai.clone(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;

        let from = TokenAccount::try_deserialize(&mut &inbox_ata.try_borrow_data()?[..])?;
        if from.amount == 0 { continue; }
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: inbox_ata.clone(),
                    to: dest_ata.clone(),
                    authority: ctx.accounts.inbox.to_account_info(),
                },
                signer,
            ),
            from.amount,
        )?;
        let _ = mint; // mint account validated via ATA derivation above
    }
    Ok(())
}
```

> 若 `associated_token::get_associated_token_address` 在 anchor-spl 0.32 的导出路径不同（`anchor_spl::associated_token::get_associated_token_address`），以编译器提示为准。`CreateIdempotent` 结构若缺字段（不同 anchor-spl 版本有 `token_program`/`associated_token_program` 差异），按 IDL 报错补齐。

`lib.rs` 加 `pub fn sweep_inbox<'info>(ctx: Context<'_, '_, '_, 'info, SweepInbox<'info>>, args: ClaimArgs) -> Result<()>`，mod.rs 导出。

- [ ] **Step 2: 写测试 `onchain/tests/sweep-inbox.ts`**

```ts
import * as anchor from "@coral-xyz/anchor";
import {
  createMint, mintTo, getAccount, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { assert, expect } from "chai";
import { execFileSync } from "child_process";
import fs from "fs";
import {
  program, provider, inboxPda, registryPda, configPda, fundSender, fieldToBE,
} from "./helpers";

// sweep.eml：真实邮件，To=claim+<另一个32hex>@relay.xyz（与 claim.eml 不同 id），Subject=dest
const SWEEP_EML = "../circuits/testdata/emails/sweep.eml";

describe("sweep_inbox", () => {
  const funder = Keypair.generate();
  const payer = Keypair.generate(); // relayer
  let mint: PublicKey;
  let fixture: any;
  let commitment: Buffer;
  let inbox: PublicKey;
  const selector = () => fixture.meta.selector as string;
  const destB58 = () => fixture.meta.destBase58 as string;

  before(async function () {
    this.timeout(900_000);
    await fundSender(funder); await fundSender(payer);
    mint = await createMint(provider.connection, funder, funder.publicKey, null, 6);

    // proof over the REAL sweep.eml, binding relayer = payer
    execFileSync("npx", ["tsx", "../circuits/scripts/prove-for.ts",
      SWEEP_EML, payer.publicKey.toBase58(), "build/sweep-proof.json"],
      { cwd: "../circuits", stdio: "inherit",
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=16384" } });
    fixture = JSON.parse(fs.readFileSync("../circuits/build/sweep-proof.json", "utf8"));
    commitment = fieldToBE(fixture.meta.commitment);
    inbox = inboxPda(commitment);

    // registry：authority = provider 默认钱包（与 claim.ts 一致）；已初始化则跳过
    try {
      await program.methods.initializeRegistry(provider.wallet.publicKey)
        .accounts({ config: configPda(), payer: provider.wallet.publicKey }).rpc();
    } catch { /* already initialized by another suite */ }
    await program.methods.registryUpsert(
        Array.from(fieldToBE(fixture.meta.domainCommitment)), selector(),
        Array.from(fieldToBE(fixture.meta.pubkeyHash)),
        new anchor.BN(Math.floor(Date.now() / 1000) + 3600))
      .accounts({
        config: configPda(),
        registry: registryPda(fieldToBE(fixture.meta.domainCommitment), selector()),
        authority: provider.wallet.publicKey })
      .rpc();

    // 任何人直接给 inbox 的 ATA 打币（FR-INB-1：无需创建链上状态）。
    // inbox 是 PDA（off-curve），createAccount 默认不允许，须显式 allowOwnerOffCurve：
    const inboxAtaAddr = getAssociatedTokenAddressSync(mint, inbox, true);
    const createTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(funder.publicKey, inboxAtaAddr, inbox, mint));
    await provider.sendAndConfirm(createTx, [funder]);
    await mintTo(provider.connection, funder, mint, inboxAtaAddr, funder, 777_000);
  });

  const callSweep = () => {
    const destOwner = new PublicKey(destB58());
    const inboxAta = getAssociatedTokenAddressSync(mint, inbox, true);
    const destAta = getAssociatedTokenAddressSync(mint, destOwner);
    const nullifierRecord = PublicKey.findProgramAddressSync(
      [Buffer.from("inboxnull"), commitment, fieldToBE(fixture.meta.nullifier)],
      program.programId)[0];
    return program.methods.sweepInbox({
      proofA: fixture.proofA, proofB: fixture.proofB, proofC: fixture.proofC,
      publicInputs: fixture.publicInputs, selector: selector(),
    } as any)
      .accounts({
        inbox, nullifierRecord,
        registry: registryPda(fieldToBE(fixture.meta.domainCommitment), selector()),
        destOwner, payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: inboxAta, isSigner: false, isWritable: true },
        { pubkey: destAta, isSigner: false, isWritable: true },
      ])
      .signers([payer]).rpc();
  };

  it("sweeps inbox balance to proof-bound dest", async () => {
    await callSweep();
    const destOwner = new PublicKey(destB58());
    const destAta = await getAccount(provider.connection, getAssociatedTokenAddressSync(mint, destOwner));
    assert.equal(destAta.amount.toString(), "777000");
    const inboxAta = await getAccount(provider.connection, getAssociatedTokenAddressSync(mint, inbox, true));
    assert.equal(inboxAta.amount.toString(), "0");
  });

  it("rejects replay of the same sweep proof (nullifier record exists)", async () => {
    await expect(callSweep()).to.be.rejected;
  });
});
```

> 注：`anchor test` 默认全部测试共享一个验证器实例，claim.ts 与 sweep-inbox.ts 若用**同一个 payer keypair** 会冲突 `initializeRegistry`；这里用 try/catch 容忍已初始化（registryUpsert 幂等覆盖）。若想让套件完全隔离，给每个套件用独立 payer 并分别在各自的 `before` 里初始化——但 config PDA 全局唯一，仍需 try/catch。

- [ ] **Step 3: 跑测试并 Commit**

```bash
cd onchain && anchor test
# 期望：全部用例 PASS（含 sweep 重放拒绝）
git add onchain && git commit -m "feat(onchain): sweep_inbox with nullifier replay protection"
```

---

## Task 13: Prover 容器（rapidsnark + HTTP 出证服务）

**Files:**
- Create: `prover/Dockerfile`、`prover/server.ts`、`prover/README.md`
- Create: `docker-compose.yml`（仓库根）
- Test: 容器健康检查 + 一次真实出证往返（断言延迟，验证 NFR-3）

**Interfaces:**
- Consumes: Task 4/6 产物 `circuits/build/claim_js/claim.wasm`、`circuits/build/claim_js/generate_witness.js`、`circuits/build/claim_final.zkey`（运行时以只读 volume 挂载进容器）。
- Produces（Task 14 依赖）：HTTP 服务 `http://localhost:8080`：
  - `GET /health` → 200 `ok`
  - `POST /prove`，body = 电路输入 JSON（即 `loadClaimEmail` 的 `inputs`）→ 200 `{ proof, publicSignals, ms }`（proof/publicSignals 为 snarkjs 标准 JSON 格式，与本地 `snarkjs groth16 prove` 产物完全一致，下游 `convertProofForSolana` 无需改动）；500 = 出证失败。
  - 容器内链路：`node generate_witness.js claim.wasm input.json witness.wtns`（秒级）→ `rapidsnark build/prover claim_final.zkey witness.wtns proof.json public.json`（原生多线程）。

- [ ] **Step 1: 写 `prover/Dockerfile`（两阶段：编译 rapidsnark → 运行时）**

```dockerfile
# ---------- build rapidsnark ----------
FROM node:20-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake libgmp-dev libsodium-dev nasm git \
    && rm -rf /var/lib/apt/lists/*
# rapidsnark 官方构建方式：npm install 后用 go-task 驱动的 Taskfile
# （首次执行时记录当前 HEAD commit 哈希并替换下面的 checkout，锁定版本）
RUN git clone https://github.com/iden3/rapidsnark.git /rapidsnark \
    && cd /rapidsnark && git submodule init && git submodule update
WORKDIR /rapidsnark
RUN npm install && npx task build_prover
# 产出：/rapidsnark/build/prover

# ---------- runtime ----------
FROM node:20-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends libgmp10 libsodium23 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /rapidsnark/build/prover /usr/local/bin/prover
WORKDIR /app
COPY server.ts /app/server.ts
RUN npm install -g tsx
EXPOSE 8080
# 电路产物由 docker-compose 以 volume 挂到 /artifacts
CMD ["tsx", "/app/server.ts"]
```

> rapidsnark 的 Taskfile 任务名以仓库 README 为准（历史上为 `build_prover`，产出 `build/prover`，CLI 用法 `prover <circuit.zkey> <witness.wtns> <proof.json> <public.json>`）。witness 生成不走 rapidsnark——直接用 circom `--wasm` 产物的 `generate_witness.js`（Node，秒级），重活只有 prover 那一步。

- [ ] **Step 2: 写 `prover/server.ts`（零依赖，Node http；出证串行化）**

```ts
import http from "http";
import fs from "fs";
import { execFileSync } from "child_process";

const ART = process.env.ARTIFACTS_DIR ?? "/artifacts";
const PORT = Number(process.env.PORT ?? 8080);
const WASM = `${ART}/claim_js/claim.wasm`;
const WITNESS_GEN = `${ART}/claim_js/generate_witness.js`;
const ZKEY = `${ART}/claim_final.zkey`;

for (const f of [WASM, WITNESS_GEN, ZKEY]) {
  if (!fs.existsSync(f)) { console.error(`missing artifact: ${f}`); process.exit(1); }
}

// rapidsnark 不是线程安全的并发服务：简单 Promise 链串行化出证请求
let queue: Promise<unknown> = Promise.resolve();

function prove(inputs: unknown): { proof: unknown; publicSignals: unknown; ms: number } {
  const t0 = Date.now();
  fs.writeFileSync("/tmp/input.json", JSON.stringify(inputs));
  execFileSync("node", [WITNESS_GEN, WASM, "/tmp/input.json", "/tmp/witness.wtns"],
    { maxBuffer: 64 * 1024 * 1024 });
  execFileSync("/usr/local/bin/prover", [ZKEY, "/tmp/witness.wtns", "/tmp/proof.json", "/tmp/public.json"],
    { maxBuffer: 64 * 1024 * 1024 });
  return {
    proof: JSON.parse(fs.readFileSync("/tmp/proof.json", "utf8")),
    publicSignals: JSON.parse(fs.readFileSync("/tmp/public.json", "utf8")),
    ms: Date.now() - t0,
  };
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") { res.end("ok"); return; }
  if (req.method === "POST" && req.url === "/prove") {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      queue = queue.then(() => {
        try {
          const inputs = JSON.parse(Buffer.concat(chunks).toString());
          const result = prove(inputs);
          console.log(`[prover] proof generated in ${result.ms}ms`);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.statusCode = 500;
          res.end(String(e?.message ?? e));
        }
      });
    });
    return;
  }
  res.statusCode = 404; res.end();
});
server.listen(PORT, () => console.log(`[prover] listening on :${PORT}`));
```

- [ ] **Step 3: 写根 `docker-compose.yml`**

```yaml
services:
  prover:
    build: ./prover
    ports: ["8080:8080"]
    volumes:
      - ./circuits/build:/artifacts:ro
    environment:
      ARTIFACTS_DIR: /artifacts
    # ~1.5M 约束的 rapidsnark 出证内存峰值约 4–8GB；按需调整
    mem_limit: 12g
```

- [ ] **Step 4: 构建并做真实出证往返测试（NFR-3 验证）**

前置：Task 4/6 已完成（`circuits/build/` 下有 claim.wasm、generate_witness.js、claim_final.zkey），且 Task 6 已生成 `build/fixture-input.json`。

```bash
npm run prover:up
curl -s localhost:8080/health   # 期望 ok
time curl -s -X POST localhost:8080/prove \
  -H 'content-type: application/json' \
  --data-binary @circuits/build/fixture-input.json \
  -o /tmp/prover-resp.json
node -e "
const r = require('/tmp/prover-resp.json');
console.log('publicSignals:', r.publicSignals.length, 'latency:', r.ms, 'ms');
if (r.ms > 30000) throw new Error('NFR-3 violated: proving > 30s');
if (r.publicSignals.length !== 9) throw new Error('bad public signals');
"
# 交叉验证：容器出的证明能被 snarkjs 本地验证（格式一致性）
cd circuits && node -e "
const fs = require('fs');
const r = JSON.parse(fs.readFileSync('/tmp/prover-resp.json', 'utf8'));
fs.writeFileSync('build/prover-proof.json', JSON.stringify(r.proof));
fs.writeFileSync('build/prover-public.json', JSON.stringify(r.publicSignals));
" && npx snarkjs groth16 verify build/verification_key.json build/prover-public.json build/prover-proof.json
# 期望：[INFO] snarkJS: OK!
```

- [ ] **Step 5: 写 `prover/README.md` 并 Commit**

README 内容：构建命令（`npm run prover:up`）、接口（health/prove 各一行示例 curl）、产物挂载约定、资源建议（内存 12g、出证串行）。

```bash
git add prover docker-compose.yml
git commit -m "feat(prover): containerized rapidsnark proving service with HTTP API"
```

---

## Task 14: e2e 脚本（真实邮件 → prover 容器出证明 → 本地验证器全流程）

**Files:**
- Create: `e2e/e2e.ts`
- Modify: 根 `package.json`（`npm run e2e` 已指向此文件）
- Test: 本脚本即 e2e 测试（退出码非 0 = 失败）

**Interfaces:**
- Consumes: `circuits/testdata/emails/e2e.eml`（人工导出，48h 时效内）、`circuits/build/claim_final.zkey`、`claim_js/claim.wasm`、`onchain/target/deploy/email_wallet.so` 与 IDL（`anchor build` 产出）、Task 13 的 prover 容器（`docker compose`）。
- Produces: 一条命令完成全流程验证：`npm run e2e`。

- [ ] **Step 1: 写 `e2e/e2e.ts`**

顺序要点：**先解析 e2e.eml**（escrow_id / dest / commitment 都从真实邮件来），**再建托管**，最后出证明并 claim——与生产一致（邮件是接收方对通知的回复，其 To 里的 escrow_id 必须与链上托管匹配）。

```ts
import { spawn, execFileSync, ChildProcess } from "child_process";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, ComputeBudgetProgram,
} from "@solana/web3.js";
import { createMint, createAccount, mintTo, getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import fs from "fs";

const RPC = "http://127.0.0.1:8899";
const EML = "circuits/testdata/emails/e2e.eml";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fieldToBE = (s: string) => {
  let v = BigInt(s); const b = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
};

async function waitRpc(conn: Connection) {
  for (let i = 0; i < 60; i++) {
    try { await conn.getSlot(); return; } catch { await sleep(500); }
  }
  throw new Error("validator did not start");
}

async function main() {
  // 0. 先解析真实邮件（DKIM 走真实 DNS），拿到 escrow_id / dest / commitment
  const relayer = Keypair.generate();  // 代付方（证明绑定它）
  const { loadClaimEmail } = await import("../circuits/scripts/load-email");
  const { relayerToField } = await import("../circuits/scripts/poseidon");
  const email = await loadClaimEmail(EML, relayerToField(relayer.publicKey.toBytes()));
  const { escrowIdHex, destBase58, selector, commitment: commitmentStr } = email.meta;
  const ESCROW_ID = Buffer.from(escrowIdHex, "hex");
  const commitment = fieldToBE(commitmentStr);
  console.log(`[e2e] email parsed: from=${email.meta.fromEmail} escrow=${escrowIdHex} dest=${destBase58}`);

  // 1. build program & start a fresh local validator with the program deployed
  execFileSync("anchor", ["build"], { cwd: "onchain", stdio: "inherit" });
  const programId = JSON.parse(fs.readFileSync("onchain/target/deploy/email_wallet-keypair.json", "utf8"));
  const programIdStr = Keypair.fromSecretKey(Uint8Array.from(programId)).publicKey.toBase58();
  const validator: ChildProcess = spawn("solana-test-validator", [
    "--reset", "--quiet",
    "--bpf-program", programIdStr, "onchain/target/deploy/email_wallet.so",
  ], { stdio: "ignore" });
  process.on("exit", () => validator.kill());

  const conn = new Connection(RPC, "confirmed");
  await waitRpc(conn);

  const sender = Keypair.generate();   // 发送方
  for (const kp of [sender, relayer]) {
    const sig = await conn.requestAirdrop(kp.publicKey, 5e9);
    await conn.confirmTransaction(sig);
  }

  // 2. sender 侧：创建 SPL mint + 存币建托管（commitment 对应邮件 From 邮箱，escrow_id 对应邮件 To）
  const idl = JSON.parse(fs.readFileSync("onchain/target/idl/email_wallet.json", "utf8"));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(relayer), { commitment: "confirmed" });
  const program = new Program(idl, provider) as any;

  const mint = await createMint(conn, sender, sender.publicKey, null, 6);
  const senderAta = await createAccount(conn, sender, mint, sender.publicKey);
  await mintTo(conn, sender, mint, senderAta, sender, 1_000_000);
  const escrow = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), commitment, sender.publicKey.toBuffer(), ESCROW_ID],
    new PublicKey(programIdStr))[0];
  const ata = (m: PublicKey, o: PublicKey) => anchor.utils.token.associatedAddress({ mint: m, owner: o });
  await program.methods.createEscrow(Array.from(commitment), Array.from(ESCROW_ID), new anchor.BN(50_000_000))
    .accounts({ escrow, mint, vault: ata(mint, escrow), senderAta, sender: sender.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
    .signers([sender]).rpc();
  console.log("[e2e] escrow created:", escrow.toBase58());

  // 3. 起 prover 容器（Task 13），对真实回复邮件出证明
  execFileSync("docker", ["compose", "up", "-d", "--build", "prover"], { stdio: "inherit" });
  process.on("exit", () => { try { execFileSync("docker", ["compose", "down"], { stdio: "ignore" }); } catch {} });
  for (let i = 0; i < 120; i++) { // 首次构建镜像较慢，耐心等 health
    try {
      const r = await fetch("http://localhost:8080/health");
      if (r.ok) break;
    } catch {}
    await sleep(1000);
    if (i === 119) throw new Error("prover container did not become healthy");
  }
  const proveStart = Date.now();
  execFileSync("npx", ["tsx", "circuits/scripts/prove-for.ts",
    EML, relayer.publicKey.toBase58(), "circuits/build/e2e-proof.json"],
    { stdio: "inherit", env: { ...process.env, PROVER_URL: "http://localhost:8080" } });
  const fixture = JSON.parse(fs.readFileSync("circuits/build/e2e-proof.json", "utf8"));
  const proveMs = Date.now() - proveStart;
  console.log(`[e2e] proof generated via prover container in ${proveMs}ms`);
  if (proveMs > 30_000) throw new Error(`NFR-3 violated: proving took ${proveMs}ms > 30s`);

  // 4. 运营侧：把该服务商（真实 DNS 取回的）DKIM 公钥哈希注册上链
  //    selector 用邮件里的真实 DKIM s=（如 gmail 的 20230601）
  const config = PublicKey.findProgramAddressSync([Buffer.from("config")], new PublicKey(programIdStr))[0];
  await program.methods.initializeRegistry(relayer.publicKey)
    .accounts({ config, payer: relayer.publicKey }).rpc();
  const registry = PublicKey.findProgramAddressSync(
    [Buffer.from("dkim"), fieldToBE(fixture.meta.domainCommitment), Buffer.from(selector)],
    new PublicKey(programIdStr))[0];
  await program.methods.registryUpsert(
      Array.from(fieldToBE(fixture.meta.domainCommitment)), selector,
      Array.from(fieldToBE(fixture.meta.pubkeyHash)), new anchor.BN(Math.floor(Date.now() / 1000) + 3600))
    .accounts({ config, registry, authority: relayer.publicKey }).rpc();
  console.log("[e2e] dkim registry upserted for", email.meta.domain, selector);

  // 5. claim：单笔交易 = 验证明 + 解码 dest + 转账 + 关账户
  const destOwner = new PublicKey(destBase58);
  const sig = await program.methods.claim({
    proofA: fixture.proofA, proofB: fixture.proofB, proofC: fixture.proofC,
    publicInputs: fixture.publicInputs, selector,
  })
    .accounts({
      escrow, sender: sender.publicKey, vault: ata(mint, escrow), mint,
      registry, destOwner, destAta: ata(mint, destOwner), payer: relayer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
    .signers([relayer]).rpc();
  console.log("[e2e] claim tx:", sig);

  // 6. 断言终态
  const destAta = await getAccount(conn, ata(mint, destOwner));
  if (destAta.amount.toString() !== "50000000") throw new Error("dest balance mismatch");
  if (await conn.getAccountInfo(escrow)) throw new Error("escrow not closed");
  console.log("[e2e] PASS: 50 USDC delivered to proof-bound dest, escrow closed");

  validator.kill();
  console.log("[e2e] ALL PASS");
}

main().catch((e) => { console.error("[e2e] FAIL:", e); process.exit(1); });
```

- [ ] **Step 2: 补根依赖并运行**

```bash
npm install -D @solana/web3.js@^1.95.0 @coral-xyz/anchor@0.32.1 @solana/spl-token@^0.4.9
npm run e2e
# 前置：circuits/testdata/emails/e2e.eml 就位（48h 时效内）且能访问外网（真实 DNS）
# 期望：全部 [e2e] PASS。出证由 prover 容器（rapidsnark）完成，正常为数秒级，
# 脚本内含 NFR-3 断言（>30s 即失败）；首次运行含 docker 镜像构建时间。
```

- [ ] **Step 3: Commit**

```bash
git add e2e package.json package-lock.json
git commit -m "test: end-to-end script (real .eml -> prover container -> localnet claim)"
```

---

## Task 15: 全量验证与收尾

**Files:**
- Modify: 根 `README.md`（不存在则创建——只写构建/测试命令与目录说明，10 行以内）

- [ ] **Step 1: 冷启动全量验证（模拟新机器）**

```bash
# 从干净 clone 出发的完整命令序列，逐条确认可跑。
# 前置：circuits/testdata/emails/{claim,sweep,e2e}.eml 已按 testdata/emails/README.md 导出（48h 时效内），且可访问外网（真实 DNS）。
npm install && (cd circuits && npm install)
bash circuits/scripts/compile.sh          # 电路编译
cd circuits && npx jest --runInBand && cd ..   # 电路全部单测
bash circuits/scripts/setup.sh            # trusted setup（ptau 已缓存则跳过下载）
(cd circuits && node scripts/gen-vk-rust.mjs && NODE_OPTIONS=--max-old-space-size=16384 npx tsx scripts/make-fixture.ts)
cp circuits/build/verifying_key.rs onchain/programs/email-wallet/src/verifying_key.rs
cd onchain && anchor build && anchor test && cd ..   # 链上全部测试（含真实证明 claim/sweep）
npm run prover:up && curl -s localhost:8080/health && npm run prover:down   # prover 容器自检
npm run e2e                               # 端到端（内部会自动起 prover 容器与验证器）
```

- [ ] **Step 2: 需求核对清单（逐条打勾，发现缺口回到对应 Task 补）**

| Spec 条目 | 落点 |
| --- | --- |
| FR-SND-1 创建托管（v1 仅不可退款） | Task 8（FR-SND-2 的链下 commitment 由 poseidon.ts + e2e 覆盖；FR-SND-4 Relayer 通知=范围外） |
| FR-CLM-5/6 电路五要素 + 原子领取 | Task 4（电路）+ Task 11（链上） |
| FR-RFD-1/2 退款互斥 | **v2 候选，v1 不实现**（Task 9 占位备注） |
| §4.4 托管模式（v1 仅不可退款） | Task 8（单指令；双指令拆分为 v2 候选） |
| FR-INB-1/2/3 Inbox + sweep | Task 12 |
| §7 电路 C1–C11 | Task 3/4（C4 结构性强制、t= 代 Date，均在 Global Constraints 注明） |
| §8 账户结构/指令/安全校验 | Task 7–12 |
| §9 Prover（rapidsnark 集群的单机版） | Task 13（容器化 + HTTP API；多副本排队/集群属生产 Relayer，范围外） |
| NFR-1/2 CU 与交易大小 | Task 11 Step 4（实测 claim CU；如超 150k 记录实际值） |
| NFR-3 证明延迟 < 30s | Task 13 Step 4 + Task 14 e2e 内断言 |
| FR-7/8、FR-9/10、§6.4 兜底、Relayer（邮件收发/代付调度）、Claim Page | **范围外**（本计划不含） |

- [ ] **Step 3: 写 README 并终提交**

`README.md`：目录四段（circuits / prover / onchain / e2e）、上面 Step 1 的命令序列、版本要求（circom 2.1.6、anchor 0.32.1、solana CLI 2.1+、node 20+、docker）。

```bash
git add -A && git commit -m "docs: build/test/e2e runbook"
```
