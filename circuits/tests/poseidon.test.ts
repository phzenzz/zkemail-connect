import { expect, test } from "@jest/globals";
import { packBytesLE, computeCommitment, computeDomainCommitment, computeNullifier, escrowIdToField, relayerToField } from "../scripts/poseidon";

test("packBytesLE: 31 bytes per chunk, little-endian, zero pad", () => {
  const chunks = packBytesLE(new Uint8Array([1, 2, 3]), 62); // 2 chunks
  expect(chunks.length).toBe(2);
  expect(chunks[0]).toBe(1n + 2n * 256n + 3n * 65536n);
  expect(chunks[1]).toBe(0n);
});

test("escrowIdToField: big-endian", () => {
  const id = new Uint8Array(16); id[15] = 0x2a;
  expect(escrowIdToField(id)).toBe(42n);
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

test("computeNullifier / computeDomainCommitment: stable shape", async () => {
  const n = await computeNullifier("alice@test.com", 42n);
  const d = await computeDomainCommitment("test.com");
  expect(typeof n).toBe("bigint");
  expect(d).toBeGreaterThan(0n);
});
