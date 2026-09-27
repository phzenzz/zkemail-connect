export type SessionUser = {
  sub: string;
  email: string;
  name: string;
  picture: string | null;
};

export const SESSION_COOKIE = "zkc_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 天
export const OAUTH_STATE_TTL_SECONDS = 60 * 10; // 10 分钟

const HEX = "0123456789abcdef";

/** 密码学随机 token（默认 256bit）。 */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

export const DEFAULT_NEXT = "/app/send-claim";

/**
 * 只接受站内相对路径，防开放重定向。
 * 拒绝 `https://evil.com`、协议相对 `//evil.com`、以及反斜杠变体 `/\evil.com`
 * （浏览器会把 `\` 当 `/` 处理）。
 */
export function safeNext(raw: string | null | undefined, fallback = DEFAULT_NEXT): string {
  if (!raw || !raw.startsWith("/")) return fallback;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  return raw;
}

const sessionKey = (token: string) => `sess:${token}`;
const stateKey = (state: string) => `oauth_state:${state}`;

export async function createSession(kv: KVNamespace, user: SessionUser): Promise<string> {
  const token = randomToken();
  await kv.put(sessionKey(token), JSON.stringify(user), { expirationTtl: SESSION_TTL_SECONDS });
  return token;
}

export async function readSession(kv: KVNamespace, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const raw = await kv.get(sessionKey(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    // 值损坏当作未登录，而不是 500
    return null;
  }
}

export async function destroySession(kv: KVNamespace, token: string | undefined): Promise<void> {
  if (!token) return;
  await kv.delete(sessionKey(token));
}

export async function putOauthState(kv: KVNamespace, state: string, next: string): Promise<void> {
  await kv.put(stateKey(state), next, { expirationTtl: OAUTH_STATE_TTL_SECONDS });
}

/** 单次使用：读到即删，防重放。返回 null 表示 state 不存在或已被用过。 */
export async function consumeOauthState(kv: KVNamespace, state: string): Promise<string | null> {
  const next = await kv.get(stateKey(state));
  if (next === null) return null;
  await kv.delete(stateKey(state));
  return next;
}
