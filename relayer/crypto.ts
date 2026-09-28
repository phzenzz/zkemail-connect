// relayer 与发送方共享的密封盒加密（单条邮箱 + 批量列表共用同一格式）。
// blob = version(1) || ephemeral_x25519_pk(32) || nonce(24) || ciphertext(XSalsa20-Poly1305)
import nacl from "tweetnacl";
import { computeCommitment } from "../circuits/scripts/poseidon";

export const CIPHER_VERSION = 1;
const HEADER_LEN = 1 + 32 + 24; // 57
export const MAX_CIPHER_LEN = 137; // 与链上 state::MAX_CIPHER_LEN 一致（单发）

/** 任意长度明文密封（批量收件人列表用）；单发的 64B 上限由包装层校验。 */
export function sealBytes(plaintext: Buffer, relayerPk: Uint8Array): Buffer {
  const eph = nacl.box.keyPair();
  const nonce = nacl.randomBytes(24);
  const box = nacl.box(plaintext, nonce, relayerPk, eph.secretKey);
  const blob = Buffer.alloc(HEADER_LEN + box.length);
  blob[0] = CIPHER_VERSION;
  blob.set(eph.publicKey, 1);
  blob.set(nonce, 33);
  blob.set(box, HEADER_LEN);
  return blob;
}

export function openBytes(blob: Buffer, relayerSecret: Uint8Array): Buffer | null {
  if (blob.length <= HEADER_LEN || blob[0] !== CIPHER_VERSION) return null;
  const nonce = blob.subarray(33, HEADER_LEN);
  const ct = blob.subarray(HEADER_LEN);
  const ephPk = blob.subarray(1, 33);
  const opened = nacl.box.open(ct, nonce, ephPk, relayerSecret);
  return opened ? Buffer.from(opened) : null;
}

export function sealEmailForRelayer(email: string, relayerPk: Uint8Array): Buffer {
  const plaintext = Buffer.from(email, "utf8");
  if (plaintext.length > 64) throw new Error("email too long (max 64 bytes)");
  return sealBytes(plaintext, relayerPk);
}

export function openEmailCipher(blob: Buffer, relayerSecret: Uint8Array): string | null {
  const opened = openBytes(blob, relayerSecret);
  return opened ? opened.toString("utf8") : null;
}

export async function relayerEmailHash(email: string): Promise<Buffer> {
  const h = await computeCommitment(email); // trim + lowercase + Poseidon(341 填充)
  let v = h;
  const b = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}
