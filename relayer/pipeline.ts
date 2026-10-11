// 通知管线：解密 → 哈希校验 → 已通知去重（store）→ 通知 → 成功后落已通知记录。
// indexer 的启动回填与事件订阅共用本模块；去重使重启回填/同 session 重放均幂等（at-least-once）。
import { PublicKey } from "@solana/web3.js";
import { computeCommitment } from "../circuits/scripts/poseidon";
import { buildBatchTree } from "../circuits/scripts/merkle";
import { openBytes, openEmailCipher } from "./crypto";
import { RelayerStore } from "./store";
import { Notifier } from "./notify";

export type EscrowOutcome =
  | "notified" | "already-notified" | "notify-failed"
  | "decrypt-failed" | "commitment-mismatch";

export type BatchOutcome =
  | { status: "processed"; notified: number; alreadyNotified: number }
  | { status: "skipped" };

export interface PipelineDeps {
  secret: Buffer; // x25519 私钥（32B）
  claimBase: string;
  notifier: Notifier;
  store: RelayerStore;
}

function fieldToBE(v: bigint): Buffer {
  const b = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

/** 单发托管：去重 → 解密 → commitment 校验 → 通知 → 成功后标记。 */
export async function processEscrow(
  deps: PipelineDeps,
  args: { commitment: Buffer; emailCipher: Buffer; escrowAddr: PublicKey; sender: PublicKey; amount: bigint },
): Promise<EscrowOutcome> {
  const addr = args.escrowAddr.toBase58();
  if (await deps.store.wasEscrowNotified(addr)) return "already-notified";
  const recipient = openEmailCipher(args.emailCipher, deps.secret);
  if (!recipient) {
    console.error(`[indexer] ${addr}: decrypt failed, drop`);
    return "decrypt-failed";
  }
  const expected = fieldToBE(await computeCommitment(recipient));
  if (expected.compare(args.commitment) !== 0) {
    console.error(`[indexer] ${addr}: commitment mismatch, drop`);
    return "commitment-mismatch";
  }
  try {
    await deps.notifier.notify(recipient, {
      escrow: addr,
      sender: args.sender.toBase58(),
      amount: args.amount.toString(),
      claimUrl: deps.claimBase + addr,
    });
  } catch (e) {
    console.error(`[indexer] notify ${recipient} failed:`, (e as Error)?.message ?? e);
    return "notify-failed"; // 不标记，重试安全
  }
  await deps.store.markEscrowNotified(addr, recipient);
  console.log(`[indexer] escrow ${addr}: notified ${recipient}`);
  return "notified";
}

/** 批量空投：relayer 过滤 → 解密列表 → 重算 root 比对 → 落缓存 → 逐收件人（leafIndex = 数组下标）去重通知。 */
export async function processBatch(
  deps: PipelineDeps, program: any, ownHash: Buffer, batchAddr: PublicKey,
): Promise<BatchOutcome> {
  const addr = batchAddr.toBase58();
  const acc = await program.account.batch.fetchNullable(batchAddr);
  if (!acc) return { status: "skipped" };
  if (Buffer.from(acc.relayerEmailHash).compare(ownHash) !== 0) return { status: "skipped" };
  const opened = openBytes(Buffer.from(acc.recipientsCipher), deps.secret);
  if (!opened) {
    console.error(`[indexer] batch ${addr}: decrypt failed, drop`);
    return { status: "skipped" };
  }
  let emails: string[];
  try {
    emails = JSON.parse(opened.toString("utf8"));
    if (!Array.isArray(emails) || emails.some((e) => typeof e !== "string")) throw new Error("bad shape");
  } catch {
    console.error(`[indexer] batch ${addr}: bad email list, drop`);
    return { status: "skipped" };
  }
  const commitments: Buffer[] = [];
  for (const e of emails) commitments.push(fieldToBE(await computeCommitment(e)));
  const tree = buildBatchTree(commitments);
  if (tree.root.compare(Buffer.from(acc.merkleRoot)) !== 0) {
    console.error(`[indexer] batch ${addr}: root mismatch, drop`);
    return { status: "skipped" };
  }
  await deps.store.saveBatch({ batch: addr, root: tree.root.toString("hex"), emails });
  let notified = 0;
  let alreadyNotified = 0;
  for (let i = 0; i < emails.length; i++) {
    if (await deps.store.wasBatchRecipientNotified(addr, i)) { alreadyNotified++; continue; }
    try {
      await deps.notifier.notify(emails[i], {
        escrow: addr,
        sender: (acc.sender as PublicKey).toBase58(),
        amount: acc.amountPerRecipient.toString(),
        claimUrl: deps.claimBase + addr,
      });
    } catch (e) {
      console.error(`[indexer] notify ${emails[i]} failed:`, (e as Error)?.message ?? e);
      continue; // 不标记，重试安全
    }
    await deps.store.markBatchRecipientNotified(addr, i, emails[i]);
    notified++;
  }
  console.log(`[indexer] batch ${addr}: ${notified} notified, ${alreadyNotified} already notified (${emails.length} total)`);
  return { status: "processed", notified, alreadyNotified };
}
