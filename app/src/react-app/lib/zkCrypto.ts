// 与 circuits/scripts/poseidon.ts + relayer/crypto.ts 同构的浏览器安全实现(纯 Uint8Array,无 Buffer)。
import { buildPoseidon } from "circomlibjs";
import nacl from "tweetnacl";

const FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const EMAIL_PADDED_LEN = 341;
export const DOMAIN_PADDED_LEN = 124;
export const DEST_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const MAX_CIPHER_LEN = 137;

let poseidonPromise: Promise<any> | null = null;
function getPoseidon() {
  if (!poseidonPromise) poseidonPromise = buildPoseidon();
  return poseidonPromise;
}

export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const p = await getPoseidon();
  return BigInt(p.F.toString(p(inputs)));
}

export function packBytesLE(bytes: Uint8Array, totalLen: number): bigint[] {
  if (bytes.length > totalLen) throw new Error("input too long");
  const nChunks = Math.ceil(totalLen / 31);
  const chunks: bigint[] = [];
  for (let c = 0; c < nChunks; c++) {
    let v = 0n;
    for (let j = 30; j >= 0; j--) {
      const idx = c * 31 + j;
      v = (v << 8n) | (idx < bytes.length ? BigInt(bytes[idx]) : 0n);
    }
    chunks.push(v);
  }
  return chunks;
}

export async function computeCommitment(email: string): Promise<bigint> {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  return poseidonHash(packBytesLE(bytes, EMAIL_PADDED_LEN));
}

export async function computeDomainCommitment(domain: string): Promise<bigint> {
  const bytes = new TextEncoder().encode(domain.trim().toLowerCase());
  return poseidonHash(packBytesLE(bytes, DOMAIN_PADDED_LEN));
}

export function fieldToBE32(v: bigint): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

export function relayerToField(pk: Uint8Array): bigint {
  let v = 0n;
  for (const b of pk) v = (v << 8n) | BigInt(b);
  return v % FR;
}

const CIPHER_VERSION = 1;
const HEADER_LEN = 1 + 32 + 24;

/** blob = version(1) || eph_x25519_pk(32) || nonce(24) || XSalsa20-Poly1305 密文 */
export function sealEmailForRelayer(email: string, relayerPk: Uint8Array): Uint8Array {
  const plaintext = new TextEncoder().encode(email);
  if (plaintext.length > 64) throw new Error("email too long (max 64 bytes)");
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);
  const box = nacl.box(plaintext, nonce, relayerPk, eph.secretKey);
  if (!box) throw new Error("seal failed");
  const blob = new Uint8Array(HEADER_LEN + box.length);
  blob[0] = CIPHER_VERSION;
  blob.set(eph.publicKey, 1);
  blob.set(nonce, 33);
  blob.set(box, HEADER_LEN);
  if (blob.length > MAX_CIPHER_LEN) throw new Error("cipher too long");
  return blob;
}
