import { beforeAll, expect, jest, test } from "@jest/globals";
import path from "path";
import fs from "fs";
import { wasm as wasmTester } from "circom_tester";
import { loadClaimEmail, LoadedEmail } from "../scripts/load-email";

// v1.6 circuit (9 public signals, MAX_HEADER_LEN=1024, --O2): witness calc on a
// ~3M-constraint circuit is heavy — ~70s per test.
jest.setTimeout(900_000);

const EML = path.join(__dirname, "../testdata/emails/claim.eml");

let circuit: any;
let good: LoadedEmail;

beforeAll(async () => {
  if (!fs.existsSync(EML)) {
    throw new Error("missing testdata/emails/claim.eml — 按 testdata/emails/README.md 导出真实邮件");
  }
  // Same constraint system as production (compile.sh --O2): run scripts/compile.sh
  // first — with recompile:false this reuses the freshly built build/claim_js/claim.wasm
  // (node_modules is hoisted to the repo root, so no circuits/node_modules).
  circuit = await wasmTester(path.join(__dirname, "../src/claim.circom"), {
    output: path.join(__dirname, "../build"),
    include: path.join(__dirname, "../../node_modules"),
    recompile: false,
    O: 2,
  });
  good = await loadClaimEmail(EML, 42n);

  // Task 1 过渡期：电路新增 3 个 witness 输入（toAddrIdx / emailNullifier / relayerEmailHash），
  // load-email.ts 到 Task 4 才扩展——在此从已加载输入自行推导（与电路/链下同源），保证
  // calculateWitness 输入完备；Task 4 将删除此段、改为 loadClaimEmail 直出。
  const { computeCommitment, poseidonHash } = await import("../scripts/poseidon");
  const emailHeader: string[] = (good.inputs as any).emailHeader;
  const headerLen = Number((good.inputs as any).emailHeaderLength);
  const headerStr = Buffer.from(emailHeader.slice(0, headerLen).map((x) => Number(x))).toString();
  const toEmail = headerStr
    .match(/(?:^|\r\n)to:[^\r\n]*?<?([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})>?/i)![1]
    .toLowerCase();
  const toAddrIdx = headerStr.indexOf(toEmail); // SelectRegexReveal 起点 = 地址在 canonicalized headers 中的偏移
  const sig: string[] = (good.inputs as any).signature; // 十进制 limb 数组
  const merged: bigint[] = [];
  for (let i = 0; i < 9; i++) merged.push(BigInt(sig[2 * i]) + (BigInt(sig[2 * i + 1] ?? "0") << 121n));
  const sigHash = await poseidonHash(merged);
  good.inputs = {
    ...good.inputs,
    toAddrIdx: String(toAddrIdx),
    emailNullifier: (await poseidonHash([sigHash])).toString(),
    relayerEmailHash: (await computeCommitment(toEmail)).toString(),
  };
});

test("valid claim email satisfies constraints and public signals", async () => {
  // 9 个公开信号是 main 的 public inputs，与计算值的相等性由电路内 `===` 约束强制：
  // witness 能算出且 checkConstraints 通过 ⇔ TS 侧 poseidon/打包与电路完全一致（测试向量锁死）。
  // 同时回答了 Task 4 review 的两个问题：(a) EmailDomainRegex 在 zero-padded fromAddr
  // 窗口上匹配；(b) 真实 QQ canonicalized header（320B，MAX_HEADER_LEN=1024 内）上
  // From/ToAddr/Subject/Timestamp/EmailDomain 五条 regex 全部命中。
  const w = await circuit.calculateWitness(good.inputs, true);
  await circuit.checkConstraints(w);

  // 9 个 public signals：w[1..9] 顺序 = main public 列表
  const pub = w.slice(1, 10).map((x: bigint) => x.toString());
  expect(pub).toHaveLength(9);
  // [8]=relayerEmailHash：与链下同源计算值一致（锁死测试向量）
  const { computeCommitment } = await import("../scripts/poseidon");
  const toEmail = good.rawEmail.toString()
    .match(/(?:^|\r\n)to:[^\r\n]*?<?([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})>?/i)![1]
    .toLowerCase();
  expect(pub[8]).toBe((await computeCommitment(toEmail)).toString());

  // 与电路 C9 同构：17 limbs 合并为 9 → Poseidon(9) → Poseidon(1)
  const { poseidonHash } = await import("../scripts/poseidon");
  const sig: string[] = (good.inputs as any).signature; // 十进制 limb 数组
  const merged: bigint[] = [];
  for (let i = 0; i < 9; i++) merged.push(BigInt(sig[2 * i]) + (BigInt(sig[2 * i + 1] ?? "0") << 121n));
  const sigHash = await poseidonHash(merged);
  expect(pub[7]).toBe((await poseidonHash([sigHash])).toString());
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

test("tampered emailNullifier fails", async () => {
  const bad = { ...good.inputs, emailNullifier: "12345" };
  await expect(circuit.calculateWitness(bad, true)).rejects.toThrow();
});

test("tampered relayerEmailHash fails", async () => {
  const bad = { ...good.inputs, relayerEmailHash: "12345" };
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
