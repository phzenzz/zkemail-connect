import { Hono } from "hono";
import { auth } from "./auth";
import type { Env } from "./env";

export type { Env };

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

// /api/me、/api/auth/*
app.route("/api", auth);

// 旧路由真 301；客户端路由表里另有一层 <Navigate> 兜底（见 App.tsx）
app.get("/send", (c) => c.redirect("/app/send-claim", 301));

export default app;
