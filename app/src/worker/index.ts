import { Hono } from "hono";
import { auth } from "./auth";
import { forwardJsonRpc, heliusRpcUrl, rpcCall } from "./rpc";
import type { Env } from "./env";

export type { Env };

const app = new Hono<{ Bindings: Env }>();

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const BASE58_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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
    // 有 Helius key 时浏览器全量 RPC 走 Worker 代理（key 不出后端）；否则直连 RPC_URL
    rpcUrl: heliusRpcUrl(env) ? new URL(c.req.url).origin + "/api/rpc" : env.RPC_URL,
    relayEmail: env.RELAYER_EMAIL,
    relayX25519Pk: env.RELAYER_X25519_PK_HEX,
    claimBaseUrl: env.CLAIM_BASE_URL,
    mints,
  });
});

// 浏览器全量 Solana RPC 出口（仅 HTTP POST；不代理 WebSocket 订阅——前端确认交易
// 用 getSignatureStatuses 轮询，读操作为短请求，均不依赖 ws，故代理层无需 Upgrade）。
app.post("/api/rpc", async (c) => {
  // 跨站滥用防护：仅允许同源调用（无 Origin 的 curl/服务端调用放行）
  const origin = c.req.header("Origin") ?? c.req.header("Referer");
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(c.req.url).host) {
        return c.json({ error: "cross-origin RPC calls are not allowed" }, 403);
      }
    } catch {
      // 非法 Origin 头交给上游错误处理
    }
  }
  const rpcUrl = heliusRpcUrl(c.env);
  if (!rpcUrl) return c.json({ error: "HELIUS_API_KEY not configured" }, 503);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, 400);
  }
  return forwardJsonRpc(rpcUrl, body);
});

// 钱包代币列表：Helius API key 只存于 Worker，浏览器无法直连 Helius 时由后端代查。
// 不代理整条 JSON-RPC（发送交易等仍走前端 Connection），避免 key 被盗用消耗额度。
app.get("/api/wallet-tokens/:address", async (c) => {
  const address = c.req.param("address");
  if (!BASE58_ADDRESS_RE.test(address)) return c.json({ error: "invalid address" }, 400);
  const rpcUrl = heliusRpcUrl(c.env);
  if (!rpcUrl) return c.json({ error: "HELIUS_API_KEY not configured" }, 503);
  try {
    const result = await rpcCall<{
      value?: { account?: { data?: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } } } } } }[];
    }>(rpcUrl, "getTokenAccountsByOwner", [address, { programId: TOKEN_PROGRAM_ID }, { encoding: "jsonParsed" }]);
    const tokens = (result?.value ?? [])
      .map((v) => {
        const info = v?.account?.data?.parsed?.info;
        const amount = BigInt(info?.tokenAmount?.amount ?? "0");
        if (!info?.mint || info.tokenAmount?.decimals == null || amount <= 0n) return null;
        return { mint: info.mint, amount: amount.toString(), decimals: info.tokenAmount.decimals };
      })
      .filter((t): t is { mint: string; amount: string; decimals: number } => t !== null);
    return c.json({ tokens });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

// /api/me、/api/auth/*
app.route("/api", auth);

// 旧路由真 301；客户端路由表里另有一层 <Navigate> 兜底（见 App.tsx）
app.get("/send", (c) => c.redirect("/app/send-claim", 301));

export default app;
