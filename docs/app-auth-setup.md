# App 登录与后台配置指南

对应 PRD：`docs/app-prd-v1.md` 的 M2（Google OAuth + 登录守卫）。

代码已完整实现，本文只讲**你需要做的配置**。全部步骤做完之前，可以用「模式 A」先把
`/app` 后台跑起来，不需要任何外部凭证。

---

## 模式 A：免凭证跑通后台（本地开发）

`/api/me` 在 `AUTH_DEV_BYPASS=1` 时直接返回一个合成用户，**完全不访问 KV**，
也不需要 Google 凭证。

```bash
cd app
cp .dev.vars.example .dev.vars   # .dev.vars 已被 gitignore
npm run dev                      # → http://localhost:5173
```

`.dev.vars` 内容：

```
AUTH_DEV_BYPASS=1
```

打开 <http://localhost:5173/app/send-claim> 应直接进入后台，登录页会显示
「Dev sign-in (auth bypass)」按钮。

> ⚠️ `AUTH_DEV_BYPASS` 只放在本地 `.dev.vars`。**不要**用 `wrangler secret put` 把它配到
> 生产环境。生产 secrets 里不存在这个变量，bypass 就不可能被误开。

---

## 模式 B：联调真实 Google 登录

### B1. 创建 Google OAuth 客户端

1. 打开 [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
2. 先创建/选择一个项目，再到 **OAuth consent screen** 填写应用信息
   （External 类型；测试阶段把要登录的 Google 账号加到 **Test users** 里，否则会报
   `access_blocked`）
3. **Create Credentials → OAuth client ID**，Application type 选 **Web application**
4. 在 **Authorized redirect URIs** 里加入（本地与线上都要加，Google 支持多条）：

   | 环境 | Redirect URI |
   |---|---|
   | 本地 | `http://localhost:5173/api/auth/google/callback` |
   | 线上 | `https://<你的域名>/api/auth/google/callback` |

   > 这两个值必须与 Worker 实际收到的请求 origin 完全一致 —— Worker 是从请求 URL 推导
   > 回调地址的（`src/worker/auth.ts` 的 `callbackUrl()`），不做任何硬编码。
   > 协议、域名、端口、路径任何一处不同都会返回 `redirect_uri_mismatch`。

5. 记下 **Client ID** 和 **Client Secret**

### B2. 本地填入

`.dev.vars` 改为：

```
# AUTH_DEV_BYPASS 注释掉或删掉
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxx
```

本地 dev 的 KV 由 miniflare 模拟，**不需要**真实 namespace，直接 `npm run dev` 即可。
登录页此时显示正常的「Sign in with Google」。

### B3. 创建生产 KV namespace

```bash
cd app
npx wrangler login                  # 若尚未登录
npx wrangler kv namespace create SESSIONS
```

把返回的 `id` 填进 `app/wrangler.json`，替换占位值
`00000000000000000000000000000000`：

```jsonc
"kv_namespaces": [{ "binding": "SESSIONS", "id": "<上面返回的 id>" }]
```

### B4. 配置生产 secrets

```bash
cd app
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

顺带确认**已有**的运行配置项也已就位（`/api/config` 依赖它们，与本次登录改动无关，
但缺了页面会一直卡在 loading）：

`PROGRAM_ID`、`RPC_URL`、`RELAYER_EMAIL`、`RELAYER_X25519_PK_HEX`、
`CLAIM_BASE_URL`、`MINTS_JSON`（最后一项是 `[{mint,symbol,decimals}]` 的 JSON 字符串）。

### B5. 部署

```bash
cd app
npm run check     # tsc + vite build + wrangler deploy --dry-run
npm run deploy
```

---

## 登录流程与安全边界

```
GET  /api/auth/google/start?next=/app/send-claim
       → 生成一次性 state 存 KV(10min)，302 到 Google
GET  /api/auth/google/callback?code&state
       → state 读到即删（单次使用，防重放/CSRF）
       → code 换 token → userinfo
       → 签发会话存 KV(30d) + Set-Cookie(zkc_session)
       → 302 到 next
GET  /api/me
       → 200 {user, authMode} / 401 {error, authMode}
POST /api/auth/signout
       → 删 KV 会话 + 清 cookie
```

- **开放重定向**：`next` 只接受以单个 `/` 开头的站内路径；`//evil.com`、`/\evil.com`
  一律回落到 `/app/send-claim`。Worker（`src/worker/session.ts`）与前端
  （`src/react-app/lib/auth.tsx`）各有一份同规则实现。
- **CSRF**：state 存 KV 且只能兑换一次。
- **Cookie**：`HttpOnly` + `SameSite=Lax`；`Secure` 按请求协议推导 —— 本地 http 下不加，
  否则浏览器根本不会保存这个 cookie。
- **登出**：用 POST 而非 GET，避免被第三方页面的 `<img>`/`<a>` 链接触发登出。

## `authMode` 三态

`/api/me` 的响应体里带 `authMode`，登录页据此渲染：

| 值 | 触发条件 | 登录页表现 |
|---|---|---|
| `dev-bypass` | `.dev.vars` 里 `AUTH_DEV_BYPASS=1` | 「Dev sign-in (auth bypass)」按钮 |
| `google` | 配了 Client ID + Secret | 正常的「Sign in with Google」 |
| `unconfigured` | 两者都没有 | 按钮 disabled + 「Google OAuth is not configured」提示 |

## 排错

| 现象 | 原因 |
|---|---|
| `redirect_uri_mismatch` | B1 表格里的 URI 与实际访问的 origin 不一致 |
| `access_blocked` | OAuth consent screen 还是测试态，登录账号不在 Test users 里 |
| 登录后立刻又回登录页 | Cookie 没存下。检查是 https 还是 http —— `Secure` 是按协议自动推导的 |
| `oauth_state_mismatch` | state 过期（>10min）或 KV 里已被消费；重新点一次登录即可 |
| `/send` 没有 301 | 检查 `wrangler.json` 的 `assets.run_worker_first` 是否含 `/send` |
