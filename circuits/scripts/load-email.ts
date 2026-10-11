import fs from "fs";
import { verifyDKIMSignature } from "@zk-email/helpers/dist/dkim";
import { generateEmailVerifierInputsFromDKIMResult } from "@zk-email/helpers";
import {
  computeCommitment, computeDomainCommitment, computePubkeyHash, poseidonHash,
} from "./poseidon";

// Zscaler 等企业网关对 dns.google / cloudflare-dns.com 做 TLS 拦截（MITM），Node 不
// 信任企业根证书 → @zk-email/helpers 经 DoH 取 DKIM 公钥必失败（fetch failed /
// UNABLE_TO_GET_ISSUER_CERT_LOCALLY）。本进程内把这两个端点改写为直连可达的
// doh.pub（dns-json 协议相同）；代价是丢失 Google/Cloudflare 双源交叉核对（链上
// registry 仍锚定 pubkeyHash，语义不变）。可用 ZKEMAIL_DOH=off 关闭。
const DOH_REWRITE: Array<[RegExp, string]> = [
  [/^https:\/\/dns\.google\/resolve/, "https://doh.pub/resolve"],
  [/^https:\/\/cloudflare-dns\.com\/dns-query/, "https://doh.pub/resolve"],
];
if (process.env.ZKEMAIL_DOH !== "off" && !(globalThis as { __zkemailDohPatched?: boolean }).__zkemailDohPatched) {
  const origFetch = globalThis.fetch;
  (globalThis as { __zkemailDohPatched?: boolean }).__zkemailDohPatched = true;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const rw = (u: string) => DOH_REWRITE.reduce((s, [re, to]) => s.replace(re, to), u);
    if (typeof input === "string") return origFetch(rw(input), init);
    if (input instanceof URL) return origFetch(new URL(rw(input.href)), init);
    return origFetch(new Request(rw(input.url), input), init);
  }) as typeof fetch;
}

export const MAX_HEADER_LEN = 1024;
export const MAX_DEST_LEN = 44;
const FRESHNESS_SECS = Number(process.env.TIMESTAMP_WINDOW_SECS ?? 30 * 24 * 3600); // 客户端 fail-fast，默认 30 天与链上 ProtocolConfig 对齐

export interface LoadedEmail {
  rawEmail: Buffer;
  inputs: Record<string, unknown>;
  meta: {
    fromEmail: string; domain: string; selector: string;
    destBase58: string; timestamp: number; toEmail: string;
    commitment: string;
    pubkeyHash: string; domainCommitment: string; destA: string; destB: string;
    emailNullifier: string; relayerEmailHash: string;
  };
}

/** Find byte offset of `needle` in canonicalized headers; throws if absent. */
function indexOfHeader(headers: Buffer, needle: string): number {
  const idx = headers.indexOf(needle);
  if (idx < 0) throw new Error(`header substring not found: ${JSON.stringify(needle)}\n${headers.toString()}`);
  return idx;
}

/** To 地址的 reveal 起点，锚定 To 头行内搜索：from==to 的自导邮件中地址首次出现
 *  可能落在 From 头（From 恒在 To 前），全 buffer 首搜会把电路 SelectRegexReveal
 *  锚到 ToAddrRegex 全零掩码区，witness 阶段才炸。 */
export function toAddrIndexInHeaders(headers: Buffer, toEmail: string): number {
  const headerStr = headers.toString("utf8");
  const toHdrMatch = /(?:^|\r\n)to:[^\r\n]*/.exec(headerStr);
  if (!toHdrMatch) throw new Error("cannot locate To header line");
  const toHdrByteOffset = Buffer.byteLength(headerStr.slice(0, toHdrMatch.index + (toHdrMatch[0].startsWith("\r\n") ? 2 : 0)), "utf8");
  const toAddrIdx = headers.indexOf(toEmail, toHdrByteOffset);
  if (toAddrIdx < 0) throw new Error("cannot anchor To address within To header");
  return toAddrIdx;
}

export async function loadClaimEmail(emlPath: string, relayerField: bigint): Promise<LoadedEmail> {
  const rawEmail = fs.readFileSync(emlPath);

  // 1. DKIM verify via REAL DNS (DoH). skipBodyHash=true matches the circuit config.
  const dkimResult = await verifyDKIMSignature(rawEmail, "", true, false, true);
  const headers = dkimResult.headers; // canonicalized signed header bytes
  const headerStr = headers.toString("utf8");

  // 2. Parse fields from the canonicalized headers (relaxed: lowercase names,
  //    unfolded, single spaces; values had leading/trailing WSP stripped).
  const fromMatch = headerStr.match(/(?:^|\r\n)from:[^\r\n]*?([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})/i);
  if (!fromMatch) throw new Error("cannot parse From address");
  const fromEmail = fromMatch[1].toLowerCase();
  const fromDomain = fromEmail.split("@")[1];

  // To 解析（v1.7）：电路对 To 做地址提取 + 小写断言，链下须保证原始 To 地址即小写
  const toMatch = headerStr.match(/(?:^|\r\n)to:[^\r\n]*?<?([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})>?/);
  if (!toMatch) throw new Error("cannot parse To address");
  const toEmail = toMatch[1];
  const rawTo = headerStr.match(/(?:^|\r\n)to:([^\r\n]*)/)![1];
  if (rawTo !== rawTo.toLowerCase()) throw new Error("To address must be lowercase in raw headers (circuit cannot modify signed headers)");

  const subjectMatch = headerStr.match(/(?:^|\r\n)subject:([1-9A-HJ-NP-Za-km-z]{32,44})(?=\r\n)/);
  if (!subjectMatch) {
    throw new Error("Subject is not a bare base58 address (Re:/extra chars/encoding?) — resend via the claim-page format");
  }
  const destBase58 = subjectMatch[1];

  const tMatch = headerStr.match(/(?:^|\r\n)dkim-signature:[^\r\n]*?(\bt=([0-9]+))/);
  if (!tMatch) throw new Error("DKIM-Signature has no t= tag — provider unsupported in v1");
  const timestamp = Number(tMatch[2]);

  // 3. Alignment + freshness guards (mirror on-chain/circuit checks, fail fast off-chain)
  if (dkimResult.signingDomain !== fromDomain) {
    throw new Error(`d=${dkimResult.signingDomain} does not align with From domain ${fromDomain}`);
  }
  const age = Math.floor(Date.now() / 1000) - timestamp;
  if (age > FRESHNESS_SECS) {
    throw new Error(`.eml is ${Math.round(age / 3600)}h old (>${Math.round(FRESHNESS_SECS / 3600)}h window) — re-export a fresh email (see testdata/emails/README.md)`);
  }

  // 4. Base circuit inputs (header-only)
  const baseInputs = await generateEmailVerifierInputsFromDKIMResult(dkimResult, {
    ignoreBodyHashCheck: true,
    maxHeadersLength: MAX_HEADER_LEN,
  });

  // 5. Reveal start indices on the canonicalized header buffer
  const fromIdx = indexOfHeader(headers, fromEmail);
  const subjectIdx = indexOfHeader(headers, destBase58);
  const toAddrIdx = toAddrIndexInHeaders(headers, toEmail);
  const tsIdx = indexOfHeader(headers, `t=${timestamp}`) + 2;
  const atPos = fromEmail.indexOf("@");

  // 6. Public signals
  const commitment = await computeCommitment(fromEmail);
  const domainCommitment = await computeDomainCommitment(fromDomain);
  const pubkeyHash = await computePubkeyHash(dkimResult.publicKey);
  const relayerEmailHash = await computeCommitment(toEmail); // 复用，341 填充与电路一致
  const sig = (baseInputs as any).signature.map((s: string) => BigInt(s));
  const merged: bigint[] = [];
  for (let i = 0; i < 9; i++) merged.push(sig[2 * i] + ((sig[2 * i + 1] ?? 0n) << 121n));
  const emailNullifier = await poseidonHash([await poseidonHash(merged)]); // C9 同构（Poseidon(1)([sigHash])），inputs 组装前算好

  const destBytes = new TextEncoder().encode(destBase58);
  const chunkLE = (b: Uint8Array) => {
    let v = 0n;
    for (let j = b.length - 1; j >= 0; j--) v = (v << 8n) | BigInt(b[j]);
    return v;
  };
  const destA = chunkLE(destBytes.subarray(0, 31));
  const destB = chunkLE(destBytes.subarray(31, MAX_DEST_LEN));

  const inputs: Record<string, unknown> = {
    ...baseInputs,
    fromAddrIdx: String(fromIdx),
    subjectAddrIdx: String(subjectIdx),
    toAddrIdx: String(toAddrIdx),
    timestampIdx: String(tsIdx),
    domainIdx: String(atPos + 1),
    pubkeyHash: pubkeyHash.toString(),
    commitment: commitment.toString(),
    timestamp: String(timestamp),
    relayer: relayerField.toString(),
    destA: destA.toString(),
    destB: destB.toString(),
    domainCommitment: domainCommitment.toString(),
    emailNullifier: emailNullifier.toString(),
    relayerEmailHash: relayerEmailHash.toString(),
  };

  return {
    rawEmail, inputs,
    meta: {
      fromEmail, domain: fromDomain, selector: dkimResult.selector,
      destBase58, timestamp, toEmail,
      commitment: commitment.toString(), pubkeyHash: pubkeyHash.toString(),
      domainCommitment: domainCommitment.toString(),
      destA: destA.toString(), destB: destB.toString(),
      emailNullifier: emailNullifier.toString(),
      relayerEmailHash: relayerEmailHash.toString(),
    },
  };
}
