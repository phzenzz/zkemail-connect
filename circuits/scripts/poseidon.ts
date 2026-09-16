import { buildPoseidon } from "circomlibjs";

const FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const EMAIL_PADDED_LEN = 341;   // 11 * 31
export const DOMAIN_PADDED_LEN = 124;  // 4 * 31

let poseidonPromise: Promise<any> | null = null;
async function getPoseidon() {
  if (!poseidonPromise) poseidonPromise = buildPoseidon();
  return poseidonPromise;
}

export async function poseidonHash(inputs: bigint[]): Promise<bigint> {
  const p = await getPoseidon();
  return BigInt(p.F.toString(p(inputs)));
}

/** 31 bytes per chunk, little-endian within chunk, zero-padded to totalLen. */
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

export async function computeNullifier(email: string, escrowIdField: bigint): Promise<bigint> {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase());
  return poseidonHash([...packBytesLE(bytes, EMAIL_PADDED_LEN), escrowIdField]);
}

/** PoseidonLarge(121,17): RSA modulus n split into 17 limbs of 121 bits (LE), merged pairwise. */
export async function computePubkeyHash(modulus: bigint): Promise<bigint> {
  const limbs: bigint[] = [];
  let rem = modulus;
  const mask = (1n << 121n) - 1n;
  for (let i = 0; i < 17; i++) { limbs.push(rem & mask); rem >>= 121n; }
  const merged: bigint[] = [];
  for (let i = 0; i < 9; i++) merged.push(limbs[2 * i] + (limbs[2 * i + 1] << 121n));
  return poseidonHash(merged);
}

export function escrowIdToField(id: Uint8Array): bigint {
  if (id.length !== 16) throw new Error("escrow id must be 16 bytes");
  let v = 0n;
  for (const b of id) v = (v << 8n) | BigInt(b); // big-endian
  return v;
}

export function relayerToField(pubkeyBytes32: Uint8Array): bigint {
  let v = 0n;
  for (const b of pubkeyBytes32) v = (v << 8n) | BigInt(b); // big-endian
  return v % FR;
}
