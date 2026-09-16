import { test } from "@jest/globals";
import path from "path";
import { wasm as wasmTester } from "circom_tester";

const headerOf = (subject: string) =>
  Buffer.from(
    `from:alice@test.com\r\nto:claim+${"a".repeat(32)}@relay.xyz\r\nsubject:${subject}\r\ndate:x\r\n`,
    "utf8"
  );

const load = (file: string) =>
  wasmTester(path.join(__dirname, file), {
    output: path.join(__dirname, "../build"),
    include: path.join(__dirname, "../../node_modules"),
    recompile: true, O: 1,
  });

const pad = (h: Buffer) => Array.from(h).concat(Array(1024 - h.length).fill(0));

test("ClaimToRegex reveals 32 hex chars", async () => {
  const c = await load("claim_to_test.circom");
  const w = await c.calculateWitness({ msg: pad(headerOf("4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM")) });
  await c.checkConstraints(w);
  await c.assertOut(w, { out: 1 });
}, 300000);

test("SubjectAddrRegex strict full-line: plain address matches", async () => {
  const c = await load("subject_addr_test.circom");
  const w = await c.calculateWitness({ msg: pad(headerOf("4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM")) });
  await c.checkConstraints(w);
  await c.assertOut(w, { out: 1 });
}, 300000);

test("SubjectAddrRegex rejects Re: prefix / trailing chars / too-short / bad alphabet", async () => {
  const c = await load("subject_addr_test.circom");
  for (const bad of [
    "Re: 4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM",
    "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM extra",
    "4uQeVj5tqViQh7yWWGStvkEG1Z",           // 25 chars
    "0uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", // '0' not in base58
  ]) {
    const w = await c.calculateWitness({ msg: pad(headerOf(bad)) });
    await c.assertOut(w, { out: 0 });
  }
}, 300000);
