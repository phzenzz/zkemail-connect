// 手动测试脚本共享工具：连接、密钥对、program 句柄、状态文件。
// 所有脚本从 repo 根目录运行：npx tsx e2e/manual/<step>.ts
import fs from "fs";
import path from "path";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

export const ROOT = path.resolve(__dirname, "../..");
export const RPC = "http://127.0.0.1:8899";
export const EML = path.join(ROOT, "circuits/testdata/emails/e2e.eml");
export const STATE_DIR = path.join(ROOT, ".manual-test");
export const STATE_FILE = path.join(STATE_DIR, "state.json");
export const PROOF_FILE = path.join(STATE_DIR, "proof.json");

export const AMOUNT = 50_000_000; // 50 个代币（6 位小数）
export const PROTOCOL_FEE = 1_000_000; // 0.001 SOL

/**
 * relayer 邮箱（relayer 标识）= eml 的 To 地址，01 步解析邮件时写入 state.meta.toEmail。
 * v1.7 起 proof 绑定 relayerEmailHash = Poseidon(To)，claim 链上校验它与 escrow 登记值一致，
 * 因此注册 relayer（04）与 seal（02）必须用同一个值——直接从 state 读，不允许硬编码。
 */
export function relayerEmailFromState(state: State): string {
  const to = state.meta?.toEmail;
  if (typeof to !== "string" || !to) {
    throw new Error("state.meta.toEmail 缺失——先跑 01 步解析邮件（relayer 邮箱 = eml 的 To 地址）");
  }
  return to;
}

export const conn = new Connection(RPC, "confirmed");

export function loadKeypair(name: "sender" | "relayer"): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${name}.json`), "utf8"))));
}

export function programId(): PublicKey {
  return Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync(path.join(ROOT, "onchain/target/deploy/email_wallet-keypair.json"), "utf8"))))
    .publicKey;
}

/** anchor Program 句柄，relayer 作为 provider 钱包（代付方）。 */
export function loadProgram(relayer: Keypair): any {
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "onchain/target/idl/email_wallet.json"), "utf8"));
  // IDL 里的 address 可能因重新 build 而过期，统一以 deploy keypair 为准。
  idl.address = programId().toBase58();
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(relayer), { commitment: "confirmed" });
  return new Program(idl, provider) as any;
}

export const ata = (mint: PublicKey, owner: PublicKey) =>
  anchor.utils.token.associatedAddress({ mint, owner });

/** 十进制字段元素字符串 -> 32 字节大端 Buffer（链上 commitment/pubkeyHash 的编码方式）。 */
export function fieldToBE(s: string): Buffer {
  let v = BigInt(s);
  const b = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

export interface State {
  mint?: string;
  escrow?: string;
  batch?: string;   // 06 步创建
  meta?: Record<string, unknown>;
  /** 04 步生成的 relayer x25519 私钥（hex），供 relayer/indexer.ts 解密用。 */
  relayerX25519Secret?: string;
}

export function loadState(): State {
  return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
}

export function saveState(patch: State) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const next = { ...loadState(), ...patch };
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

export function mustState(): Required<State> {
  const s = loadState();
  if (!s.mint || !s.escrow || !s.meta) {
    throw new Error("state 不完整——请按顺序先跑 00/01/02 步（见 docs/手动测试指南.md）");
  }
  return s as Required<State>;
}
