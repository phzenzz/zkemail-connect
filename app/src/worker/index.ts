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
