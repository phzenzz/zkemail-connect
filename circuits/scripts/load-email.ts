import fs from "fs";
import { verifyDKIMSignature } from "@zk-email/helpers/dist/dkim";
import { generateEmailVerifierInputsFromDKIMResult } from "@zk-email/helpers";
import {
  computeCommitment, computeDomainCommitment, computePubkeyHash,
} from "./poseidon";

export const MAX_HEADER_LEN = 1024;
export const MAX_DEST_LEN = 44;
const FRESHNESS_SECS = 48 * 3600; // 与链上 TIMESTAMP_WINDOW_PAST 对齐

export interface LoadedEmail {
  rawEmail: Buffer;
  inputs: Record<string, unknown>;
  meta: {
    fromEmail: string; domain: string; selector: string;
    destBase58: string; timestamp: number;
    commitment: string;
    pubkeyHash: string; domainCommitment: string; destA: string; destB: string;
  };
}

/** Find byte offset of `needle` in canonicalized headers; throws if absent. */
function indexOfHeader(headers: Buffer, needle: string): number {
  const idx = headers.indexOf(needle);
  if (idx < 0) throw new Error(`header substring not found: ${JSON.stringify(needle)}\n${headers.toString()}`);
  return idx;
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

  // v1.5: To is the fixed system mailbox claim@relay.xyz (match-only presence check
  // in-circuit; same exact-lowercase pattern as ToPresenceRegex — no /i: the circuit
  // DFA is case-sensitive, so reject uppercase here with a clear error).
  if (!/(?:^|\r\n)to:claim@relay\.xyz(?:\r\n)/.test(headerStr)) {
    throw new Error("To is not claim@relay.xyz");
  }

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
    throw new Error(`.eml is ${Math.round(age / 3600)}h old (>48h window) — re-export a fresh email (see testdata/emails/README.md)`);
  }

  // 4. Base circuit inputs (header-only)
  const baseInputs = await generateEmailVerifierInputsFromDKIMResult(dkimResult, {
    ignoreBodyHashCheck: true,
    maxHeadersLength: MAX_HEADER_LEN,
  });

  // 5. Reveal start indices on the canonicalized header buffer
  const fromIdx = indexOfHeader(headers, fromEmail);
  const subjectIdx = indexOfHeader(headers, destBase58);
  const tsIdx = indexOfHeader(headers, `t=${timestamp}`) + 2;
  const atPos = fromEmail.indexOf("@");

  // 6. Public signals
  const commitment = await computeCommitment(fromEmail);
  const domainCommitment = await computeDomainCommitment(fromDomain);
  const pubkeyHash = await computePubkeyHash(dkimResult.publicKey);

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
    timestampIdx: String(tsIdx),
    domainIdx: String(atPos + 1),
    pubkeyHash: pubkeyHash.toString(),
    commitment: commitment.toString(),
    timestamp: String(timestamp),
    relayer: relayerField.toString(),
    destA: destA.toString(),
    destB: destB.toString(),
    domainCommitment: domainCommitment.toString(),
  };

  return {
    rawEmail, inputs,
    meta: {
      fromEmail, domain: fromDomain, selector: dkimResult.selector,
      destBase58, timestamp,
      commitment: commitment.toString(), pubkeyHash: pubkeyHash.toString(),
      domainCommitment: domainCommitment.toString(),
      destA: destA.toString(), destB: destB.toString(),
    },
  };
}
