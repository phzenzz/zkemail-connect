import { expect, test } from "@jest/globals";
import { packBytesLE, computeCommitment, computeDomainCommitment, computePubkeyHash, relayerToField } from "../scripts/poseidon";

test("packBytesLE: 31 bytes per chunk, little-endian, zero pad", () => {
  const chunks = packBytesLE(new Uint8Array([1, 2, 3]), 62); // 2 chunks
  expect(chunks.length).toBe(2);
  expect(chunks[0]).toBe(1n + 2n * 256n + 3n * 65536n);
  expect(chunks[1]).toBe(0n);
});

test("relayerToField: pubkey mod Fr", () => {
  const FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const pk = new Uint8Array(32); pk[31] = 0xff;
  expect(relayerToField(pk)).toBe(255n % FR);
});

test("computeCommitment: deterministic + case-insensitive + trim", async () => {
  const a = await computeCommitment("Alice@Test.com");
  const b = await computeCommitment("  alice@test.com ");
  expect(a).toBe(b);
});

test("computeCommitment / computeDomainCommitment: stable shape", async () => {
  const c = await computeCommitment("alice@test.com");
  const d = await computeDomainCommitment("test.com");
  expect(typeof c).toBe("bigint");
  expect(c).toBeGreaterThan(0n);
  expect(d).toBeGreaterThan(0n);
});

test("computePubkeyHash: 2048-bit modulus (odd limb count, unpaired top limb)", async () => {
  const h = await computePubkeyHash((1n << 2048n) - 1n);
  expect(typeof h).toBe("bigint");
  expect(h).toBeGreaterThan(0n);
});

test("computePubkeyHash: deterministic, distinct per modulus", async () => {
  const m1 = (1n << 2048n) - 1n;
  const m2 = (1n << 2047n) - 1n;
  const a = await computePubkeyHash(m1);
  const b = await computePubkeyHash(m1);
  const c = await computePubkeyHash(m2);
  expect(a).toBe(b);
  expect(a).not.toBe(c);
});
