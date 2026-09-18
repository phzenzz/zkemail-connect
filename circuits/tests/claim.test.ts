import { beforeAll, expect, jest, test } from "@jest/globals";
import path from "path";
import fs from "fs";
import { wasm as wasmTester } from "circom_tester";
import { loadClaimEmail, LoadedEmail } from "../scripts/load-email";

// v1.5 circuit (7 public signals, MAX_HEADER_LEN=1024, --O2): witness calc on a
// ~2.7M-constraint circuit is heavy — ~70s per test.
jest.setTimeout(900_000);

const EML = path.join(__dirname, "../testdata/emails/claim.eml");

let circuit: any;
let good: LoadedEmail;

beforeAll(async () => {
  if (!fs.existsSync(EML)) {
    throw new Error("missing testdata/emails/claim.eml — 按 testdata/emails/README.md 导出真实邮件");
  }
  // Same constraint system as production (compile.sh --O2), reusing the existing
  // build/claim_js/claim.wasm from the v1.5.1 rebuild (recompile: false).
  // node_modules is hoisted to the repo root (no circuits/node_modules).
  circuit = await wasmTester(path.join(__dirname, "../src/claim.circom"), {
    output: path.join(__dirname, "../build"),
    include: path.join(__dirname, "../../node_modules"),
    recompile: false,
    O: 2,
  });
  good = await loadClaimEmail(EML, 42n);
});

test("valid claim email satisfies constraints and public signals", async () => {
  // 7 个公开信号是 main 的 public inputs，与计算值的相等性由电路内 `===` 约束强制：
  // witness 能算出且 checkConstraints 通过 ⇔ TS 侧 poseidon/打包与电路完全一致（测试向量锁死）。
  // 同时回答了 Task 4 review 的两个问题：(a) EmailDomainRegex 在 zero-padded fromAddr
  // 窗口上匹配；(b) 真实 QQ canonicalized header（320B，MAX_HEADER_LEN=1024 内）上
  // From/ToPresence/Subject/Timestamp/EmailDomain 五条 regex 全部命中。
  const w = await circuit.calculateWitness(good.inputs, true);
  await circuit.checkConstraints(w);
});

test("tampered dest in public signals fails", async () => {
  const bad = { ...good.inputs, destA: "1" };
  await expect(circuit.calculateWitness(bad, true)).rejects.toThrow();
});

test("tampered commitment fails", async () => {
  const bad = { ...good.inputs, commitment: "12345" };
  await expect(circuit.calculateWitness(bad, true)).rejects.toThrow();
});

test("tampered timestamp fails", async () => {
  const bad = { ...good.inputs, timestamp: String(good.meta.timestamp + 1) };
  await expect(circuit.calculateWitness(bad, true)).rejects.toThrow();
});

test("tampered domainCommitment fails", async () => {
  const bad = { ...good.inputs, domainCommitment: "12345" };
  await expect(circuit.calculateWitness(bad, true)).rejects.toThrow();
});

test("email with tampered subject (Re: prefix) fails DKIM verify at input generation", async () => {
  // 真实邮件改一个字节就破坏 DKIM——同时验证 SubjectAddrRegex 的严格匹配语义由
  // Task 3 的 regex 单测覆盖（Re: 前缀 / 多余字符 / 长度越界 / 非法字符四例）。
  const tampered = Buffer.from(
    good.rawEmail.toString().replace(`Subject: ${good.meta.destBase58}`, `Subject: Re: ${good.meta.destBase58}`)
  );
  const { generateEmailVerifierInputs } = await import("@zk-email/helpers");
  await expect(generateEmailVerifierInputs(tampered, { ignoreBodyHashCheck: true })).rejects.toThrow();
});
