# Cloudflare Dapp MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 cloudflare-fullstack-starter `minimal` 分支在 `app/` 下构建 Dapp 前端(/send + /claim/:escrow + 无状态 Hono config/health API),并扩展现有 relayer(Gmail SMTP 通知 + IMAP 入站 + 自动 claim),在 Solana devnet 打通"发送→邮件通知→回复→自动兑现"完整闭环。

**Architecture:** 前端直连 devnet RPC 读写链上状态(方案 A),邮箱明文只在浏览器本地加密(x25519 密封盒)与 relayer 解密后走 Gmail,服务器零存储;relayer 为本地 Node 进程,indexer(已有)+ GmailNotifier + inbound(IMAP)+ claimer(出证明+提交 claim)由新入口编排。所有状态从链上重建。

**Tech Stack:** React 19 + Vite + Hono(Cloudflare Workers,@cloudflare/vite-plugin)+ shadcn/ui + @coral-xyz/anchor 0.32 + @solana/wallet-adapter + circomlibjs/tweetnacl;relayer 侧 nodemailer + imapflow + 现有 prover docker(rapidsnark)。

**Spec:** `docs/cloudflare-dapp-mvp-design.md`(本计划的上游设计文档,执行前先读)

## Global Constraints

- **server 零存储**:不引入 Better Auth / D1 / KV / cookie / session;Hono 只保留 `GET /api/config` 与 `GET /api/health`。
- **relay 邮箱**:固定 `penghe1996@gmail.com`(必须与 `circuits/relay.config.json` 的 `relayAddress` 一致,电路已编译绑定;不一致需 `bash circuits/scripts/rebuild.sh`,本计划假设一致)。
- **链上常量**:程序 ID 固定 `9Bk8J1CK23pH6zB5CMNZZvNimTfGeeAaHxopNbjURfBR`(`onchain/programs/email-wallet/src/lib.rs:12`);Escrow 账户大小 286 字节,commitment 偏移 8(`relayer/indexer.ts:17-18`);邮箱密文 ≤137 字节(`onchain/.../state.rs:11`)。
- **Claim 电路公开输入 9 个 field**(`onchain/.../claim.rs:18`),顺序:pubkeyHash, commitment, timestamp, relayer, dest_a, dest_b, domainCommitment, emailNullifier, relayerEmailHash。
- **claim 交易必须走 v0 + ALT**(证明 ≈550B 超过 legacy 1232B 上限),ComputeBudget 400k,重试 3 次(依据 `e2e/e2e.ts:203-264`)。
- **node 20+**;前端代码禁止依赖 Node 专属 API(不用 `Buffer`/`fs`,用 `Uint8Array`/`TextEncoder`)。
- 所有 commit 在 repo 根目录执行;新代码英文标识符 + 中文注释沿用仓库现有风格。

---

### Task 1: 脚手架 — starter minimal 分支落入 `app/`

**Files:**
- Create: `app/`(从 starter minimal 分支复制,约 75 个文件)
- Modify: `package.json`(根,新增脚本)

**Interfaces:**
- Produces: `app/` 独立 npm 工程(`name: zkemail-connect-app`),`npm run dev` 于 :5173 同时服务 React 与 Hono;根脚本 `app:dev`。

- [ ] **Step 1: 复制 starter 文件**

```bash
cd /Users/hepeng/Documents/dev/project/zkemail-connect
git clone --branch minimal --depth 1 https://github.com/claudio-silva/cloudflare-fullstack-starter /tmp/cf-starter
mkdir -p app
cp -R /tmp/cf-starter/. app/
rm -rf app/.git /tmp/cf-starter
```

- [ ] **Step 2: 配置 app 标识**

`app/package.json`:`"name": "cloudflare-fullstack-starter"` → `"name": "zkemail-connect-app"`(cloudflare 发布块整个删除)。

`app/wrangler.json`:`"name": "autotrader"` → `"name": "zkemail-connect-app"`。

- [ ] **Step 3: 安装依赖并添加路由**

```bash
cd app && npm install && npm install react-router-dom@^7
```

- [ ] **Step 4: 精简 App.tsx 为路由壳**

`app/src/react-app/App.tsx` 完整替换为:

```tsx
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./App.css";

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-background text-foreground">
        <Routes>
          <Route path="/" element={<Navigate to="/send" replace />} />
          <Route path="/send" element={<div data-testid="send-page">Send page placeholder</div>} />
          <Route path="/claim/:escrow" element={<div data-testid="claim-page">Claim page placeholder</div>} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
```

- [ ] **Step 5: 根 package.json 增加脚本**

在根 `package.json` 的 `scripts` 中追加(与现有同级):

```json
"app:dev": "npm --prefix app run dev",
"app:build": "npm --prefix app run build",
"app:deploy": "npm --prefix app run deploy",
"relayer:run": "npx tsx relayer/index.ts"
```

- [ ] **Step 6: 验证 dev server**

```bash
npm run app:dev
```

另开终端验证:

```bash
curl -s http://localhost:5173/send | grep -q "Send page placeholder" && echo PAGE_OK
curl -s http://localhost:5173/api/ | grep -q "My name" && echo API_OK
```

Expected: 两行均输出 `*_OK`。验证后停掉 dev server。

- [ ] **Step 7: Commit**

```bash
git add app package.json
git commit -m "feat: cloudflare starter (minimal) 脚手架落入 app/,路由壳 + 根脚本"
```

---

### Task 2: Hono API — `/api/config` + `/api/health`

**Files:**
- Modify: `app/src/worker/index.ts`
- Create: `app/.dev.vars`(本地 worker 环境变量)
- Modify: `app/wrangler.json`(vars 注释占位说明,可选)

**Interfaces:**
- Consumes: Hono `Bindings: Env`。
- Produces(后续 Task 3/4/5 依赖):
  - `GET /api/health` → `{ ok: true }`
  - `GET /api/config` →
    ```json
    {
      "programId": "9Bk8...",
      "rpcUrl": "https://api.devnet.solana.com",
      "relayEmail": "penghe1996@gmail.com",
      "relayX25519Pk": "<64 hex chars>",
      "claimBaseUrl": "http://localhost:5173/claim/",
      "mints": [{ "mint": "<base58>", "symbol": "TST", "decimals": 6 }]
    }
    ```
  - 前端读取 helper(本任务不建,Task 4 建)约定字段名如上(camelCase)。

- [ ] **Step 1: 写失败验证(手动 curl 基线)**

先确认现状:`curl -s http://localhost:5173/api/config` 应 404。记录为基线。

- [ ] **Step 2: 实现 worker**

`app/src/worker/index.ts` 完整替换为:

```ts
import { Hono } from "hono";

export type Env = {
  PROGRAM_ID: string;
  RPC_URL: string;
  RELAYER_EMAIL: string;
  RELAYER_X25519_PK_HEX: string;
  CLAIM_BASE_URL: string;
  MINTS_JSON: string; // [{mint,symbol,decimals}]
};

const app = new Hono<{ Bindings: Env }>();

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/config", (c) => {
  const env = c.env;
  let mints: unknown[] = [];
  try {
    mints = JSON.parse(env.MINTS_JSON || "[]");
  } catch {
    mints = [];
  }
  return c.json({
    programId: env.PROGRAM_ID,
    rpcUrl: env.RPC_URL,
    relayEmail: env.RELAYER_EMAIL,
    relayX25519Pk: env.RELAYER_X25519_PK_HEX,
    claimBaseUrl: env.CLAIM_BASE_URL,
    mints,
  });
});

export default app;
```

- [ ] **Step 3: 本地环境变量**

创建 `app/.dev.vars`(勿提交,先加进 `app/.gitignore`;`.gitignore` 若无 `.dev.vars` 行则追加):

```
PROGRAM_ID=9Bk8J1CK23pH6zB5CMNZZvNimTfGeeAaHxopNbjURfBR
RPC_URL=https://api.devnet.solana.com
RELAYER_EMAIL=penghe1996@gmail.com
RELAYER_X25519_PK_HEX=<执行 relayer/indexer 时用的 x25519 公钥 hex,Task 11 生成;Task 2 验证期可填 64 个 0 占位>
CLAIM_BASE_URL=http://localhost:5173/claim/
MINTS_JSON=[]
```

- [ ] **Step 4: 验证**

```bash
npm run app:dev
```

```bash
curl -s http://localhost:5173/api/health
# Expected: {"ok":true}
curl -s http://localhost:5173/api/config | python3 -m json.tool | head -8
# Expected: 上表字段全部存在,relayEmail=penghe1996@gmail.com
```

- [ ] **Step 5: Commit**

```bash
git add app/src/worker/index.ts app/.gitignore
git commit -m "feat: /api/config + /api/health 无状态配置端点"
```

---

### Task 3: 前端链上加密库 `app/src/lib/zkCrypto.ts` + 一致性校验

**Files:**
- Create: `app/src/lib/zkCrypto.ts`
- Create: `app/scripts/crypto-parity.ts`
- Modify: `app/package.json`(scripts 加 `crypto-parity`)

**Interfaces:**
- Produces(后续全部前端任务依赖):
  - `computeCommitment(email: string): Promise<bigint>` — Poseidon(trim+lowercase(email), 341B 填充,与 `circuits/scripts/poseidon.ts` 同构)
  - `computeDomainCommitment(domain: string): Promise<bigint>`
  - `fieldToBE32(v: bigint): Uint8Array` — 32 字节大端
  - `sealEmailForRelayer(email: string, relayerPk: Uint8Array): Uint8Array` — version1 密封盒,输出 57+plaintext+16 字节,≤137
  - `relayerToField(pk: Uint8Array): bigint`
  - `DEST_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/`

- [ ] **Step 1: 实现库**

`app/src/lib/zkCrypto.ts`:

```ts
// 与 circuits/scripts/poseidon.ts + relayer/crypto.ts 同构的浏览器安全实现(纯 Uint8Array,无 Buffer)。
import { buildPoseidon } from "circomlibjs";
import nacl from "tweetnacl";

const FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const EMAIL_PADDED_LEN = 341;
export const DOMAIN_PADDED_LEN = 124;
export const DEST_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const MAX_CIPHER_LEN = 137;

let poseidonPromise: Promise<any> | null = null;
function getPoseidon() {
  if (!poseidonPromise) poseidonPromise = buildPoseidon();
  return poseidonPromise;
}

export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const p = await getPoseidon();
  return BigInt(p.F.toString(p(inputs)));
}

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

export function fieldToBE32(v: bigint): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

export function relayerToField(pk: Uint8Array): bigint {
  let v = 0n;
  for (const b of pk) v = (v << 8n) | BigInt(b);
  return v % FR;
}

const CIPHER_VERSION = 1;
const HEADER_LEN = 1 + 32 + 24;

/** blob = version(1) || eph_x25519_pk(32) || nonce(24) || XSalsa20-Poly1305 密文 */
export function sealEmailForRelayer(email: string, relayerPk: Uint8Array): Uint8Array {
  const plaintext = new TextEncoder().encode(email);
  if (plaintext.length > 64) throw new Error("email too long (max 64 bytes)");
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);
  const box = nacl.box(plaintext, nonce, relayerPk, eph.secretKey);
  if (!box) throw new Error("seal failed");
  const blob = new Uint8Array(HEADER_LEN + box.length);
  blob[0] = CIPHER_VERSION;
  blob.set(eph.publicKey, 1);
  blob.set(nonce, 33);
  blob.set(box, HEADER_LEN);
  if (blob.length > MAX_CIPHER_LEN) throw new Error("cipher too long");
  return blob;
}
```

- [ ] **Step 2: 一致性校验脚本**

`app/scripts/crypto-parity.ts`(用 tsx 跑,对比 circuits 与 app 两份实现):

```ts
// 校验 app/src/lib/zkCrypto.ts 与 circuits/scripts/poseidon.ts 输出一致(防实现漂移)。
import { computeCommitment as refCommitment } from "../../circuits/scripts/poseidon";
import { sealEmailForRelayer as refSeal } from "../../relayer/crypto";
import { computeCommitment, sealEmailForRelayer, fieldToBE32 } from "../src/lib/zkCrypto";
import nacl from "tweetnacl";

async function main() {
  const email = "Recipient.User+tag@Example.COM ";
  const mine = await computeCommitment(email);
  const ref = await refCommitment(email);
  if (mine !== ref) throw new Error(`commitment mismatch: ${mine} != ${ref}`);
  const kp = nacl.box.keyPair();
  const a = sealEmailForRelayer("a@b.com", kp.publicKey);
  const b = refSeal("a@b.com", kp.publicKey);
  if (a.length !== b.length) throw new Error("cipher len mismatch");
  // 非确定性加密(随机 ephemeral),只需长度/版本一致 + 可解密
  const opened = nacl.box.open(a.slice(57), a.subarray(33, 57), a.subarray(1, 33), kp.secretKey);
  if (!opened || new TextDecoder().decode(opened) !== "a@b.com") throw new Error("decrypt failed");
  if (fieldToBE32(256n)[31] !== 1) throw new Error("fieldToBE32 wrong");
  console.log("PARITY OK");
}
main().catch((e) => { console.error(e); process.exit(1); });
```

`app/package.json` scripts 追加:`"crypto-parity": "tsx ../node_modules/.bin/../tsx ..."` —— 简化为根脚本。根 `package.json` 追加:

```json
"crypto-parity": "cd app && npx tsx scripts/crypto-parity.ts"
```

(`tsx` 由根 node_modules 提供;app 内不重复装。)

- [ ] **Step 3: 安装依赖**

```bash
cd app && npm install circomlibjs@^0.1.7 tweetnacl@^1.0.3
```

- [ ] **Step 4: 运行校验**

```bash
npm run crypto-parity
```

Expected: 输出 `PARITY OK`。

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/zkCrypto.ts app/scripts/crypto-parity.ts app/package.json package.json
git commit -m "feat: 前端浏览器安全 zkCrypto 库 + 与 circuits 实现的一致性校验"
```

---

### Task 4: Solana 连接 / 钱包 / Program 上下文

**Files:**
- Create: `app/src/idl/email_wallet.json`(从 `onchain/target/idl/` 复制)
- Create: `app/src/lib/solana.tsx`(providers + hooks)
- Modify: `app/src/react-app/main.tsx`(包 providers)
- Modify: `app/package.json`(依赖)

**Interfaces:**
- Consumes: `/api/config`(Task 2)、`zkCrypto.ts`(Task 3)。
- Produces:
  - `<SolanaProviders>{children}</SolanaProviders>`(main.tsx 使用)
  - `useAppConfig(): { programId: PublicKey; rpcUrl: string; relayEmail: string; relayX25519Pk: Uint8Array; claimBaseUrl: string; mints: { mint: string; symbol: string; decimals: number }[] } | null`
  - `useEmailWalletProgram(): Program | null`(已绑钱包与 connection 的 anchor Program;未连钱包时返回基于匿名 wallet 的只读 Program —— claim 页查询需要)
  - IDL JSON 位于 `app/src/idl/email_wallet.json`,import 路径 `"../idl/email_wallet.json"`(相对 lib/solana.tsx)。

- [ ] **Step 1: 生成 IDL 并复制**

```bash
export PATH="$HOME/.avm/bin:$PATH"
(cd onchain && anchor build)
cp onchain/target/idl/email_wallet.json app/src/idl/email_wallet.json
```

Expected: 文件存在且含 `"name": "email_wallet"` 与 `createEscrow` 指令。

- [ ] **Step 2: 安装依赖**

```bash
cd app && npm install @coral-xyz/anchor@^0.32.1 @solana/web3.js@^1.99.0 @solana/spl-token@^0.4.15 \
  @solana/wallet-adapter-base @solana/wallet-adapter-react @solana/wallet-adapter-wallets \
  @solana/wallet-adapter-react-ui buffer
```

说明:`buffer` 用于 `@coral-xyz/anchor` 在浏览器里的 Buffer 依赖(main.tsx 打全局补丁)。若 npm 报 React 19 peer 冲突,加 `--legacy-peer-deps` 并在 README 记录。

- [ ] **Step 3: providers + hooks**

`app/src/lib/solana.tsx`:

```tsx
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { ConnectionProvider, WalletProvider, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter, OKXWalletAdapter } from "@solana/wallet-adapter-wallets";
import idl from "../idl/email_wallet.json";

// anchor 依赖 Buffer(浏览器无内置)
import { Buffer } from "buffer";
if (!(globalThis as any).Buffer) (globalThis as any).Buffer = Buffer;

export type AppConfig = {
  programId: PublicKey;
  rpcUrl: string;
  relayEmail: string;
  relayX25519Pk: Uint8Array;
  claimBaseUrl: string;
  mints: { mint: string; symbol: string; decimals: number }[];
};

const AppConfigContext = createContext<AppConfig | null>(null);
export const useAppConfig = () => useContext(AppConfigContext);

export function SolanaProviders({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter(), new OKXWalletAdapter()],
    []
  );
  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((j) =>
        setConfig({
          programId: new PublicKey(j.programId),
          rpcUrl: j.rpcUrl,
          relayEmail: j.relayEmail,
          relayX25519Pk: new Uint8Array(j.relayX25519Pk.match(/.{2}/g).map((h: string) => parseInt(h, 16))),
          claimBaseUrl: j.claimBaseUrl,
          mints: j.mints ?? [],
        })
      )
      .catch((e) => console.error("config fetch failed", e));
  }, []);
  if (!config) return <div className="p-8 text-center text-muted-foreground">loading config…</div>;
  return (
    <AppConfigContext.Provider value={config}>
      <ConnectionProvider endpoint={config.rpcUrl}>
        <WalletProvider wallets={wallets} autoConnect>
          <WalletModalProvider>{children}</WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </AppConfigContext.Provider>
  );
}

/** 只读 Program(claim 页未连钱包也可用)与签名 Program(连钱包后)统一入口。 */
export function useEmailWalletProgram(): Program | null {
  const config = useAppConfig();
  const { connection } = useConnection();
  const wallet = useWallet();
  return useMemo(() => {
    if (!config) return null;
    const signer = wallet.wallet?.adapter ?? ({} as never);
    const provider = new AnchorProvider(connection, signer as any, { commitment: "confirmed" });
    return new Program(idl as any, provider);
  }, [config, connection, wallet.wallet]);
}
```

`app/src/react-app/main.tsx` 在 `<App />` 外包 `<SolanaProviders>`;`App.css` 顶部加 `@import "@solana/wallet-adapter-react-ui/styles.css";`。

- [ ] **Step 4: 类型与构建验证**

```bash
cd app && npm run build
```

Expected: `tsc -b && vite build` 成功。若 `useWallet()` 空钱包时 adapter 为 `{}` 导致类型报错,在 `as any` 已覆盖;若运行时报 `wallet.signTransaction is not a function`(未连接钱包却发交易属预期;只读 fetch 不触发)。

- [ ] **Step 5: 冒烟验证**

```bash
npm run app:dev
```

浏览器开 http://localhost:5173/claim/9Bk8J1CK23pH6zB5CMNZZvNimTfGeeAaHxopNbjURfBR —— 应显示 claim 占位页(尚未实现 Task 6,仅验证 providers 不白屏)。终端无红色报错。

- [ ] **Step 6: Commit**

```bash
git add app/src/idl app/src/lib/solana.tsx app/src/react-app/main.tsx app/package.json app/package-lock.json
git commit -m "feat: Solana 连接/钱包/anchor Program 上下文与 /api/config 接线"
```

---

### Task 5: `/send` 页面 — 连接钱包 + 表单 + create_escrow + 已发送列表

**Files:**
- Create: `app/src/react-app/pages/SendPage.tsx`
- Modify: `app/src/react-app/App.tsx`(挂路由)

**Interfaces:**
- Consumes: `useAppConfig`, `useEmailWalletProgram`(Task 4);`computeCommitment`, `fieldToBE32`, `sealEmailForRelayer`(Task 3)。
- Produces: 路由 `/send` 渲染本页(Task 1 占位替换)。claim 链接 = `claimBaseUrl + escrowBase58`。

- [ ] **Step 1: 实现页面**

`app/src/react-app/pages/SendPage.tsx`(完整文件;UI 用 starter 已有 button/input/label/card 组件):

```tsx
import { useCallback, useEffect, useState } from "react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useConnection, useWallet, WalletMultiButton } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import { useAppConfig, useEmailWalletProgram } from "@/lib/solana";
import { computeCommitment, fieldToBE32, sealEmailForRelayer } from "@/lib/zkCrypto";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type MyEscrow = { addr: PublicKey; mint: PublicKey; amount: bigint; commitment: number[] };

export default function SendPage() {
  const config = useAppConfig();
  const program = useEmailWalletProgram();
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const [email, setEmail] = useState("");
  const [mintIdx, setMintIdx] = useState(0);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ escrow: string; claimUrl: string } | null>(null);
  const [mine, setMine] = useState<MyEscrow[]>([]);

  const refreshMine = useCallback(async () => {
    if (!program || !publicKey || !config) return;
    // 无 DB:全量拉取后按 sender 过滤(devnet 账户数少,MVP 可接受)
    const all = await (program.account as any).escrow.all();
    setMine(
      all
        .filter((e: any) => (e.account.sender as PublicKey).equals(publicKey))
        .map((e: any) => ({
          addr: e.publicKey,
          mint: e.account.mint,
          amount: BigInt(e.account.amount.toString()),
          commitment: Array.from(e.account.commitment),
        }))
    );
  }, [program, publicKey, config]);

  useEffect(() => { refreshMine().catch(console.error); }, [refreshMine]);

  if (!config || !program) return null;
  const mint = config.mints[mintIdx] ?? config.mints[0];

  const submit = async () => {
    if (!publicKey || !mint) return;
    setBusy(true); setError(null); setDone(null);
    try {
      const trimmed = email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) throw new Error("invalid email");
      const commitment = await computeCommitment(trimmed);
      const commitmentBytes = fieldToBE32(commitment);
      const cipher = sealEmailForRelayer(trimmed, config.relayX25519Pk);
      const relayerEmailHash = fieldToBE32(await computeCommitment(config.relayEmail));
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), Buffer.from(commitmentBytes), publicKey.toBuffer()],
        config.programId
      );
      const [protocolPda] = PublicKey.findProgramAddressSync([Buffer.from("protocol")], config.programId);
      const [relayerEntryPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("relayer"), Buffer.from(relayerEmailHash)],
        config.programId
      );
      const protocol = await (program.account as any).protocolConfig.fetchNullable(protocolPda);
      if (!protocol) throw new Error("protocol not initialized on this cluster");
      const mintPk = new PublicKey(mint.mint);
      const vault = getAssociatedTokenAddressSync(mintPk, escrowPda);
      const senderAta = getAssociatedTokenAddressSync(mintPk, publicKey);
      const decimals = mint.decimals;
      const raw = BigInt(Math.round(parseFloat(amount) * 10 ** decimals));
      if (raw <= 0n) throw new Error("invalid amount");
      const sig = await (program.methods as any)
        .createEscrow(Array.from(commitmentBytes), new BN(raw.toString()), Array.from(cipher), Array.from(relayerEmailHash))
        .accounts({
          escrow: escrowPda,
          vault,
          mint: mintPk,
          senderAta,
          sender: publicKey,
          config: protocolPda,
          treasury: protocol.treasury,
          relayerEntry: relayerEntryPda,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      const claimUrl = config.claimBaseUrl + escrowPda.toBase58();
      setDone({ escrow: escrowPda.toBase58(), claimUrl });
      await connection.confirmTransaction(sig, "confirmed");
      await refreshMine();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="container mx-auto max-w-xl px-4 py-8 space-y-6">
      <h1 className="text-2xl font-bold">Send tokens to an email</h1>
      <Card>
        <CardHeader>
          <CardTitle>New transfer</CardTitle>
          <CardDescription>
            发送后不可撤回。接收方无需有钱包,凭邮箱回复即可领取。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex justify-end"><WalletMultiButton /></div>
          <div className="space-y-2">
            <Label htmlFor="email">Recipient email</Label>
            <Input id="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="friend@gmail.com" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mint">Token</Label>
            <select id="mint" className="w-full border rounded p-2 bg-background" value={mintIdx} onChange={(e) => setMintIdx(Number(e.target.value))}>
              {config.mints.map((m, i) => (
                <option key={m.mint} value={i}>{m.symbol} ({m.mint.slice(0, 8)}…)</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="amount">Amount</Label>
            <Input id="amount" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="10" />
          </div>
          <Button className="w-full" disabled={!publicKey || busy || !mint} onClick={submit}>
            {busy ? "Sending…" : publicKey ? "Send (irreversible)" : "Connect wallet first"}
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {done && (
            <div className="text-sm space-y-1 border rounded p-3">
              <p>Escrow: <code className="break-all">{done.escrow}</code></p>
              <p>Claim link: <a className="underline break-all" href={done.claimUrl} target="_blank" rel="noreferrer">{done.claimUrl}</a></p>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>My escrows</CardTitle>
          <CardDescription>状态实时来自链上。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {mine.length === 0 && <p className="text-muted-foreground">none yet</p>}
          {mine.map((e) => (
            <div key={e.addr.toBase58()} className="flex justify-between border-b pb-2">
              <span>{(Number(e.amount) / 10 ** (mint?.decimals ?? 0)).toString()} {mint?.symbol}</span>
              <a className="underline" href={config.claimBaseUrl + e.addr.toBase58()} target="_blank" rel="noreferrer">
                pending → claim page
              </a>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: 挂路由**

`app/src/react-app/App.tsx`:`/send` 占位元素替换为 `<SendPage />`(顶部 `import SendPage from "./pages/SendPage";`)。

- [ ] **Step 3: 构建验证**

```bash
cd app && npm run build
```

Expected: 构建通过。

- [ ] **Step 4: 手动验证(devnet 真实交易,Task 11 初始化完成后执行)**

前置:Task 11 已完成(devnet 已部署+初始化+config 有 mint)。步骤:
1. `npm run app:dev`,Phantom 切到 devnet,领 faucet。
2. 填表单发送 → 钱包弹签(2 条指令:手续费 + createEscrow)→ 成功显示 escrow 与 claim 链接。
3. "My escrows" 出现 pending 行。
   若 devnet 未初始化,应看到明确报错 "protocol not initialized"——此时本步留到 Task 11 后复测。

- [ ] **Step 5: Commit**

```bash
git add app/src/react-app/pages/SendPage.tsx app/src/react-app/App.tsx
git commit -m "feat: /send 页面(钱包连接 + 表单 + create_escrow + 链上已发送列表)"
```

---

### Task 6: `/claim/:escrow` 页面 — 读链 + 粘贴地址 + mailto + 轮询

**Files:**
- Create: `app/src/react-app/pages/ClaimPage.tsx`
- Modify: `app/src/react-app/App.tsx`(挂路由)

**Interfaces:**
- Consumes: `useAppConfig`, `useEmailWalletProgram`, `DEST_RE`(Task 3/4)。
- Produces: 路由 `/claim/:escrow` 渲染本页;mailto 链接格式 `mailto:{relayEmail}?subject={dest}`。

- [ ] **Step 1: 实现页面**

`app/src/react-app/pages/ClaimPage.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useParams } from "react-router-dom";
import { useConnection } from "@solana/wallet-adapter-react";
import { useAppConfig, useEmailWalletProgram } from "@/lib/solana";
import { DEST_RE } from "@/lib/zkCrypto";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type EscrowState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "open"; amount: bigint; mint: PublicKey }
  | { kind: "claimed" };

export default function ClaimPage() {
  const { escrow } = useParams();
  const config = useAppConfig();
  const program = useEmailWalletProgram();
  const { connection } = useConnection();
  const [state, setState] = useState<EscrowState>({ kind: "loading" });
  const [dest, setDest] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (!program || !escrow) return;
    try {
      const pk = new PublicKey(escrow);
      const acc = await (program.account as any).escrow.fetchNullable(pk);
      if (!acc) setState({ kind: "claimed" });
      else setState({ kind: "open", amount: BigInt(acc.amount.toString()), mint: acc.mint });
    } catch (e: any) {
      setState({ kind: "missing" });
    }
  }, [program, escrow]);

  useEffect(() => {
    refresh();
    // 领取后轮询:5s 一次,最多 30 次(150s),之后提示手动刷新
    timer.current = setInterval(() => refresh(), 5000);
    const stop = setTimeout(() => { if (timer.current) clearInterval(timer.current); }, 150_000);
    return () => { if (timer.current) clearInterval(timer.current); clearTimeout(stop); };
  }, [refresh]);

  if (!config) return null;
  const mintMeta = config.mints.find((m) => state.kind === "open" && m.mint === state.mint.toBase58());
  const destOk = DEST_RE.test(dest.trim());
  const mailto = `mailto:${config.relayEmail}?subject=${encodeURIComponent(dest.trim())}`;

  return (
    <div className="container mx-auto max-w-xl px-4 py-8 space-y-6">
      <h1 className="text-2xl font-bold">Claim your tokens</h1>
      {state.kind === "loading" && <p>loading…</p>}
      {state.kind === "missing" && <p className="text-destructive">invalid escrow address</p>}
      {state.kind === "claimed" && (
        <Card><CardContent className="pt-6">✅ This transfer has been claimed (escrow closed on-chain).</CardContent></Card>
      )}
      {state.kind === "open" && (
        <Card>
          <CardHeader>
            <CardTitle>
              You received {mintMeta ? (Number(state.amount) / 10 ** mintMeta.decimals).toString() : state.amount.toString()} {mintMeta?.symbol ?? ""}
            </CardTitle>
            <CardDescription>Reply by email to claim — no wallet needed for the reply, only a receiving address.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="dest">Your Solana receiving address</Label>
              <Input id="dest" value={dest} onChange={(e) => { setDest(e.target.value); setConfirmed(false); }} placeholder="base58 address" />
              {!destOk && dest.length > 0 && <p className="text-sm text-destructive">invalid base58 address (32–44 chars)</p>}
            </div>
            {destOk && !confirmed && (
              <div className="border rounded p-3 text-sm space-y-2">
                <p>Confirm receiving address:</p>
                <p className="break-all"><code>{dest.trim()}</code></p>
                <Button size="sm" onClick={() => setConfirmed(true)}>Confirm</Button>
              </div>
            )}
            {destOk && confirmed && (
              <div className="space-y-2">
                <Button className="w-full" asChild>
                  <a href={mailto}>Send claim email</a>
                </Button>
                <p className="text-sm text-muted-foreground">
                  Your mail app opens with recipient and subject (= your address) pre-filled.
                  Body can stay empty — just hit send. This page will update once the relayer processes your reply.
                </p>
              </div>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 挂路由**

`App.tsx`:`/claim/:escrow` 占位替换为 `<ClaimPage />`。

- [ ] **Step 3: 构建验证**

```bash
cd app && npm run build
```

Expected: 通过(`noUnusedLocals` 严格,未用 import 会报错,注意清理)。

- [ ] **Step 4: 手动验证**

1. `npm run app:dev`,访问 `/claim/9Bk8J1CK23pH6zB5CMNZZvNimTfGeeAaHxopNbjURfBR`(任意合法公钥,非 escrow)→ 显示 "invalid escrow address" 之外的 open 态前应先 `fetchNullable` 返回 null → 显示 claimed 文案(非 escrow 账户解码可能抛错 → missing)。两种文案出现其一即证明 RPC 读取通路正常。
2. 用 Task 5 创建的真实 escrow 地址访问 → 显示金额;粘贴合法地址 → confirm → mailto 链接渲染为 `mailto:penghe1996@gmail.com?subject=<addr>`。

- [ ] **Step 5: Commit**

```bash
git add app/src/react-app/pages/ClaimPage.tsx app/src/react-app/App.tsx
git commit -m "feat: /claim/:escrow 页面(链上读取 + mailto 一键发信 + 到账轮询)"
```

---

### Task 7: Relayer — `GmailNotifier`(Gmail SMTP 出站)

**Files:**
- Modify: `relayer/notify.ts`
- Modify: `package.json`(根,依赖 nodemailer)
- Test: `relayer/tests/notify.test.ts`

**Interfaces:**
- Consumes: `Notifier` 接口(已有,`relayer/notify.ts:8-10`)。
- Produces:
  - `class GmailNotifier implements Notifier` — 构造 `(opts: { user: string; pass: string; fromName?: string })`;`notify(to, payload)` 经 smtp.gmail.com:465 发送。
  - 邮件规范:`From: Token Airdrop <user>`、`Reply-To: user`(= relay 地址,回复即入站)、Subject `You received {amount} tokens — reply to claim`、正文含 claimUrl 与防钓鱼提示。

- [ ] **Step 1: 写失败测试**

创建 `relayer/tests/notify.test.ts`:

```ts
import nodemailer from "nodemailer";
import { GmailNotifier } from "../notify";

jest.mock("nodemailer");

const sendMail = jest.fn().mockResolvedValue({ messageId: "x" });
(nodemailer.createTransport as jest.Mock).mockReturnValue({ sendMail });

describe("GmailNotifier", () => {
  it("sends notification with Reply-To = relay address and claim url in body", async () => {
    const n = new GmailNotifier({ user: "penghe1996@gmail.com", pass: "app-pass" });
    await n.notify("friend@gmail.com", {
      escrow: "EscrowAddr111111111111111111111111111111",
      sender: "SenderAddr22222222222222222222222222222",
      amount: "50000000",
      claimUrl: "http://localhost:5173/claim/EscrowAddr111111111111111111111111111111",
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.from).toContain("penghe1996@gmail.com");
    expect(mail.replyTo).toBe("penghe1996@gmail.com");
    expect(mail.to).toBe("friend@gmail.com");
    expect(mail.text).toContain("50000000");
    expect(mail.text).toContain("http://localhost:5173/claim/EscrowAddr");
    expect(mail.subject).toMatch(/^You received /);
  });

  it("creates SSL transport to gmail", () => {
    new GmailNotifier({ user: "u@gmail.com", pass: "p" });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "smtp.gmail.com", port: 465, secure: true })
    );
  });
});
```

- [ ] **Step 2: 运行验证失败**

```bash
npx jest relayer/tests/notify.test.ts
```

Expected: FAIL(`GmailNotifier` 不存在)。注意:根 package.json 无 jest 配置—— circuits 有独立 jest。根测试用 circuits 的 preset?更简单:本测试放在 circuits 的 jest 外会有配置问题。**决策:relayer 测试统一放到 `circuits/tests/relayer/` 目录下复用其 jest 配置**(ts-jest,testEnvironment node),import 路径 `../../relayer/notify`。修正测试文件位置为 `circuits/tests/relayer/notify.test.ts`(import `../../../relayer/notify`),运行:

```bash
cd circuits && npx jest tests/relayer/notify.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现**

根 `package.json` dependencies 追加 `"nodemailer": "^6.9.16"`(devDependencies 追加 `"@types/nodemailer": "^6.4.17"`),`npm install`。

`relayer/notify.ts` 追加:

```ts
import nodemailer, { Transporter } from "nodemailer";

export interface GmailNotifierOpts {
  user: string;      // 个人 Gmail 地址(= relay 地址)
  pass: string;      // Gmail app password(16 位)
  fromName?: string; // 展示名,默认 "Token Airdrop"
}

/** Gmail SMTP 出站通知。Reply-To 固定为 relay 地址:接收方点"回复"即进入 relayer 收件箱。 */
export class GmailNotifier implements Notifier {
  private tx: Transporter;
  private from: string;
  constructor(opts: GmailNotifierOpts) {
    this.tx = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: opts.user, pass: opts.pass },
    });
    this.from = `${opts.fromName ?? "Token Airdrop"} <${opts.user}>`;
  }

  async notify(to: string, p: NotifyPayload): Promise<void> {
    const subject = `You received ${p.amount} tokens — reply to claim`;
    const text = [
      `Hi,`,
      ``,
      `Someone sent you ${p.amount} tokens on Solana.`,
      ``,
      `To claim it:`,
      `1. Open your claim page: ${p.claimUrl}`,
      `2. Paste your Solana receiving address.`,
      `3. Tap "Send claim email" — your mail app opens with everything pre-filled. Just hit send.`,
      ``,
      `Security: only trust emails from ${p.claimUrl.split("/claim/")[0]}. We never ask for your seed phrase.`,
    ].join("\n");
    await this.tx.sendMail({
      from: this.from,
      to,
      replyTo: opts_user(this.from), // 见下:实现时直接保存 opts.user
      subject,
      text,
      html: `<p>Someone sent you <b>${p.amount}</b> tokens on Solana.</p>
             <p><a href="${p.claimUrl}">Open claim page</a>, paste your Solana address, then tap "Send claim email".</p>
             <p style="color:#888">We never ask for your seed phrase.</p>`,
    });
  }
}
```

实现修正:`constructor` 里保存 `private relayEmail = opts.user;`,`replyTo: this.relayEmail`。(计划中的伪行 `opts_user(...)` 是实现时禁止遗留的标记,正确形态即 `replyTo: this.relayEmail`。)

- [ ] **Step 4: 运行验证通过**

```bash
cd circuits && npx jest tests/relayer/notify.test.ts
```

Expected: PASS(2 tests)。

- [ ] **Step 5: Commit**

```bash
git package.json package-lock.json relayer/notify.ts circuits/tests/relayer/notify.test.ts 2>/dev/null || true
git add package.json package-lock.json relayer/notify.ts circuits/tests/relayer/notify.test.ts
git commit -m "feat: relayer GmailNotifier(SMTP 出站通知)"
```

---

### Task 8: Relayer — `inbound.ts`(Gmail IMAP 入站)

**Files:**
- Create: `relayer/inbound.ts`
- Test: `circuits/tests/relayer/inbound.test.ts`
- Modify: `package.json`(根,依赖 imapflow、@zk-email/helpers 不需要——from/subject 用正则自解析)

**Interfaces:**
- Consumes: `Notifier`(引导回信用 GmailNotifier,Task 7)、`computeCommitment`/`fieldToBE32`(`circuits/scripts/poseidon.ts`)、`DEST_RE` 语义(`relayer` 侧自定同款正则)。
- Produces:
  - `interface InboundDeps { connection: Connection; programId: PublicKey; notifier: Notifier; onClaimable: (m: ClaimableMail) => Promise<void>; pollMs?: number; }`
  - `interface ClaimableMail { emlPath: string; fromEmail: string; dest: string; escrow: PublicKey }`
  - `async function runInbound(deps: InboundDeps, client: ImapFlowLike): Promise<void>` — 不返回(长驻循环;单测里用可控假 client 只跑一轮)。
  - `function extractFromAndSubject(raw: Buffer): { fromEmail: string; subject: string } | null`
  - `async function findOpenEscrow(connection, programId, commitment: Uint8Array): Promise<PublicKey | null>` — getProgramAccounts dataSize=286 + memcmp(offset 8),取第一个。

- [ ] **Step 1: 写失败测试**

`circuits/tests/relayer/inbound.test.ts`:

```ts
import { extractFromAndSubject, findOpenEscrow } from "../../../relayer/inbound";
import { Connection, PublicKey } from "@solana/web3.js";

describe("extractFromAndSubject", () => {
  it("parses folded headers and addr-spec", () => {
    const raw = Buffer.from(
      "From: Bob Example <bob@Gmail.com>\r\n" +
      "To: penghe1996@gmail.com\r\n" +
      "Subject: 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb8ySdfgz1\r\n" +
      "\r\nbody"
    );
    const r = extractFromAndSubject(raw);
    expect(r).not.toBeNull();
    expect(r!.fromEmail).toBe("bob@gmail.com");
    expect(r!.subject).toBe("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb8ySdfgz1");
  });
  it("unfolds subject continuation lines", () => {
    const raw = Buffer.from("From: a@b.com\r\nSubject: Abc\r\n  Def\r\n\r\n");
    expect(extractFromAndSubject(raw)!.subject).toBe("Abc Def");
  });
  it("rejects missing headers", () => {
    expect(extractFromAndSubject(Buffer.from("Subject: x\r\n\r\n"))).toBeNull();
  });
});

describe("findOpenEscrow", () => {
  it("queries with size+memcmp filters and returns first", async () => {
    const escrow = new PublicKey("9Bk8J1CK23pH6zB5CMNZZvNimTfGeeAaHxopNbjURfBR");
    const conn = {
      getProgramAccounts: jest.fn().mockResolvedValue([{ pubkey: escrow }]),
    } as unknown as Connection;
    const got = await findOpenEscrow(conn, new PublicKey("9Bk8J1CK23pH6zB5CMNZZvNimTfGeeAaHxopNbjURfBR"), new Uint8Array(32));
    expect(got).toEqual(escrow);
    const filters = (conn.getProgramAccounts as jest.Mock).mock.calls[0][1].filters;
    expect(filters[0]).toEqual({ dataSize: 286 });
    expect(filters[1].memcmp.offset).toBe(8);
  });
});
```

- [ ] **Step 2: 运行验证失败**

```bash
cd circuits && npx jest tests/relayer/inbound.test.ts
```

Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**

根 `package.json` dependencies 追加 `"imapflow": "^1.0.179"`,`npm install`。

`relayer/inbound.ts`:

```ts
// relayer 入站:IMAP 轮询 Gmail 收件箱 → 解析回复邮件 → 定位开放托管 → 交给 claimer。
// 已处理判定:成功处理加 \Seen(Gmail 不再返回于 UNSEEN 查询);失败保持 UNSEEN 下轮重试。
// 重启无内存状态时,链上 nullifier 拒绝重复 claim(幂等兜底)。
import fs from "fs";
import os from "os";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { ImapFlow } from "imapflow";
import bs58 from "bs58"; // @solana/web3.js 已传递依赖;若 import 失败则在根 package.json 显式加 "bs58"
import { computeCommitment } from "../circuits/scripts/poseidon";
import { Notifier } from "./notify";

const DEST = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const ESCROW_SIZE = 286;
export const COMMITMENT_OFFSET = 8;

export interface ClaimableMail {
  emlPath: string;
  fromEmail: string;
  dest: string;
  escrow: PublicKey;
}

export interface InboundDeps {
  connection: Connection;
  programId: PublicKey;
  notifier: Notifier;
  onClaimable: (m: ClaimableMail) => Promise<void>;
  pollMs?: number;
}

/** 解析裸 .eml 的 From(addr-spec)与 Subject(含折叠展开、大小写归一)。 */
export function extractFromAndSubject(raw: Buffer): { fromEmail: string; subject: string } | null {
  const headerEnd = raw.indexOf("\r\n\r\n");
  const header = (headerEnd === -1 ? raw.toString("utf8") : raw.subarray(0, headerEnd).toString("utf8"));
  const unfolded = header.replace(/\r\n[ \t]+/g, " ");
  const fromMatch = unfolded.match(/^from:\s*(.+)$/im);
  const subjectMatch = unfolded.match(/^subject:\s*(.*)$/im);
  if (!fromMatch || !subjectMatch) return null;
  const addr = fromMatch[1].match(/<([^>]+)>/)?.[1] ?? fromMatch[1].trim();
  const email = addr.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return { fromEmail: email, subject: subjectMatch[1].trim() };
}

/** 按 commitment 找开放托管:dataSize=286 + memcmp(offset 8)。同一邮箱多笔时取第一个(最早)。 */
export async function findOpenEscrow(
  connection: Connection, programId: PublicKey, commitment32: Uint8Array
): Promise<PublicKey | null> {
  const accounts = await connection.getProgramAccounts(programId, {
    filters: [
      { dataSize: ESCROW_SIZE },
      { memcmp: { offset: COMMITMENT_OFFSET, bytes: bs58.encode(commitment32) } },
    ],
  });
  return accounts.length > 0 ? accounts[0].pubkey : null;
}

export interface ImapFlowLike {
  connect(): Promise<void>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  fetchOne(range: string, query: object, opts?: object): Promise<any>;
  messageFlagsAdd(range: string, flags: string[], opts?: object): Promise<any>;
  search(query: object): Promise<number[]>;
  logout(): Promise<void>;
}

async function handleOne(
  deps: InboundDeps, uid: number, raw: Buffer, tmpDir: string
): Promise<"claimed" | "ignored"> {
  const parsed = extractFromAndSubject(raw);
  if (!parsed) return "ignored";
  const subject = parsed.subject;
  if (!DEST.test(subject)) {
    console.log(`[inbound] uid=${uid} subject not a base58 address, sending guidance`);
    await deps.notifier.notify(parsed.fromEmail, {
      escrow: "", sender: "", amount: "",
      claimUrl: process.env.CLAIM_BASE_URL ?? "http://localhost:5173/claim/",
    });
    return "ignored";
  }
  const commitment = await computeCommitment(parsed.fromEmail);
  const c32 = new Uint8Array(32);
  let v = commitment;
  for (let i = 31; i >= 0; i--) { c32[i] = Number(v & 0xffn); v >>= 8n; }
  const escrow = await findOpenEscrow(deps.connection, deps.programId, c32);
  if (!escrow) {
    console.log(`[inbound] uid=${uid} no open escrow for ${parsed.fromEmail}`);
    return "ignored";
  }
  const emlPath = path.join(tmpDir, `inbound-${uid}.eml`);
  fs.writeFileSync(emlPath, raw);
  await deps.onClaimable({ emlPath, fromEmail: parsed.fromEmail, dest: subject, escrow });
  return "claimed";
}

/** 长驻轮询(单测不直接调用本函数;抽 handleOne/findOpenEscrow 已覆盖核心逻辑)。 */
export async function runInbound(deps: InboundDeps, client: ImapFlow): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zkemail-inbound-"));
  await client.connect();
  console.log("[inbound] imap connected");
  for (;;) {
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uids = await client.search({ unseen: true });
        for (const uid of uids) {
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!msg?.source) continue;
          const result = await handleOne(deps, uid, Buffer.from(msg.source), tmpDir);
          if (result === "claimed") {
            await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
          }
        }
      } finally {
        lock.release();
      }
    } catch (e) {
      console.error("[inbound] poll error:", (e as Error)?.message ?? e);
    }
    await new Promise((r) => setTimeout(r, deps.pollMs ?? 30_000));
  }
}

/** 生产入口:env 构造 ImapFlow。 */
export async function runInboundFromEnv(deps: InboundDeps): Promise<void> {
  const user = process.env.RELAYER_EMAIL;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("RELAYER_EMAIL / GMAIL_APP_PASSWORD required");
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
  await runInbound(deps, client);
}
```

- [ ] **Step 4: 运行验证通过**

```bash
cd circuits && npx jest tests/relayer/inbound.test.ts
```

Expected: PASS(4 tests)。

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json relayer/inbound.ts circuits/tests/relayer/inbound.test.ts
git commit -m "feat: relayer 入站(IMAP 轮询 + Subject 校验 + 托管匹配)"
```

---

### Task 9: Relayer — `claimer.ts`(出证明 + 注册表兜底 + 提交 claim)

**Files:**
- Create: `relayer/claimer.ts`
- Test: `circuits/tests/relayer/claimer.test.ts`

**Interfaces:**
- Consumes: `loadClaimEmail`(`circuits/scripts/load-email.ts`)、`convertProofForSolana`(`circuits/scripts/convert-proof.ts`)、`relayerToField`/`computeDomainCommitment`(`circuits/scripts/poseidon.ts`)、prover `POST /prove`(Task 已有容器)、anchor Program、e2e 的 ALT 模式(`e2e/e2e.ts:203-264`)。
- Produces:
  - `interface ClaimerDeps { connection: Connection; program: Program; programId: PublicKey; relayerKeypair: Keypair; proverUrl: string; }`
  - `async function claimEscrow(deps: ClaimerDeps, mail: { emlPath: string; escrow: PublicKey }): Promise<string>` — 返回 claim 交易签名;幂等(链上 nullifier/账户关闭兜底重复调用)。
  - `export function buildAltAddressList(...)` 与 `export async function ensureRegistry(...)` 导出供单测。

- [ ] **Step 1: 写失败测试(纯逻辑,不跑链)**

`circuits/tests/relayer/claimer.test.ts`:

```ts
import { buildAltAddressList } from "../../../relayer/claimer";
import { PublicKey, SystemProgram, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/web3.js";

describe("buildAltAddressList", () => {
  it("returns exactly the 13 addresses in e2e order", () => {
    const programId = new PublicKey("9Bk8J1CK23pH6zB5CMNZZvNimTfGeeAaHxopNbjURfBR");
    const a = (s: string) => new PublicKey(s.padEnd(44, "1").slice(0, 44));
    const list = buildAltAddressList({
      programId,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      ataProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      mint: a("Mint"), escrow: a("Escrow"), vault: a("Vault"), sender: a("Sender"),
      registry: a("Reg"), destOwner: a("Dest"), destAta: a("DestAta"),
      nullifier: a("Null"), protocolConfig: a("Cfg"),
    });
    expect(list).toHaveLength(13);
    expect(list[0].toBase58()).toBe(programId.toBase58());
    expect(list[12].toBase58()).toBe(a("Cfg").toBase58());
  });
});
```

(注意测试里构造 PublicKey 的 pad 技巧仅用于固定输入;若 base58 校验失败,改用 `Keypair.generate().publicKey` 逐项断言长度与首元素。)

- [ ] **Step 2: 运行验证失败**

```bash
cd circuits && npx jest tests/relayer/claimer.test.ts
```

Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**

`relayer/claimer.ts`:

```ts
// relayer 兑现:回复邮件 → 证明 → (DKIM 注册表兜底)→ ALT → claim 交易。
// 顺序与 e2e/e2e.ts §3-5 一致。relayer 即注册表 authority(e2e 同角色),缺失/过期自动 upsert。
import fs from "fs";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey,
         AddressLookupTableAccount, AddressLookupTableProgram,
         Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { loadClaimEmail } from "../circuits/scripts/load-email";
import { convertProofForSolana } from "../circuits/scripts/convert-proof";
import { relayerToField, computeDomainCommitment } from "../circuits/scripts/poseidon";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fieldToBE(v: bigint): Buffer {
  const b = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

export interface ClaimerDeps {
  connection: Connection;
  program: any; // anchor Program(email-wallet IDL)
  programId: PublicKey;
  relayerKeypair: Keypair; // 代付方;证明绑定该公钥;同时是 DKIM registry authority
  proverUrl: string;       // http://localhost:8080
}

export function buildAltAddressList(x: {
  programId: PublicKey; systemProgram: PublicKey; tokenProgram: PublicKey; ataProgram: PublicKey;
  mint: PublicKey; escrow: PublicKey; vault: PublicKey; sender: PublicKey; registry: PublicKey;
  destOwner: PublicKey; destAta: PublicKey; nullifier: PublicKey; protocolConfig: PublicKey;
}): PublicKey[] {
  return [
    x.programId, x.systemProgram, x.tokenProgram, x.ataProgram,
    x.mint, x.escrow, x.vault, x.sender, x.registry, x.destOwner, x.destAta, x.nullifier, x.protocolConfig,
  ];
}

/** 注册表兜底:不存在 / 过期 / 公钥哈希不匹配时 upsert(authority = relayer)。 */
export async function ensureRegistry(
  deps: ClaimerDeps, domainCommitment: bigint, selector: string, pubkeyHash: bigint
): Promise<PublicKey> {
  const dc = fieldToBE(domainCommitment);
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], deps.programId);
  const [registry] = PublicKey.findProgramAddressSync(
    [Buffer.from("dkim"), dc, Buffer.from(selector)], deps.programId);
  const now = Math.floor(Date.now() / 1000);
  const existing = await deps.connection.getAccountInfo(registry);
  let needsUpsert = !existing;
  if (existing) {
    const acc = await deps.program.account.dkimRegistry.fetch(registry);
    needsUpsert =
      acc.pubkeyHash !== undefined
        ? Buffer.from(acc.pubkeyHash).compare(fieldToBE(pubkeyHash)) !== 0 || Number(acc.expiresAt) < now
        : true;
  }
  if (needsUpsert) {
    await deps.program.methods
      .registryUpsert(Array.from(dc), selector, Array.from(fieldToBE(pubkeyHash)), new anchor.BN(now + 30 * 24 * 3600))
      .accounts({ config, registry, authority: deps.relayerKeypair.publicKey })
      .rpc();
    console.log(`[claimer] registry upserted: selector=${selector}`);
  }
  return registry;
}

export async function claimEscrow(
  deps: ClaimerDeps, mail: { emlPath: string; escrow: PublicKey }
): Promise<string> {
  const relayerField = relayerToField(deps.relayerKeypair.publicKey.toBytes());
  const email = await loadClaimEmail(mail.emlPath, relayerField);
  const meta = email.meta;

  // 一致性校验:邮件与目标托管/relayer 绑定
  const escrowAcc = await deps.program.account.escrow.fetchNullable(mail.escrow);
  if (!escrowAcc) throw new Error("escrow already closed (claimed)");
  if (fieldToBE(BigInt(meta.commitment)).compare(Buffer.from(escrowAcc.commitment)) !== 0) {
    throw new Error("email commitment does not match escrow");
  }
  const relayerEmail = process.env.RELAYER_EMAIL ?? "";
  if (meta.toEmail.toLowerCase() !== relayerEmail.toLowerCase()) {
    throw new Error(`email To(${meta.toEmail}) != relayer email(${relayerEmail})`);
  }

  const selector: string = meta.selector;
  const registry = await ensureRegistry(deps, BigInt(meta.domainCommitment), selector, BigInt(meta.pubkeyHash));

  // 出证明(prover 容器)
  const resp = await fetch(`${deps.proverUrl}/prove`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(email.inputs),
  });
  if (!resp.ok) throw new Error(`prover failed: ${resp.status} ${await resp.text()}`);
  const { proof, publicSignals } = await resp.json();
  const fixture = convertProofForSolana(proof, publicSignals);

  // 组装 claim(e2e 同款:ALT + v0 + 400k CU)
  const destOwner = new PublicKey(meta.destBase58);
  const mint = new PublicKey(escrowAcc.mint);
  const vault = getAssociatedTokenAddressSync(mint, mail.escrow);
  const destAta = getAssociatedTokenAddressSync(mint, destOwner);
  const nullifier = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), fieldToBE(BigInt(meta.emailNullifier))], deps.programId)[0];
  const [protocolConfig] = PublicKey.findProgramAddressSync([Buffer.from("protocol")], deps.programId);
  const ata = (m: PublicKey, o: PublicKey) => getAssociatedTokenAddressSync(m, o);

  const recentSlot = await deps.connection.getSlot("finalized");
  const [createAltIx, altAddress] = AddressLookupTableProgram.createLookupTable({
    authority: deps.relayerKeypair.publicKey, payer: deps.relayerKeypair.publicKey, recentSlot,
  });
  const wallet = new anchor.Wallet(deps.relayerKeypair);
  const provider = new anchor.AnchorProvider(deps.connection, wallet, { commitment: "confirmed" });
  await provider.sendAndConfirm(new Transaction().add(createAltIx), []);
  await provider.sendAndConfirm(new Transaction().add(
    AddressLookupTableProgram.extendLookupTable({
      payer: deps.relayerKeypair.publicKey, authority: deps.relayerKeypair.publicKey,
      lookupTable: altAddress,
      addresses: buildAltAddressList({
        programId: deps.programId, systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID, ataProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        mint, escrow: mail.escrow, vault, sender: new PublicKey(escrowAcc.sender),
        registry, destOwner, destAta, nullifier, protocolConfig,
      }),
    })
  ), []);
  const extendedSlot = await deps.connection.getSlot();
  for (let i = 0; i < 20 && (await deps.connection.getSlot()) <= extendedSlot; i++) await sleep(400);
  let altAccount: AddressLookupTableAccount | null = null;
  for (let i = 0; i < 10; i++) {
    const res = await deps.connection.getAddressLookupTable(altAddress);
    if (res.value && res.value.state.addresses.length === 13) { altAccount = res.value; break; }
    await sleep(400);
  }
  if (!altAccount) throw new Error("address lookup table not ready");

  const claimTx = await deps.program.methods
    .claim({
      proofA: fixture.proofA, proofB: fixture.proofB, proofC: fixture.proofC,
      publicInputs: fixture.publicInputs, selector,
    })
    .accounts({
      escrow: mail.escrow, sender: new PublicKey(escrowAcc.sender), vault, mint,
      registry, destOwner, destAta, payer: deps.relayerKeypair.publicKey, nullifier, protocolConfig,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
    .transaction();

  let sig = "";
  for (let attempt = 0; attempt < 3 && !sig; attempt++) {
    const { blockhash, lastValidBlockHeight } = await deps.connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: deps.relayerKeypair.publicKey, recentBlockhash: blockhash,
      instructions: claimTx.instructions,
    }).compileToV0Message([altAccount]);
    const vtx = new VersionedTransaction(msg);
    vtx.sign([deps.relayerKeypair]);
    try {
      sig = await deps.connection.sendRawTransaction(vtx.serialize());
      await deps.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    } catch { sig = ""; }
  }
  if (!sig) throw new Error("claim tx failed to land after 3 attempts");
  console.log(`[claimer] claimed ${mail.escrow.toBase58()} → ${meta.destBase58} tx=${sig}`);
  return sig;
}
```

- [ ] **Step 4: 运行验证通过**

```bash
cd circuits && npx jest tests/relayer/claimer.test.ts
```

Expected: PASS。

- [ ] **Step 5: 类型检查**

```bash
npx tsc --noEmit
```

Expected: 无新增错误(根 tsconfig 已含 relayer/;若 bs58 类型缺失则 `npm i -D @types/bs58`)。

- [ ] **Step 6: Commit**

```bash
git add relayer/claimer.ts circuits/tests/relayer/claimer.test.ts package.json package-lock.json
git commit -m "feat: relayer claimer(证明 + 注册表兜底 + ALT claim 交易)"
```

---

### Task 10: Relayer 编排入口 `relayer/index.ts` + 环境变量

**Files:**
- Create: `relayer/index.ts`
- Create: `.env.example`(根)
- Modify: `package.json`(根 scripts 已有 `relayer:run`,Task 1 加)

**Interfaces:**
- Consumes: Task 7/8/9 全部模块、`indexer.ts`(已有,改用 GmailNotifier)。
- Produces: `npm run relayer:run` 一键启动 indexer + inbound→claimer 流水线;`.env` 必填变量见 `.env.example`。

- [ ] **Step 1: 改造 indexer 支持 GmailNotifier**

`relayer/indexer.ts` 末尾 `const notifier: Notifier = new ConsoleNotifier();` 改为按 env 选择(保持 ConsoleNotifier 为默认回退):

```ts
let notifier: Notifier = new ConsoleNotifier();
if (process.env.GMAIL_APP_PASSWORD) {
  const { GmailNotifier } = await import("./notify");
  notifier = new GmailNotifier({ user: email, pass: process.env.GMAIL_APP_PASSWORD });
  console.log(`[indexer] using GmailNotifier (smtp as ${email})`);
}
```

(文件顶部已有 `email` 变量;`main()` 内使用处替换。)

- [ ] **Step 2: 编排入口**

`relayer/index.ts`:

```ts
// relayer 编排:indexer(通知)+ inbound(收信)→ claimer(兑现)。无 DB,状态全在链上。
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";
import { runIndexer } from "./indexer-lib"; // 见 Step 3:indexer 抽出可导入的主流程
import { runInboundFromEnv } from "./inbound";
import { claimEscrow, ClaimerDeps } from "./claimer";

const ROOT = path.resolve(__dirname, "..");
const IDL_PATH = path.join(ROOT, "onchain/target/idl/email_wallet.json");

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const relayerKeyPath = process.env.RELAYER_KEYPAIR_PATH ?? path.join(os.homedir(), ".config/solana/id.json");
  const proverUrl = process.env.PROVER_URL ?? "http://localhost:8080";
  const relayerKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(relayerKeyPath, "utf8"))));
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  const connection = new Connection(rpc, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(relayerKeypair), { commitment: "confirmed" });
  const program: any = new anchor.Program(idl as any, provider);
  const programId: PublicKey = program.programId as PublicKey;

  // claim 队列:inbound 收到合法回复即入队,逐个兑现(串行,prover 本身串行)
  const queue: { emlPath: string; escrow: PublicKey }[] = [];
  let working = false;
  const claimerDeps: ClaimerDeps = { connection, program, programId, relayerKeypair, proverUrl };

  async function pump() {
    if (working) return;
    working = true;
    while (queue.length > 0) {
      const mail = queue.shift()!;
      try {
        await claimEscrow(claimerDeps, mail);
      } catch (e) {
        console.error(`[relayer] claim failed for ${mail.escrow.toBase58()}:`, (e as Error)?.message ?? e);
      }
    }
    working = false;
  }

  const deps = {
    connection, programId,
    notifier: undefined as any, // indexer 内部自建 notifier(按 GMAIL_APP_PASSWORD)
    onClaimable: (m: { emlPath: string; escrow: PublicKey }) => { queue.push(m); void pump(); },
  };

  // indexer 需要长期驻留:在其内部循环外以 fire-and-forget 启动
  void runIndexer().catch((e) => { console.error("[indexer] fatal:", e); process.exit(1); });
  void runInboundFromEnv(deps as any).catch((e) => { console.error("[inbound] fatal:", e); process.exit(1); });
  console.log(`[relayer] up: rpc=${rpc} relayer=${relayerKeypair.publicKey.toBase58()}`);
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
main().catch((e) => { console.error("[relayer] FAIL:", e?.message ?? e); process.exit(1); });
```

- [ ] **Step 3: indexer 抽出可导入入口**

`relayer/indexer.ts` 现状是脚本式 `main()`。最小改动:把 `main()` 改名为 `export async function runIndexer(): Promise<void>`,删除文件末尾 `main().catch(...)` 调用;`relayer/index.ts` 用 `runIndexer()`。`indexer.ts` 内部依赖的 env(`RELAYER_EMAIL`/`RELAYER_X25519_SECRET_HEX`/`RPC_URL`/`CLAIM_BASE_URL`)保持不变。

- [ ] **Step 4: 环境变量样例**

根 `.env.example`:

```
# relayer(本地进程,npm run relayer:run;真实值放根 .env,已 gitignore 则确认)
RELAYER_EMAIL=penghe1996@gmail.com
RELAYER_X25519_SECRET_HEX=<32 bytes hex>
GMAIL_APP_PASSWORD=<gmail 16 位 app password>
RPC_URL=https://api.devnet.solana.com
PROVER_URL=http://localhost:8080
CLAIM_BASE_URL=http://localhost:5173/claim/
RELAYER_KEYPAIR_PATH=~/.config/solana/id.json
```

确认根 `.gitignore` 含 `.env`(无则追加);`.env.example` 提交。

- [ ] **Step 5: 类型检查与启动冒烟**

```bash
npx tsc --noEmit
```

Expected: 无错误。真实启动留到 Task 12(E2E);本步只做类型检查。

- [ ] **Step 6: Commit**

```bash
git add relayer/index.ts relayer/indexer.ts .env.example .gitignore package.json
git commit -m "feat: relayer 编排入口(indexer + inbound/claimer 队列)+ env 样例"
```

---

### Task 11: devnet 部署与初始化 `onchain/scripts/devnet-init.ts`

**Files:**
- Create: `onchain/scripts/devnet-init.ts`
- Modify: `app/.dev.vars`(回填真实 x25519 公钥与 mint)
- Modify: `onchain/Anchor.toml`(追加 `[programs.devnet]` 段,若实现时 anchor deploy 需要)

**Interfaces:**
- Produces: devnet 上程序已部署 + protocol/registry/relayer 已初始化 + 测试 mint 已铸造;终端打印可粘贴进 `app/.dev.vars` 的键值。

- [ ] **Step 1: `alt_bn128` 特性探测(阻塞性前置)**

```bash
solana feature status -u devnet | grep -i alt_bn128
```

Expected: `alt_bn128 syscall` / `alt_bn128 g1 compression` / `alt_bn128 g1 decompression` / `alt_bn128 pairing` 全部 `active`。任一 inactive → 停止,向用户报告"devnet 未激活,改用本地 validator"(切换 `RPC_URL`/`[programs.localnet]` 路径,其余计划不变),不要硬上。

- [ ] **Step 2: 程序 keypair 与部署**

```bash
export PATH="$HOME/.avm/bin:$PATH"
(cd onchain && anchor build)
ls onchain/target/deploy/email_wallet-keypair.json   # 必须存在且对应 declare_id! 9Bk8...
solana config set --url devnet
solana program deploy onchain/target/deploy/email_wallet.so --program-id onchain/target/deploy/email_wallet-keypair.json
```

Expected: 输出 `Program Id: 9Bk8J1CK23pH6zB5CMNZZvNimTfGeeAaHxopNbjURfBR`。若 keypair 缺失:`solana-keygen new -o onchain/target/deploy/email_wallet-keypair.json` 生成后须同步改 `declare_id!` 并重新 `anchor build`(此时 Task 4 的 IDL 需重新复制)。

- [ ] **Step 3: 初始化脚本**

`onchain/scripts/devnet-init.ts`:

```ts
// devnet 一次性初始化(幂等):protocol config → registry → relayer 注册 → DKIM(gmail) → 测试 mint。
// 用法: npx tsx onchain/scripts/devnet-init.ts   需 ~/.config/solana/id.json 有足够 devnet SOL(脚本自动 airdrop 2)。
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { promises as dns } from "dns";
import fs from "fs";
import os from "os";
import path from "path";
import nacl from "tweetnacl";
import { computeCommitment, computePubkeyHash, computeDomainCommitment } from "../../circuits/scripts/poseidon";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const RELAYER_EMAIL = (process.env.RELAYER_EMAIL ?? "penghe1996@gmail.com").toLowerCase();
const GMAIL_SELECTOR = process.env.REGISTRY_SELECTOR_GMAIL ?? "20230601";
const PROTOCOL_FEE = 1_000_000;        // 0.001 SOL
const WINDOW_PAST = 2_592_000;         // 30 天
const MINT_SUPPLY = 1_000_000_000;
const ROOT = path.resolve(__dirname, "..", "..");

function fieldToBE(v: bigint): Buffer {
  const b = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

/** DKIM TXT(v=DKIM1;k=rsa;p=...) → RSA 模数 n(DER SEQUENCE 内第一个 INTEGER,去前导 0)。 */
export async function dkimRsaModulus(selector: string, domain: string): Promise<bigint> {
  const txts = await dns.resolveTxt(`${selector}._domainkey.${domain}`);
  const record = txts.map((t) => t.join("")).find((t) => t.includes("p="));
  if (!record) throw new Error(`no DKIM record for ${selector}.${domain}`);
  const pB64 = record.split(";").map((s) => s.trim()).find((s) => s.startsWith("p="))!.slice(2).replace(/\s+/g, "");
  const der = Buffer.from(pB64, "base64");
  if (der[0] !== 0x30) throw new Error("not a DER sequence");
  let off = 2; // SEQUENCE header(短格式足够:DKIM key < 127B 头域假设不成立时按长格式走)
  if (der[1] & 0x80) { const n = der[1] & 0x7f; off = 2 + n; }
  if (der[off] !== 0x02) throw new Error("no INTEGER after SEQUENCE");
  const len = der[off + 1];
  let intStart = off + 2;
  let n = Buffer.from(der.subarray(intStart, intStart + len));
  if (n[0] === 0x00) n = n.subarray(1); // 前导零
  let v = 0n;
  for (const b of n) v = (v << 8n) | BigInt(b);
  return v;
}

async function main() {
  const kpPath = process.env.RELAYER_KEYPAIR_PATH ?? path.join(os.homedir(), ".config/solana/id.json");
  const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf8"))));
  const conn = new Connection(RPC, "confirmed");
  const balance = await conn.getBalance(authority.publicKey);
  if (balance < 1e9) {
    const sig = await conn.requestAirdrop(authority.publicKey, 2e9);
    await conn.confirmTransaction(sig, "confirmed");
  }
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "onchain/target/idl/email_wallet.json"), "utf8"));
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(authority), { commitment: "confirmed" });
  const program: any = new anchor.Program(idl, provider);
  const programId: PublicKey = program.programId;

  const [protocol] = PublicKey.findProgramAddressSync([Buffer.from("protocol")], programId);
  try {
    await program.methods.initializeProtocol(authority.publicKey, new anchor.BN(PROTOCOL_FEE), new anchor.BN(WINDOW_PAST))
      .accounts({ config: protocol, payer: authority.publicKey }).rpc();
    console.log("initialized protocol");
  } catch { console.log("protocol already initialized"); }

  const [registryConfig] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  try {
    await program.methods.initializeRegistry(authority.publicKey)
      .accounts({ config: registryConfig, payer: authority.publicKey }).rpc();
    console.log("initialized registry");
  } catch { console.log("registry already initialized"); }

  // relayer:x25519 私钥来自 env,没有则生成并打印(用户填入 .env)
  let secretHex = process.env.RELAYER_X25519_SECRET_HEX;
  if (!secretHex) {
    const kp = nacl.box.keyPair();
    secretHex = Buffer.from(kp.secretKey).toString("hex");
    console.log(`\n!!! 生成新 x25519 私钥,请写入根 .env: RELAYER_X25519_SECRET_HEX=${secretHex}\n`);
  }
  const x25519 = nacl.box.keyPair.fromSecretKey(Buffer.from(secretHex, "hex"));
  const emailHash = fieldToBE(await computeCommitment(RELAYER_EMAIL));
  const [relayerEntry] = PublicKey.findProgramAddressSync([Buffer.from("relayer"), emailHash], programId);
  const existing = await program.account.relayerEntry.fetchNullable(relayerEntry);
  if (!existing) {
    await program.methods.registerRelayer(
        RELAYER_EMAIL, Array.from(emailHash), Array.from(x25519.publicKey), authority.publicKey, new anchor.BN(0))
      .accounts({ relayerEntry, claimAuthority: authority.publicKey }).rpc();
    console.log("registered relayer:", RELAYER_EMAIL);
  } else console.log("relayer already registered");

  // gmail DKIM 公钥上链
  const modulus = await dkimRsaModulus(GMAIL_SELECTOR, "gmail.com");
  const pubkeyHash = fieldToBE(await computePubkeyHash(modulus));
  const domainCommitment = fieldToBE(await computeDomainCommitment("gmail.com"));
  const [dkimReg] = PublicKey.findProgramAddressSync(
    [Buffer.from("dkim"), domainCommitment, Buffer.from(GMAIL_SELECTOR)], programId);
  await program.methods.registryUpsert(
      Array.from(domainCommitment), GMAIL_SELECTOR, Array.from(pubkeyHash),
      new anchor.BN(Math.floor(Date.now() / 1000) + 90 * 24 * 3600))
    .accounts({ config: registryConfig, registry: dkimReg, authority: authority.publicKey }).rpc();
  console.log(`dkim upserted: gmail.com selector=${GMAIL_SELECTOR}`);

  // 测试 mint
  const mint = await createMint(conn, authority, authority.publicKey, null, 6);
  const ata = await getOrCreateAssociatedTokenAccount(conn, authority, mint, authority.publicKey);
  await mintTo(conn, authority, mint, ata.address, authority, BigInt(MINT_SUPPLY));
  console.log(`test mint: ${mint.toBase58()} supply=${MINT_SUPPLY} decimals=6`);

  console.log("\n--- 粘贴到 app/.dev.vars ---");
  console.log(`RELAYER_X25519_PK_HEX=${Buffer.from(x25519.publicKey).toString("hex")}`);
  console.log(`MINTS_JSON=[{"mint":"${mint.toBase58()}","symbol":"TST","decimals":6}]`);
  console.log("--- devnet-init done ---");
}
main().catch((e) => { console.error("devnet-init FAIL:", e?.message ?? e); process.exit(1); });
```

- [ ] **Step 4: 运行**

```bash
npx tsx onchain/scripts/devnet-init.ts
```

Expected: 依次打印 initialized/registered/dkim upserted/test mint 与 `.dev.vars` 键值。将打印的 `RELAYER_X25519_PK_HEX` 与 `MINTS_JSON` 回填到 `app/.dev.vars`(本地)并记录(生产环境写入 wrangler vars)。

- [ ] **Step 5: 验证**

```bash
curl -s http://localhost:5173/api/config | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['relayX25519Pk'] != '0'*64 and d['mints'], d; print('CONFIG OK')"
```

(先 `npm run app:dev`。)

- [ ] **Step 6: Commit**

```bash
git add onchain/scripts/devnet-init.ts app/.dev.vars 2>/dev/null; git add onchain/scripts/devnet-init.ts
git commit -m "feat: devnet 一次性初始化脚本(探测/部署/注册/测试币)"
```

(`app/.dev.vars` 含公开常量,提交无妨;若团队约定不提交则只提交脚本并记录。)

---

### Task 12: 集成测试 — 本地 validator 全链路(无 Gmail 依赖)

**Files:**
- Create: `e2e/relayer-claim.ts`
- Modify: `package.json`(根 script `e2e:relayer`)

**Interfaces:**
- Consumes: claimer(Task 9)、indexer(Task 10)、prover 容器、本地 validator、`circuits/testdata/emails/` 下新鲜 `.eml`(README:DKIM 新鲜度 48h,过期需重新导出)。
- Produces: `npm run e2e:relayer` 断言通过即 claimer 全链路可信;为 Task 13 真实 Gmail E2E 去掉不确定性。

- [ ] **Step 1: 脚本(复用 e2e.ts 的 validator/注册/托管流程,claim 段换成 claimer)**

`e2e/relayer-claim.ts`:

```ts
// claimer 集成测试:本地 validator + prover 容器 + 真实 .eml,直接调 claimEscrow(绕过 IMAP/Gmail)。
// 与 e2e/e2e.ts 的差异:claim 段走 relayer/claimer.ts,验证 Task 9 的生产代码路径。
import { execFileSync, spawn, ChildProcess } from "child_process";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createMint, createAccount, mintTo, getAccount } from "@solana/spl-token";
import fs from "fs";
import path from "path";
import nacl from "tweetnacl";
import { sealEmailForRelayer } from "../relayer/crypto";
import { claimEscrow, ClaimerDeps } from "../relayer/claimer";
import { computeCommitment } from "../circuits/scripts/poseidon";

const ROOT = path.resolve(__dirname, "..");
const RPC = "http://127.0.0.1:8899";
const EML = path.join(ROOT, "circuits/testdata/emails/e2e.eml");
const AMOUNT = 50_000_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fieldToBE = (v: bigint) => {
  const b = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
};
const children: ChildProcess[] = [];
process.on("exit", () => { for (const c of children) try { c.kill(); } catch {} });

async function main() {
  const { loadClaimEmail } = await import("../circuits/scripts/load-email");
  const { relayerToField } = await import("../circuits/scripts/poseidon");
  const relayer = Keypair.generate();
  const sender = Keypair.generate();
  const treasury = Keypair.generate();
  const relayerX25519 = nacl.box.keyPair();
  const email = await loadClaimEmail(EML, relayerToField(relayer.publicKey.toBytes()));
  const relayerEmail = email.meta.toEmail;
  const relayerHash = fieldToBE(BigInt(email.meta.relayerEmailHash));
  const commitment = fieldToBE(BigInt(email.meta.commitment));
  process.env.RELAYER_EMAIL = relayerEmail; // claimer 内校验 To 绑定

  execFileSync("anchor", ["build"], { cwd: path.join(ROOT, "onchain"), stdio: "inherit",
    env: { ...process.env, PATH: `${process.env.HOME}/.avm/bin:${process.env.PATH}` } });
  const programIdStr = Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync(path.join(ROOT, "onchain/target/deploy/email_wallet-keypair.json"), "utf8"))))
    .publicKey.toBase58();
  const validator = spawn("solana-test-validator", ["--reset", "--quiet", "--bpf-program",
    programIdStr, path.join(ROOT, "onchain/target/deploy/email_wallet.so")],
    { cwd: path.join(ROOT, "onchain"), stdio: "ignore" });
  children.push(validator);
  const conn = new Connection(RPC, "confirmed");
  for (let i = 0; i < 60; i++) { try { await conn.getSlot(); break; } catch { await sleep(500); } }
  for (const kp of [relayer, sender, treasury]) {
    const sig = await conn.requestAirdrop(kp.publicKey, 5e9);
    await conn.confirmTransaction(sig);
  }
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "onchain/target/idl/email_wallet.json"), "utf8"));
  const program: any = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(relayer), { commitment: "confirmed" }));
  const programId = new PublicKey(programIdStr);
  const protocolConfig = PublicKey.findProgramAddressSync([Buffer.from("protocol")], programId)[0];
  const relayerEntry = PublicKey.findProgramAddressSync([Buffer.from("relayer"), relayerHash], programId)[0];
  await program.methods.initializeProtocol(treasury.publicKey, new anchor.BN(1_000_000), new anchor.BN(2_592_000))
    .accounts({ config: protocolConfig, payer: relayer.publicKey }).rpc();
  await program.methods.registerRelayer(relayerEmail, Array.from(relayerHash), Array.from(relayerX25519.publicKey), relayer.publicKey, new anchor.BN(0))
    .accounts({ relayerEntry, claimAuthority: relayer.publicKey }).rpc();
  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
  await program.methods.initializeRegistry(relayer.publicKey)
    .accounts({ config: configPda, payer: relayer.publicKey }).rpc();

  // sender 建托管
  const mint = await createMint(conn, sender, sender.publicKey, null, 6);
  const senderAta = await createAccount(conn, sender, mint, sender.publicKey);
  await mintTo(conn, sender, mint, senderAta, sender, 1_000_000_000);
  const escrow = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), commitment, sender.publicKey.toBuffer()], programId)[0];
  const ata = (m: PublicKey, o: PublicKey) => anchor.utils.token.associatedAddress({ mint: m, owner: o });
  const cipher = sealEmailForRelayer(email.meta.fromEmail, relayerX25519.publicKey);
  await program.methods.createEscrow(Array.from(commitment), new anchor.BN(AMOUNT), cipher, Array.from(relayerHash))
    .accounts({ escrow, mint, vault: ata(mint, escrow), senderAta, sender: sender.publicKey,
      config: protocolConfig, treasury: treasury.publicKey, relayerEntry,
      tokenProgram: (await import("@solana/spl-token")).TOKEN_PROGRAM_ID })
    .signers([sender]).rpc();
  console.log("[e2e:relayer] escrow created");

  // prover 容器
  execFileSync("docker", ["compose", "up", "-d", "--build", "prover"], { cwd: ROOT, stdio: "inherit" });
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch("http://localhost:8080/health"); if (r.ok) break; } catch {}
    await sleep(1000);
  }

  // 生产代码路径:claimer(内含 registry 兜底 upsert)
  const deps: ClaimerDeps = { connection: conn, program, programId, relayerKeypair: relayer, proverUrl: "http://localhost:8080" };
  const sig = await claimEscrow(deps, { emlPath: EML, escrow });
  console.log("[e2e:relayer] claim tx:", sig);

  // 断言
  const destOwner = new PublicKey(email.meta.destBase58);
  const destAta = await getAccount(conn, ata(mint, destOwner));
  if (destAta.amount.toString() !== AMOUNT.toString()) throw new Error("dest balance mismatch");
  if (await conn.getAccountInfo(escrow)) throw new Error("escrow not closed");
  // 幂等:重复调用应抛 "already closed"
  let replayed = false;
  try { await claimEscrow(deps, { emlPath: EML, escrow }); } catch { replayed = true; }
  if (!replayed) throw new Error("replay was not rejected");
  console.log("[e2e:relayer] ALL PASS");
  process.exit(0);
}
main().catch((e) => { console.error("[e2e:relayer] FAIL:", e?.message ?? e); process.exit(1); });
```

根 `package.json` scripts 追加 `"e2e:relayer": "npx tsx e2e/relayer-claim.ts"`。

- [ ] **Step 2: 前置检查(.eml 新鲜度)**

```bash
grep -i "^date:" circuits/testdata/emails/e2e.eml
```

Date 头需在 48h 内(DKIM 新鲜度要求);过期按 `circuits/testdata/emails/README.md` 重新导出,否则 skip 并报告。

- [ ] **Step 3: 运行**

```bash
npm run e2e:relayer
```

Expected: `escrow created` → `registry upserted: selector=…` → `claim tx: …` → `ALL PASS`。(总时长含电路编译缓存则 1–3 分钟。)

- [ ] **Step 4: 回归**

```bash
npm run e2e
```

Expected: 原有 e2e 仍 `ALL PASS`(claimer 抽取未破坏既有管线)。

- [ ] **Step 5: Commit**

```bash
git add e2e/relayer-claim.ts package.json
git commit -m "test: claimer 本地集成测试(validator + prover + 幂等断言)"
```

---

### Task 13: 端到端验收 — 真实 Gmail 全链路 + Cloudflare 部署

**Files:**
- Modify: `app/.dev.vars` / wrangler vars(部署环境)
- Modify: `README.md`(运行文档)

**Interfaces:**
- Consumes: 全部前置任务;**用户提供的 Gmail app password**(填入根 `.env` 的 `GMAIL_APP_PASSWORD`)。
- Produces: 验收三项标准(spec §7)全部通过的记录;Cloudflare 部署 URL。

- [ ] **Step 1: 准备凭据(需用户输入)**

根 `.env` 填入:`RELAYER_EMAIL=penghe1996@gmail.com`、`RELAYER_X25519_SECRET_HEX`(Task 11 生成或既有)、`GMAIL_APP_PASSWORD`(Gmail 设置 → 安全 → 两步验证 → 应用专用密码,16 位)、`RPC_URL=https://api.devnet.solana.com`、`PROVER_URL=http://localhost:8080`、`CLAIM_BASE_URL=http://localhost:5173/claim/`。

- [ ] **Step 2: 启动全栈本地**

```bash
npm run prover:up          # prover 容器
npm run app:dev            # Cloudflare app(:5173)
npm run relayer:run        # relayer(indexer + inbound/claimer)
```

Expected: `[relayer] up` + `[indexer] listening` + `[inbound] imap connected`(imap connected 证明 app password 有效)。

- [ ] **Step 3: 发送方流程**

浏览器(Phantom 切 devnet,有 faucet SOL 与 TST):`http://localhost:5173/send` → 填自己另一个邮箱(如 qq/163/outlook 小号)→ 发送 → 钱包弹签 → 成功显示 claim 链接。
Expected: 链上 devnet 出现 escrow(可在 explorer 查);relayer 日志 `[notify] to=<你的邮箱>`(Gmail SMTP 成功);**真实收到通知邮件**。

- [ ] **Step 4: 接收方流程**

收信邮箱打开通知邮件 → 点 claim 链接 → 粘贴第三个 Solana 地址 → confirm → 点 "Send claim email" → 邮件客户端发送(正文空)。
Expected: relayer 日志 `[inbound] …` → `[claimer] claimed <escrow> → <dest>`;30s 内 claim 页显示 claimed;dest 地址收到 TST(devnet explorer 查 ATA)。

- [ ] **Step 5: 边界抽查**

- 同一封回复再发一次/重复触发:链上 `NullifierAlreadyUsed`,relayer 日志报错但进程存活。
- Subject 写成 `Re: xxx`:收到引导回信,无 claim 发生。
- 重启 relayer(`Ctrl-C` 再 `npm run relayer:run`):不丢状态,后续回复仍被处理。

- [ ] **Step 6: Cloudflare 部署**

```bash
cd app
# production vars: 复制 .dev.vars 键值到 wrangler.json vars(公开常量,非敏感)
npm run deploy
```

Expected: 输出 `https://zkemail-connect-app.<subdomain>.workers.dev`。验证:
```bash
curl -s https://zkemail-connect-app.<subdomain>.workers.dev/api/health   # {"ok":true}
```
浏览器访问 `https://…workers.dev/send` 完整走一遍 Step 3–4(将根 `.env` 的 `CLAIM_BASE_URL` 改为该 URL 并重启 relayer,使通知邮件里的 claim 链接指向线上)。

- [ ] **Step 7: 文档与收尾**

`README.md` 追加 "Dapp (app/)" 一节:dev/prod 命令、环境变量清单、relayer 启动、已知限制(Gmail 发送限额、selector 轮换需重跑 `devnet-init.ts` 的 DKIM 段)。commit:

```bash
git add README.md
git commit -m "docs: Dapp 运行与部署文档"
```

---

## Self-Review 记录

- **Spec 覆盖**:§2 架构→Task 1/10;§3 前端→Task 3–6;§4 API→Task 2;§5 relayer→Task 7–10;§6 devnet→Task 11;§7 验收→Task 12/13;§8 风险(alt_bn128→Task 11 Step 1 阻塞探测;DKIM selector→Task 9 ensureRegistry 自动 upsert + Task 13 文档)。无遗漏。
- **占位符扫描**:Task 7 Step 3 内 `opts_user(...)` 为有意反模式标记,已注明正确形态;无 TBD/TODO。
- **类型一致性**:`ClaimableMail{emlPath,fromEmail,dest,escrow}` 在 Task 8 产出、Task 10 队列与 Task 9 `claimEscrow(deps,{emlPath,escrow})` 消费字段兼容(claimer 只取 `emlPath`/`escrow`,多余字段无害);`ClaimerDeps` 五字段在 Task 9 定义、Task 10/12 构造一致;`Notifier`/`NotifyPayload` 接口未改动签名;`runIndexer` 在 Task 10 定义、indexer.ts 导出。
