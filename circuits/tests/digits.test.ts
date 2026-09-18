import { expect, test } from "@jest/globals";
import path from "path";
import { wasm as wasmTester } from "circom_tester";

const load = (file: string) =>
  wasmTester(path.join(__dirname, file), {
    output: path.join(__dirname, "../build"),
    include: path.join(__dirname, "../../node_modules"),
    recompile: true, O: 1,
  });

// "1758000000" as ASCII bytes + n zero padding bytes
const input = (s: string, padZeros: number) =>
  Array.from(Buffer.from(s, "ascii")).concat(Array(padZeros).fill(0));

test("Digit2IntStrict: 10-digit timestamp + 2 pad zeros -> raw value (no scaling)", async () => {
  const c = await load("digits_test.circom");
  const w = await c.calculateWitness({ in: input("1758000000", 2) });
  await c.checkConstraints(w);
  await c.assertOut(w, { out: 1758000000 });
}, 300000);

test("Digit2IntStrict: 3-digit value + 9 pad zeros -> 999", async () => {
  const c = await load("digits_test.circom");
  const w = await c.calculateWitness({ in: input("999", 9) });
  await c.checkConstraints(w);
  await c.assertOut(w, { out: 999 });
}, 300000);

test("Digit2IntStrict: non-contiguous padding fails witness generation", async () => {
  const c = await load("digits_test.circom");
  // "12\x003": byte 3 is zero, byte 4 is '3' — padding not contiguous
  const bad = [49, 50, 0, 51, 0, 0, 0, 0, 0, 0, 0, 0];
  await expect(c.calculateWitness({ in: bad })).rejects.toThrow();
}, 300000);

test("Digit2IntStrict: leading zero byte fails witness generation", async () => {
  const c = await load("digits_test.circom");
  const bad = [0, 49, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  await expect(c.calculateWitness({ in: bad })).rejects.toThrow();
}, 300000);
