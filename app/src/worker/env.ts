export type Env = {
  PROGRAM_ID: string;
  RPC_URL: string;
  RELAYER_EMAIL: string;
  RELAYER_X25519_PK_HEX: string;
  CLAIM_BASE_URL: string;
  MINTS_JSON: string; // [{mint,symbol,decimals}]
  SESSIONS: KVNamespace;
  /** Helius devnet RPC 的 API key；只存于后端，用于代查钱包代币等读请求。 */
  HELIUS_API_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** 仅本地开发用；生产 secrets 里不应存在此变量。 */
  AUTH_DEV_BYPASS?: string;
};

export type AuthMode = "google" | "dev-bypass" | "unconfigured";

export function authMode(env: Env): AuthMode {
  if (env.AUTH_DEV_BYPASS === "1") return "dev-bypass";
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) return "google";
  return "unconfigured";
}

/** dev-bypass 下 /api/me 返回的合成用户；不落 KV，不签发 cookie。 */
export const DEV_USER = {
  sub: "dev-local",
  email: "dev@localhost",
  name: "Dev User",
  picture: null,
} as const;
