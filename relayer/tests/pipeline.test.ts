// 通知管线去重语义：真实加密 + 桩 notifier/program，不触链。
// 核心断言：notify 成功才标记；重启（重开 store）不重复；失败可重试。
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";
import nacl from "tweetnacl";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createSqliteStore } from "../store/sqlite";
import { sealBytes, sealEmailForRelayer } from "../crypto";
import { computeCommitment } from "../../circuits/scripts/poseidon";
import { buildBatchTree } from "../../circuits/scripts/merkle";
import { processBatch, processEscrow } from "../pipeline";
import { Notifier, NotifyPayload } from "../notify";

function fieldToBE(v: bigint): Buffer {
  const b = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

class RecordingNotifier implements Notifier {
  calls: { to: string; p: NotifyPayload }[] = [];
  failNext = 0; // >0 时接下来 N 次 notify 抛错
  async notify(to: string, p: NotifyPayload): Promise<void> {
    if (this.failNext > 0) { this.failNext--; throw new Error("smtp down"); }
    this.calls.push({ to, p });
  }
}

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayer-pipe-"));
  return { dir, dbPath: path.join(dir, "t.db") };
}

async function makeEscrowFixture(email = "alice@example.com") {
  const kp = nacl.box.keyPair();
  const secret = Buffer.from(kp.secretKey);
  const cipher = sealEmailForRelayer(email, kp.publicKey);
  const commitment = fieldToBE(await computeCommitment(email));
  return { secret, cipher, commitment };
}

async function depsOf(dbPath: string, secret: Buffer, notifier: Notifier) {
  const store = createSqliteStore(dbPath);
  return { deps: { secret, claimBase: "http://localhost:5173/claim/", notifier, store }, store };
}

test("processEscrow：首次通知并标记；再次进入跳过；重开 store（重启）仍跳过", async () => {
  const { dbPath } = tmp();
  const { secret, cipher, commitment } = await makeEscrowFixture();
  const escrowAddr = Keypair.generate().publicKey;
  const notifier = new RecordingNotifier();

  const t1 = await depsOf(dbPath, secret, notifier);
  const r1 = await processEscrow(t1.deps, { commitment, emailCipher: cipher, escrowAddr, sender: Keypair.generate().publicKey, amount: 1000n });
  assert.equal(r1, "notified");
  assert.equal(notifier.calls.length, 1);
  assert.equal(notifier.calls[0].to, "alice@example.com");
  t1.store.close();

  const t2 = await depsOf(dbPath, secret, notifier);
  assert.equal(await processEscrow(t2.deps, { commitment, emailCipher: cipher, escrowAddr, sender: Keypair.generate().publicKey, amount: 1000n }), "already-notified");
  assert.equal(notifier.calls.length, 1); // 没有第二封
  t2.store.close();
});

test("processEscrow：notify 失败不标记，重试可补发", async () => {
  const { dbPath } = tmp();
  const { secret, cipher, commitment } = await makeEscrowFixture();
  const escrowAddr = Keypair.generate().publicKey;
  const notifier = new RecordingNotifier();
  notifier.failNext = 1;

  const t1 = await depsOf(dbPath, secret, notifier);
  const r1 = await processEscrow(t1.deps, { commitment, emailCipher: cipher, escrowAddr, sender: Keypair.generate().publicKey, amount: 1n });
  assert.equal(r1, "notify-failed");
  assert.equal(await t1.store.wasEscrowNotified(escrowAddr.toBase58()), false);
  const r2 = await processEscrow(t1.deps, { commitment, emailCipher: cipher, escrowAddr, sender: Keypair.generate().publicKey, amount: 1n });
  assert.equal(r2, "notified");
  assert.equal(notifier.calls.length, 1);
  t1.store.close();
});

test("processEscrow：commitment 不匹配丢弃且不标记", async () => {
  const { dbPath } = tmp();
  const { secret, cipher } = await makeEscrowFixture();
  const bad = fieldToBE(123n);
  const escrowAddr = Keypair.generate().publicKey;
  const notifier = new RecordingNotifier();
  const t1 = await depsOf(dbPath, secret, notifier);
  const r = await processEscrow(t1.deps, { commitment: bad, emailCipher: cipher, escrowAddr, sender: Keypair.generate().publicKey, amount: 1n });
  assert.equal(r, "commitment-mismatch");
  assert.equal(notifier.calls.length, 0);
  assert.equal(await t1.store.wasEscrowNotified(escrowAddr.toBase58()), false);
  t1.store.close();
});

function fakeProgram(overrides: { relayerEmailHash?: Buffer; recipientsCipher?: Buffer; root?: Buffer } = {}) {
  return {
    account: {
      batch: {
        fetchNullable: async (_: PublicKey) => ({
          relayerEmailHash: overrides.relayerEmailHash ?? Buffer.alloc(32),
          recipientsCipher: overrides.recipientsCipher ?? Buffer.alloc(0),
          sender: Keypair.generate().publicKey,
          amountPerRecipient: { toString: () => "100" },
          merkleRoot: overrides.root ?? Buffer.alloc(32),
        }),
      },
    },
  } as any;
}

test("processBatch：root 校验通过 → 逐收件人通知并标记；同 session 重放与重启重放均跳过", async () => {
  const { dbPath } = tmp();
  const kp = nacl.box.keyPair();
  const secret = Buffer.from(kp.secretKey);
  const ownHash = Buffer.alloc(32, 7);
  const emails = ["a@x.com", "b@x.com", "c@x.com"];
  const commitments: Buffer[] = [];
  for (const e of emails) commitments.push(fieldToBE(await computeCommitment(e)));
  const tree = buildBatchTree(commitments);
  const program = fakeProgram({
    relayerEmailHash: ownHash,
    recipientsCipher: sealBytes(Buffer.from(JSON.stringify(emails), "utf8"), kp.publicKey),
    root: tree.root,
  });
  const batchAddr = Keypair.generate().publicKey;
  const notifier = new RecordingNotifier();

  const t1 = await depsOf(dbPath, secret, notifier);
  const o1 = await processBatch(t1.deps, program, ownHash, batchAddr);
  assert.deepEqual(o1, { status: "processed", notified: 3, alreadyNotified: 0 });
  assert.equal(notifier.calls.length, 3);
  assert.equal((await t1.store.listBatches()).length, 1); // 批次缓存已落库

  const o2 = await processBatch(t1.deps, program, ownHash, batchAddr); // 同 session 重放
  assert.deepEqual(o2, { status: "processed", notified: 0, alreadyNotified: 3 });
  assert.equal(notifier.calls.length, 3);
  t1.store.close();

  const t2 = await depsOf(dbPath, secret, notifier); // 重启重放
  const o3 = await processBatch(t2.deps, program, ownHash, batchAddr);
  assert.deepEqual(o3, { status: "processed", notified: 0, alreadyNotified: 3 });
  assert.equal(notifier.calls.length, 3);
  t2.store.close();
});

test("processBatch：root 不匹配 → skipped，不落缓存不标记", async () => {
  const { dbPath } = tmp();
  const kp = nacl.box.keyPair();
  const secret = Buffer.from(kp.secretKey);
  const ownHash = Buffer.alloc(32, 7);
  const emails = ["a@x.com"];
  const program = fakeProgram({
    relayerEmailHash: ownHash,
    recipientsCipher: sealBytes(Buffer.from(JSON.stringify(emails), "utf8"), kp.publicKey),
    root: Buffer.alloc(32, 9), // 与重建 root 不符
  });
  const notifier = new RecordingNotifier();
  const t1 = await depsOf(dbPath, secret, notifier);
  const o = await processBatch(t1.deps, program, ownHash, Keypair.generate().publicKey);
  assert.deepEqual(o, { status: "skipped" });
  assert.equal(notifier.calls.length, 0);
  assert.equal((await t1.store.listBatches()).length, 0);
  t1.store.close();
});
