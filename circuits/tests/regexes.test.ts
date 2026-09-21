import { test } from "@jest/globals";
import path from "path";
import { wasm as wasmTester } from "circom_tester";

// v1.6: ToAddrRegex 从 To 头提取 addr-spec（reveal = 地址本身）。"To 必须是配置的
// relay 地址"的绑定不再由 DFA 完成，而是 claim 电路内 relayerEmailHash == Poseidon(toAddr)
// 加链上与 escrow.relayer_email_hash 比对——此处只测提取语义（裸地址 / 尖括号形态 /
// 全小写 charset / 行尾严格性）。

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

test("ToAddrRegex matches bare and angle-bracket To, reveal = addr bytes only", async () => {
  const c = await load("to_addr_test.circom");
  const subject = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
  // from:alice@test.com\r\n 占 21 字节，to: 之后地址起点 = 24（裸形态）/ 24+11（尖括号形态 "Relay Bob <"）
  for (const [toLine, addrOffset] of [
    ["bob@relay.xyz", 24],
    ["Relay Bob <bob@relay.xyz>", 35],
  ] as Array<[string, number]>) {
    const w = await c.calculateWitness({ msg: pad(headerOf(toLine, subject)) });
    await c.checkConstraints(w);
    await c.assertOut(w, { out: 1 });
    const reveal = Array(1024).fill(0);
    "bob@relay.xyz".split("").forEach((ch, i) => (reveal[addrOffset + i] = ch.charCodeAt(0)));
    await c.assertOut(w, { reveal });
  }
}, 300000);

test("ToAddrRegex rejects uppercase / trailing junk / addr without @", async () => {
  const c = await load("to_addr_test.circom");
  const subject = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
  for (const toLine of [
    "Bob@relay.xyz",        // 大写 local：DFA charset 全小写（链下与电路双重拒绝大写）
    "bob@Relay.xyz",        // 大写 domain
    "bob@relay.xyz extra",  // 行尾垃圾：>?\r\n 必须紧跟 addr-spec
    "bobrelay.xyz",         // 无 @：local charset 虽含 .，但整体无法满足 addr-spec
  ]) {
    const w = await c.calculateWitness({ msg: pad(headerOf(toLine, subject)) });
    await c.assertOut(w, { out: 0 });
  }
}, 300000);

test("SubjectAddrRegex strict full-line: plain address matches", async () => {
  const c = await load("subject_addr_test.circom");
  const w = await c.calculateWitness({ msg: pad(headerOf("bob@relay.xyz", "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM")) });
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
    const w = await c.calculateWitness({ msg: pad(headerOf("bob@relay.xyz", bad)) });
    await c.assertOut(w, { out: 0 });
  }
}, 300000);
