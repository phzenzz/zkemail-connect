import type { Env } from "./env";

/** Helius devnet JSON-RPC 入口。API key 只应存在于 Worker 环境变量，绝不下发到前端。 */
const HELIUS_DEVNET_BASE = "https://devnet.helius-rpc.com";

/** 未配置 key 返回 null（本地 validator 等场景走直连）。 */
export function heliusRpcUrl(env: Env): string | null {
  const key = env.HELIUS_API_KEY;
  if (!key) return null;
  return `${HELIUS_DEVNET_BASE}/?api-key=${encodeURIComponent(key)}`;
}

/**
 * 后端统一 Solana JSON-RPC 出口：所有 Worker 内发起的 RPC 调用必须经此封装，
 * 便于集中处理鉴权、错误与解析；调用方只面对 method + params。
 */
export async function rpcCall<T = unknown>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json().catch(() => null)) as
    | { error?: { message?: string }; result?: unknown }
    | null;
  if (!res.ok || json?.error) {
    throw new Error(json?.error?.message ?? `RPC HTTP ${res.status}`);
  }
  return json?.result as T;
}

/** 透传浏览器发来的 JSON-RPC 报文（含批量请求），保留上游状态码与 content-type。 */
export async function forwardJsonRpc(rpcUrl: string, body: unknown): Promise<Response> {
  const upstream = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
  });
}
