// relayer/config.ts 单测：纯函数 loadConfig 的解析、缺项清单、降级与脱敏。
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { loadConfig, describeConfig } from "../../../relayer/config";

const SECRET_HEX = "a1".repeat(32); // 32 字节

function fullEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    RELAYER_EMAIL: "Relay@Zkemail.io",
    RELAYER_X25519_SECRET_HEX: SECRET_HEX,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("loadConfig", () => {
  let tmpKeypair: string;
  beforeEach(() => {
    tmpKeypair = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cfg-test-")), "kp.json");
    fs.writeFileSync(tmpKeypair, JSON.stringify(Array.from(new Uint8Array(64).fill(1))));
  });

  it("解析完整配置：email 小写、secret 32B、默认值就位", () => {
    const cfg = loadConfig(fullEnv({ RELAYER_KEYPAIR_PATH: tmpKeypair }));
    expect(cfg.email).toBe("relay@zkemail.io");
    expect(cfg.x25519Secret.length).toBe(32);
    expect(cfg.x25519Secret.toString("hex")).toBe(SECRET_HEX);
    expect(cfg.keypairPath).toBe(tmpKeypair);
    expect(cfg.rpcUrl).toBe("https://api.devnet.solana.com");
    expect(cfg.proverUrl).toBe("http://localhost:8080");
    expect(cfg.claimBaseUrl).toBe("http://localhost:3000/claim/");
    expect(cfg.gmail).toBeNull();
  });

  it("可选项覆盖：RPC_URL / PROVER_URL / CLAIM_BASE_URL", () => {
    const cfg = loadConfig(fullEnv({
      RELAYER_KEYPAIR_PATH: tmpKeypair,
      RPC_URL: "http://127.0.0.1:8899",
      PROVER_URL: "http://localhost:9999",
      CLAIM_BASE_URL: "http://localhost:5173/claim/",
    }));
    expect(cfg.rpcUrl).toBe("http://127.0.0.1:8899");
    expect(cfg.proverUrl).toBe("http://localhost:9999");
    expect(cfg.claimBaseUrl).toBe("http://localhost:5173/claim/");
  });

  it("缺 RELAYER_EMAIL：清单式报错并给出修复指引", () => {
    const env = fullEnv(); delete env.RELAYER_EMAIL;
    expect(() => loadConfig(env)).toThrow(/RELAYER_EMAIL/);
    expect(() => loadConfig(env)).toThrow(/npm run relayer:devnet/);
  });

  it("缺 RELAYER_X25519_SECRET_HEX：同上", () => {
    const env = fullEnv(); delete env.RELAYER_X25519_SECRET_HEX;
    expect(() => loadConfig(env)).toThrow(/RELAYER_X25519_SECRET_HEX/);
  });

  it("secret 非 64 hex：明确报错", () => {
    expect(() => loadConfig(fullEnv({ RELAYER_X25519_SECRET_HEX: "abcd" })))
      .toThrow(/64/);
    expect(() => loadConfig(fullEnv({ RELAYER_X25519_SECRET_HEX: "zz".repeat(32) })))
      .toThrow(/hex/);
  });

  it("keypair 文件不存在：明确报错", () => {
    expect(() => loadConfig(fullEnv({ RELAYER_KEYPAIR_PATH: "/no/such/kp.json" })))
      .toThrow(/RELAYER_KEYPAIR_PATH/);
  });

  it("Gmail：OAuth2 三件套优先于应用专用密码", () => {
    const oauth = loadConfig(fullEnv({
      RELAYER_KEYPAIR_PATH: tmpKeypair,
      GMAIL_OAUTH_CLIENT_ID: "cid", GMAIL_OAUTH_CLIENT_SECRET: "csec", GMAIL_OAUTH_REFRESH_TOKEN: "rt",
      GMAIL_APP_PASSWORD: "app",
    }));
    expect(oauth.gmail).toEqual({ kind: "oauth2", clientId: "cid", clientSecret: "csec", refreshToken: "rt" });
    const app = loadConfig(fullEnv({ RELAYER_KEYPAIR_PATH: tmpKeypair, GMAIL_APP_PASSWORD: "app" }));
    expect(app.gmail).toEqual({ kind: "appPassword", pass: "app" });
  });

  it("describeConfig 脱敏：不泄露完整 secret", () => {
    const out = describeConfig(loadConfig(fullEnv({ RELAYER_KEYPAIR_PATH: tmpKeypair })));
    expect(out).toContain("relay@zkemail.io");
    expect(out).not.toContain(SECRET_HEX);
    expect(out).toContain("(32B)");
  });
});
