import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { authMode, DEV_USER, type Env } from "./env";
import {
  consumeOauthState,
  createSession,
  destroySession,
  putOauthState,
  randomToken,
  readSession,
  safeNext,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  type SessionUser,
} from "./session";

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";
const GOOGLE_SCOPE = "openid email profile";

/** 本地 http 下不能带 Secure，否则 cookie 根本存不下。 */
const isSecureRequest = (url: string) => new URL(url).protocol === "https:";

/** callback 必须与会话里登记的一致，故统一由请求 origin 推导。 */
const callbackUrl = (requestUrl: string) => new URL("/api/auth/google/callback", requestUrl).toString();

const loginError = (code: string) => `/login?error=${code}`;

export const auth = new Hono<{ Bindings: Env }>();

/** 前端用它判定登录态；401 时 body 里带 authMode，登录页据此渲染三种形态。 */
auth.get("/me", async (c) => {
  const mode = authMode(c.env);
  if (mode === "dev-bypass") return c.json({ user: DEV_USER, authMode: mode });
  const user = await readSession(c.env.SESSIONS, getCookie(c, SESSION_COOKIE));
  if (!user) return c.json({ error: "unauthorized", authMode: mode }, 401);
  return c.json({ user, authMode: mode });
});

auth.get("/auth/google/start", async (c) => {
  if (authMode(c.env) !== "google") return c.redirect(loginError("oauth_unconfigured"), 302);

  const next = safeNext(c.req.query("next"));
  const state = randomToken();
  await putOauthState(c.env.SESSIONS, state, next);

  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", callbackUrl(c.req.url));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return c.redirect(url.toString(), 302);
});

auth.get("/auth/google/callback", async (c) => {
  if (authMode(c.env) !== "google") return c.redirect(loginError("oauth_unconfigured"), 302);

  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) return c.redirect(loginError("oauth_failed"), 302);

  // 读到即删：state 只能兑换一次，防重放 / CSRF
  const next = await consumeOauthState(c.env.SESSIONS, state);
  if (next === null) return c.redirect(loginError("oauth_state_mismatch"), 302);

  const redirectUri = callbackUrl(c.req.url);
  const tokenRes = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID!,
      client_secret: c.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return c.redirect(loginError("oauth_token_exchange"), 302);

  const tokens = (await tokenRes.json()) as { access_token?: string };
  if (!tokens.access_token) return c.redirect(loginError("oauth_token_exchange"), 302);

  const infoRes = await fetch(GOOGLE_USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (!infoRes.ok) return c.redirect(loginError("oauth_userinfo"), 302);

  const info = (await infoRes.json()) as Partial<SessionUser> & { email_verified?: boolean };
  if (!info.sub || !info.email) return c.redirect(loginError("oauth_userinfo"), 302);

  const token = await createSession(c.env.SESSIONS, {
    sub: info.sub,
    email: info.email,
    name: info.name ?? info.email,
    picture: info.picture ?? null,
  });

  setCookie(c, SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecureRequest(c.req.url),
    maxAge: SESSION_TTL_SECONDS,
  });
  return c.redirect(next, 302);
});

/** POST 而非 GET：避免被第三方页面用 <img>/<a> 链接触发登出。 */
auth.post("/auth/signout", async (c) => {
  await destroySession(c.env.SESSIONS, getCookie(c, SESSION_COOKIE));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.body(null, 204);
});
