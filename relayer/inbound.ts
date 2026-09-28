// relayer 入站:IMAP 轮询 Gmail 收件箱 → 解析回复邮件 → 定位开放托管 → 交给 claimer。
// 已处理判定:handleOne 成功返回(claimed 或 ignored,含已发引导回信)即加 \Seen;
// handleOne 抛错保持 UNSEEN 下轮重试。启动水位线跳过首轮历史未读,避免首启刷屏。
// 重启无内存状态时,链上 nullifier 拒绝重复 claim(幂等兜底)。
import fs from "fs";
import os from "os";
import path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { ImapFlow } from "imapflow";
import bs58 from "bs58"; // @solana/web3.js 已传递依赖;若 import 失败则在根 package.json 显式加 "bs58"
import { computeCommitment } from "../circuits/scripts/poseidon";
import { findLeafByCommitment } from "./batch-store";
import { gmailAuthFromEnv, GmailAuth, Notifier } from "./notify";

const DEST = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const ESCROW_SIZE = 286;
export const COMMITMENT_OFFSET = 8;

export interface ClaimableMail {
  emlPath: string;
  fromEmail: string;
  dest: string;
  escrow: PublicKey;            // 单发路径用
  batch?: PublicKey;            // 批次路径用（二选一）
  leafIndex?: number;
}

export interface InboundDeps {
  connection: Connection;
  programId: PublicKey;
  notifier: Notifier;
  onClaimable: (m: ClaimableMail) => Promise<void>;
  pollMs?: number;
}

/** 解析裸 .eml 的 From(addr-spec)与 Subject(含折叠展开、大小写归一)。 */
export function extractFromAndSubject(raw: Buffer): { fromEmail: string; subject: string } | null {
  const headerEnd = raw.indexOf("\r\n\r\n");
  const header = (headerEnd === -1 ? raw.toString("utf8") : raw.subarray(0, headerEnd).toString("utf8"));
  const unfolded = header.replace(/\r\n[ \t]+/g, " ");
  const fromMatch = unfolded.match(/^from:\s*(.+)$/im);
  const subjectMatch = unfolded.match(/^subject:\s*(.*)$/im);
  if (!fromMatch || !subjectMatch) return null;
  const addr = fromMatch[1].match(/<([^>]+)>/)?.[1] ?? fromMatch[1].trim();
  const email = addr.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return { fromEmail: email, subject: subjectMatch[1].trim() };
}

/** 按 commitment 找开放托管:dataSize=286 + memcmp(offset 8)。同一邮箱多笔时取第一个(最早)。 */
export async function findOpenEscrow(
  connection: Connection, programId: PublicKey, commitment32: Uint8Array
): Promise<PublicKey | null> {
  const accounts = await connection.getProgramAccounts(programId, {
    filters: [
      { dataSize: ESCROW_SIZE },
      { memcmp: { offset: COMMITMENT_OFFSET, bytes: bs58.encode(commitment32) } },
    ],
  });
  return accounts.length > 0 ? accounts[0].pubkey : null;
}

export interface ImapFlowLike {
  connect(): Promise<void>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  fetchOne(range: string, query: object, opts?: object): Promise<any>;
  messageFlagsAdd(range: string, flags: string[], opts?: object): Promise<any>;
  search(query: object, opts?: object): Promise<false | number[]>;
  logout(): Promise<void>;
}

async function handleOne(
  deps: InboundDeps, uid: number, raw: Buffer, tmpDir: string
): Promise<"claimed" | "ignored"> {
  const parsed = extractFromAndSubject(raw);
  if (!parsed) return "ignored";
  const subject = parsed.subject;
  if (!DEST.test(subject)) {
    console.log(`[inbound] subjec=${subject} uid=${uid} subject not a base58 address, sending guidance`);
    await deps.notifier.notify(parsed.fromEmail, {
      escrow: "", sender: "", amount: "",
      claimUrl: process.env.CLAIM_BASE_URL ?? "http://localhost:5173/claim/",
    });
    return "ignored";
  }
  const commitment = await computeCommitment(parsed.fromEmail);
  const c32 = new Uint8Array(32);
  let v = commitment;
  for (let i = 31; i >= 0; i--) { c32[i] = Number(v & 0xffn); v >>= 8n; }
  // 批次优先：缓存命中（且链上批次未过期/未关闭）即批次领取；否则回退单发 escrow 扫描
  const hit = await findLeafByCommitment(Buffer.from(c32), deps.connection);
  const emlPath = path.join(tmpDir, `inbound-${uid}.eml`);
  fs.writeFileSync(emlPath, raw);
  if (hit) {
    await deps.onClaimable({
      emlPath, fromEmail: parsed.fromEmail, dest: subject,
      escrow: new PublicKey(hit.cache.batch), // 占位：pump 按 batch 字段分流
      batch: new PublicKey(hit.cache.batch), leafIndex: hit.leafIndex,
    });
    return "claimed";
  }
  const escrow = await findOpenEscrow(deps.connection, deps.programId, c32);
  if (!escrow) {
    console.log(`[inbound] uid=${uid} no open escrow or batch for ${parsed.fromEmail}`);
    return "ignored";
  }
  await deps.onClaimable({ emlPath, fromEmail: parsed.fromEmail, dest: subject, escrow });
  return "claimed";
}

/** 长驻轮询(单测不直接调用本函数;抽 handleOne/findOpenEscrow 已覆盖核心逻辑)。 */
export async function runInbound(deps: InboundDeps, client: ImapFlowLike): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zkemail-inbound-"));
  await client.connect();
  console.log("[inbound] imap connected");
  let watermark: number | null = null; // 启动水位线:首轮跳过 uid <= watermark 的历史邮件
  for (;;) {
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        console.log(`[inbound] loop start`);
        
        if (watermark === null) {
          const all = (await client.search({ all: true }, { uid: true })) || [];
          watermark = all.reduce((m, u) => Math.max(m, u), 0);
          console.log(`[inbound] startup watermark uid=${watermark}`);
        }
        const uids = ((await client.search({ unseen: true }, { uid: true })) || [])
          .filter((u) => u > watermark!);
        for (const uid of uids) {
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
          console.log(`[inbound] imap msg=${msg}`);

          if (!msg?.source) continue;
          // 处理成功(claimed 或 ignored,含已发引导回信)即加 \Seen,避免每轮重试;
          // handleOne 抛错则不标记,保持 UNSEEN 下轮重试。
          await handleOne(deps, uid, Buffer.from(msg.source), tmpDir);
          await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
        }
      } finally {
        lock.release();
      }
    } catch (e) {
      console.error("[inbound] poll error:", (e as Error)?.message ?? e);
    }
    await new Promise((r) => {
      const t = setTimeout(r, deps.pollMs ?? 30_000);
      (t as any).unref?.(); // 长驻循环的定时器不阻止进程退出
    });
  }
}

/** imapflow 的 XOAUTH2 只接受现成 access token(不支持 refresh token 自动续期),
 *  故用 refresh token 显式换取 access token(Google OAuth2,grant_type=refresh_token)。 */
export async function gmailAccessTokenFromRefreshToken(
  auth: Extract<GmailAuth, { kind: "oauth2" }>
): Promise<string> {
  const body = new URLSearchParams({
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
    refresh_token: auth.refreshToken,
    grant_type: "refresh_token",
  });
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    throw new Error(`Gmail OAuth2 access token refresh failed: HTTP ${resp.status} ${JSON.stringify(data)}`);
  }
  return data.access_token as string;
}

/** 生产入口:env 构造 ImapFlow。 */
export async function runInboundFromEnv(deps: InboundDeps): Promise<void> {
  const user = process.env.RELAYER_EMAIL;
  const auth = gmailAuthFromEnv(process.env);
  if (!user || !auth) {
    throw new Error("RELAYER_EMAIL / (GMAIL_OAUTH_REFRESH_TOKEN 或 GMAIL_APP_PASSWORD) required");
  }
  const imapAuth =
    auth.kind === "oauth2"
      ? { user, accessToken: await gmailAccessTokenFromRefreshToken(auth) }
      : { user, pass: auth.pass };
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: imapAuth,
    logger: false,
  });
  await runInbound(deps, client);
}
