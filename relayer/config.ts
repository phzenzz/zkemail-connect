// relayer 统一配置层：进程入口唯一的 env 消费点。
// loadConfig 是纯函数（传入 env，返回类型化配置），便于单测；fail-fast 清单式报错。
// 加载方式：npm run relayer / relayer:local / relayer:devnet（package.json 里用
// Node 20.6+ 原生 --env-file 链式加载 .env 与环境覆盖文件，后者优先）。
import fs from "fs";
import os from "os";
import path from "path";
import { gmailAuthFromEnv, GmailAuth } from "./notify";

export interface RelayerConfig {
  /** relayer 身份 = 邮箱（链上 relayer_email_hash 的 preimage；proof 亦绑定其 Poseidon） */
  email: string;
  /** x25519 私钥（32B），与链上 relayerEntry.x25519Key 对应，用于解密发送方密文 */
  x25519Secret: Buffer;
  /** 代付/出证 relayer 的 Solana 密钥对路径（proof 绑定该公钥） */
  keypairPath: string;
  rpcUrl: string;
  proverUrl: string;
  /** 通知邮件里的 claim 链接前缀 */
  claimBaseUrl: string;
  /** Gmail 凭证；null = 通知降级 Console、inbound 不启动（indexer 仍可用） */
  gmail: GmailAuth | null;
}

const DEFAULTS = {
  keypairPath: path.join(os.homedir(), ".config", "solana", "id.json"),
  rpcUrl: "https://api.devnet.solana.com",
  proverUrl: "http://localhost:8080",
  claimBaseUrl: "http://localhost:3000/claim/",
} as const;

function parseX25519(hex: string): Buffer {
  const clean = hex.trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(
      `RELAYER_X25519_SECRET_HEX 须为 32 字节 hex（64 字符），实际 ${clean.length} 字符`
    );
  }
  return Buffer.from(clean, "hex");
}

/**
 * 从环境变量构建配置。缺必需项时抛出清单式错误（含修复指引）。
 * 可选项走 DEFAULTS；Gmail 缺失不抛错（调用方按 null 降级）。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayerConfig {
  const missing: string[] = [];
  if (!env.RELAYER_EMAIL) missing.push("RELAYER_EMAIL");
  if (!env.RELAYER_X25519_SECRET_HEX) missing.push("RELAYER_X25519_SECRET_HEX");
  if (missing.length > 0) {
    throw new Error(
      `缺少必需环境变量: ${missing.join(", ")}\n` +
        "修复：cp .env.example .env 并填写；或 npm run relayer:devnet / relayer:local\n" +
        "（各键含义见 .env.example 注释；当前值可用 `npm run relayer:print-config` 查看）"
    );
  }
  const keypairPath = env.RELAYER_KEYPAIR_PATH ?? DEFAULTS.keypairPath;
  if (!fs.existsSync(keypairPath)) {
    throw new Error(`RELAYER_KEYPAIR_PATH 指向的密钥文件不存在: ${keypairPath}`);
  }
  return {
    email: env.RELAYER_EMAIL!.trim().toLowerCase(),
    x25519Secret: parseX25519(env.RELAYER_X25519_SECRET_HEX!),
    keypairPath,
    rpcUrl: env.RPC_URL ?? DEFAULTS.rpcUrl,
    proverUrl: env.PROVER_URL ?? DEFAULTS.proverUrl,
    claimBaseUrl: env.CLAIM_BASE_URL ?? DEFAULTS.claimBaseUrl,
    gmail: gmailAuthFromEnv(env),
  };
}

/** 打印脱敏配置（secret 打码），供 `npm run relayer:print-config` 人工核对。 */
export function describeConfig(cfg: RelayerConfig): string {
  const mask = (b: Buffer) => `${b.toString("hex").slice(0, 6)}…(${b.length}B)`;
  const gmail = cfg.gmail ? cfg.gmail.kind : "未配置（通知降级 Console / inbound 不启动）";
  return [
    `RELAYER_EMAIL        = ${cfg.email}`,
    `RELAYER_X25519_SECRET= ${mask(cfg.x25519Secret)}`,
    `RELAYER_KEYPAIR_PATH = ${cfg.keypairPath}`,
    `RPC_URL              = ${cfg.rpcUrl}`,
    `PROVER_URL           = ${cfg.proverUrl}`,
    `CLAIM_BASE_URL       = ${cfg.claimBaseUrl}`,
    `GMAIL                = ${gmail}`,
  ].join("\n");
}
