import { test } from "@jest/globals";
import path from "path";
import { wasm as wasmTester } from "circom_tester";
import { getRelayAddress } from "../scripts/relay-config";

// v1.5.1: the positive To case must use the CONFIGURED relay address
// (relay.config.json / RELAY_ADDRESS) — it is compiled into the ToPresenceRegex DFA.
const relay = getRelayAddress();
const at = relay.indexOf("@");
const local = relay.slice(0, at);
const domain = relay.slice(at + 1);
const upperFirstAlpha = relay.replace(/[a-z]/, (c) => c.toUpperCase());

const headerOf = (toLine: string, subject: string) =>
  Buffer.from(
    `from:alice@test.com\r\nto:${toLine}\r\nsubject:${subject}\r\ndate:x\r\n`,
    "utf8"
  );

const load = (file: string) =>
  wasmTester(path.join(__dirname, file), {
    output: path.join(__dirname, "../build"),
    include: path.join(__dirname, "../../node_modules"),
    recompile: true, O: 1,
  });

const pad = (h: Buffer) => Array.from(h).concat(Array(1024 - h.length).fill(0));

test(`ToPresenceRegex matches configured relay address to:${relay}`, async () => {
  const c = await load("to_presence_test.circom");
  const w = await c.calculateWitness({ msg: pad(headerOf(relay, "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM")) });
  await c.checkConstraints(w);
  await c.assertOut(w, { out: 1 });
}, 300000);

test("ToPresenceRegex rejects plus-address / other recipients / case mismatch", async () => {
  const c = await load("to_presence_test.circom");
  for (const toLine of [
    `${local}+0123456789abcdef0123456789abcdef@${domain}`, // v1.4 plus-address format
    `other@${domain}`,                                     // different recipient
    `${local}@wrong.example`,                              // different domain
    `x${relay}`,                                           // leading junk before address
    upperFirstAlpha,                                       // case-sensitive: circuit DFA is exact-lowercase
  ]) {
    const w = await c.calculateWitness({ msg: pad(headerOf(toLine, "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM")) });
    await c.assertOut(w, { out: 0 });
  }
}, 300000);

test("SubjectAddrRegex strict full-line: plain address matches", async () => {
  const c = await load("subject_addr_test.circom");
  const w = await c.calculateWitness({ msg: pad(headerOf(relay, "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM")) });
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
    const w = await c.calculateWitness({ msg: pad(headerOf(relay, bad)) });
    await c.assertOut(w, { out: 0 });
  }
}, 300000);
