import { Connection, PublicKey } from "@solana/web3.js";
import { utils, type Program } from "@coral-xyz/anchor";

/**
 * Send 页「发送记录」的链上解析逻辑（与 UI 解耦，e2e/check-send-history.ts 直接引用本文件自测）。
 *
 * 数据来源：发送方地址的签名历史。逐笔 getParsedTransaction 找到发往本程序的
 * createEscrow / createBatch 指令，blockTime 即发送时间；再一次性拉取全部托管
 * 账户判断领取情况：
 *   - escrow 仍在链 = 待领取；已被 claim 关闭 = 已领取
 *   - batch 在链 = 已领取 claimed/leaf_count（另有 sealed / 过期）；已被 close_batch 关闭 = 已关闭
 */

/** 扫描发送方最近 N 笔交易（RPC 调用量与 N 成正比）。 */
export const SEND_HISTORY_LIMIT = 50;

const PARSE_CONCURRENCY = 8;

export type SentItem = {
  kind: "escrow" | "batch";
  /** 托管地址：escrow / batch PDA，资金托管与领取都发生在这里 */
  pda: string;
  mint: string;
  sig: string;
  /** 交易所在区块时间（秒）；RPC 未返回时排最后 */
  createdAt: number | null;
  /** escrow 为全额；batch 为每人金额 */
  amountPer: bigint;
  /** 收款人数（escrow 固定 1） */
  count: number;
};

export type SentStatus =
  | { state: "pending" } // escrow 仍在链上：待领取
  | { state: "claimed" } // escrow 账户已被 claim 关闭：已领取
  | { state: "open"; claimed: number; count: number; sealed: boolean; expired: boolean }
  | { state: "closed" }; // batch 已关闭（全部领完或过期退款）

export type SentEntry = SentItem & { status: SentStatus };

/** 简单并发限制：一次性发 50 个 getParsedTransaction 会打爆公共 RPC。 */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * getParsedTransaction 对不认识的程序返回「部分解码」指令：
 * 运行时 data 是 base58 字符串、accounts 是 base58 字符串数组（web3.js 类型标注与运行时不符，两边都兼容）。
 */
function ixDataBytes(data: unknown): Buffer | null {
  if (typeof data === "string") return utils.bytes.bs58.decode(data);
  if (data instanceof Uint8Array) return Buffer.from(data);
  return null;
}

/**
 * getParsedTransaction 对不认识的程序返回「部分解码」指令：
 * 运行时 data 是 base58 字符串、accounts 元素可能是 PublicKey 对象（类型标注与运行时不符，做鸭子类型兼容）。
 * 注意不能只用 instanceof PublicKey 判断——monorepo 里 app/ 与根目录可能各装一份 @solana/web3.js，
 * 跨副本 instanceof 会误判（e2e 脚本引用本文件时即如此）。
 */
function toBase58(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof (v as { toBase58?: unknown }).toBase58 === "function") {
    return (v as { toBase58: () => string }).toBase58();
  }
  return null;
}

function asBigInt(v: unknown): bigint {
  return BigInt((v as { toString(): string }).toString());
}

export async function fetchSentHistory(
  connection: Connection,
  program: Program,
  programId: PublicKey,
  sender: PublicKey,
): Promise<SentEntry[]> {
  const sigs = await connection.getSignaturesForAddress(sender, { limit: SEND_HISTORY_LIMIT }, "confirmed");
  const okSigs = sigs.filter((s) => s.err === null);
  const txs = await mapLimit(okSigs, PARSE_CONCURRENCY, (s) =>
    connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null),
  );

  // 签名历史本身新→旧；同一块里时间相同，稳定排序后仍保持新→旧
  const seen = new Set<string>();
  const items: SentItem[] = [];
  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i];
    if (!tx) continue;
    const instructions = tx.transaction.message.instructions ?? [];
    for (const raw of instructions) {
      const ix = raw as { programId?: unknown; data?: unknown; accounts?: unknown };
      if (toBase58(ix?.programId) !== programId.toBase58()) continue;
      const data = ixDataBytes(ix.data);
      if (!data) continue;
      let decoded: { name: string; data: Record<string, unknown> } | null = null;
      try {
        const coder = program.coder.instruction as unknown as {
          decode: (d: Buffer) => { name: string; data: Record<string, unknown> } | null;
        };
        decoded = coder.decode(data);
      } catch {
        decoded = null;
      }
      if (!decoded) continue;
      const accounts = Array.isArray(ix.accounts) ? ix.accounts.map(toBase58) : [];
      // 防御：只统计本地址签发的创建指令（同程序其他指令/其他发送者一律跳过）
      if (!accounts.includes(sender.toBase58())) continue;
      const pda = accounts[0];
      if (!pda || seen.has(pda)) continue;

      if (decoded.name === "createEscrow") {
        seen.add(pda);
        items.push({
          kind: "escrow",
          pda,
          mint: accounts[2] ?? "",
          sig: okSigs[i].signature,
          createdAt: tx.blockTime ?? null,
          amountPer: asBigInt(decoded.data.amount),
          count: 1,
        });
      } else if (decoded.name === "createBatch") {
        seen.add(pda);
        items.push({
          kind: "batch",
          pda,
          mint: accounts[2] ?? "",
          sig: okSigs[i].signature,
          createdAt: tx.blockTime ?? null,
          amountPer: asBigInt(decoded.data.amountPerRecipient),
          count: Number(decoded.data.leafCount),
        });
      }
    }
  }
  items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

  // 领取情况：一次 getMultipleAccountsInfo 拉全部托管账户；存在的解码读进度，不存在即已被关闭
  const infos = await connection.getMultipleAccountsInfo(
    items.map((it) => new PublicKey(it.pda)),
    "confirmed",
  );
  const statusOf = new Map<string, SentStatus>();
  items.forEach((it, idx) => {
    const info = infos[idx];
    if (it.kind === "escrow") {
      statusOf.set(it.pda, info ? { state: "pending" } : { state: "claimed" });
      return;
    }
    if (!info) {
      statusOf.set(it.pda, { state: "closed" });
      return;
    }
    try {
      const coder = program.coder.accounts as unknown as {
        decode: (name: string, d: Buffer) => unknown;
      };
      // Program 构造时会将 IDL 全部转成小驼峰（Batch → batch），名字从 program.idl 里现取
      const batchName =
        (program.idl.accounts ?? []).map((a) => a.name).find((n) => n.toLowerCase() === "batch") ?? "batch";
      const acc = coder.decode(batchName, info.data) as {
        claimedCount: { toString(): string };
        leafCount: { toString(): string };
        sealed: boolean;
        expireAt: { toString(): string };
      };
      statusOf.set(it.pda, {
        state: "open",
        claimed: Number(acc.claimedCount.toString()),
        count: Number(acc.leafCount.toString()),
        sealed: Boolean(acc.sealed),
        expired: Number(acc.expireAt.toString()) * 1000 <= Date.now(),
      });
    } catch {
      statusOf.set(it.pda, { state: "closed" });
    }
  });

  return items.map((it) => ({ ...it, status: statusOf.get(it.pda) ?? { state: "closed" } }));
}
