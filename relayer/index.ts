// relayer 编排（组合根）：indexer(通知) + inbound(收信) → claimer(兑现)。
// 启动第一步 loadConfig fail-fast；无 DB，状态全在链上（批次派生缓存在 relayer/data/）。
// 配置经 npm script 链式 --env-file 加载（.env ← .env.devnet/.env.local，后者优先）：
//   npm run relayer            # .env
//   npm run relayer:local      # .env + .env.local   （本地 validator）
//   npm run relayer:devnet     # .env + .env.devnet   （devnet）
// 所有键见 .env.example；脱敏核对：npm run relayer:print-config
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { loadConfig, describeConfig } from "./config";
import { runIndexer } from "./indexer";
import { runInboundFromEnv, InboundDeps, ClaimableMail } from "./inbound";
import { claimBatch, claimEscrow, ClaimerDeps } from "./claimer";
import { ConsoleNotifier, GmailNotifier, Notifier } from "./notify";

const ROOT = path.resolve(__dirname, "..");
const IDL_PATH = path.join(ROOT, "onchain/target/idl/email_wallet.json");

/** 长驻任务监督：崩溃打日志、30s 退避重启，永不让单点故障拖垮整机。 */
async function supervise(name: string, run: () => Promise<void>): Promise<never> {
  for (;;) {
    try {
      await run();
      console.warn(`[${name}] exited normally, restarting in 30s`);
    } catch (e) {
      console.error(`[${name}] crashed, retry in 30s:`, (e as Error)?.message ?? e);
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

async function main() {
  const cfg = loadConfig();
  console.log("[relayer] config:\n" + describeConfig(cfg));

  const relayerKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(cfg.keypairPath, "utf8"))));
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(relayerKeypair), { commitment: "confirmed" });
  const program: any = new anchor.Program(idl as any, provider);
  const programId: PublicKey = program.programId as PublicKey;

  // notifier：有 Gmail 凭证发真实邮件，否则降级控制台（此时 inbound 一并跳过）
  let notifier: Notifier = new ConsoleNotifier();
  if (cfg.gmail) {
    notifier = new GmailNotifier({ user: cfg.email, auth: cfg.gmail });
    console.log(`[relayer] notifier = GmailNotifier (${cfg.gmail.kind})`);
  } else {
    console.log("[relayer] 未配置 Gmail 凭证：通知降级 ConsoleNotifier，inbound 不启动");
  }

  // claim 队列：inbound 收到合法回复即入队，逐个兑现（串行，prover 本身串行）
  const queue: ClaimableMail[] = [];
  let working = false;
  const claimerDeps: ClaimerDeps = {
    connection, program, programId,
    relayerKeypair, proverUrl: cfg.proverUrl,
  };

  async function pump() {
    if (working) return;
    working = true;
    while (queue.length > 0) {
      const mail = queue.shift()!;
      try {
        if (mail.batch) await claimBatch(claimerDeps, { emlPath: mail.emlPath, batch: mail.batch, leafIndex: mail.leafIndex! });
        else await claimEscrow(claimerDeps, mail);
      } catch (e) {
        console.error(`[relayer] claim failed for ${(mail.batch ?? mail.escrow).toBase58()}:`, (e as Error)?.message ?? e);
      }
    }
    working = false;
  }

  const deps: InboundDeps = {
    connection, programId, notifier,
    onClaimable: async (m) => { queue.push(m); void pump(); },
  };

  // indexer 长期驻留。监督重启：与 inbound 同理——ws/RPC/SMTP 的瞬时故障
  // （如 TLS 握手被代理切断）不应拖垮整机；崩溃后 30s 退避重连（重启即重新订阅+回填，幂等）。
  void supervise("indexer", () =>
    runIndexer({
      connection, email: cfg.email, x25519Secret: cfg.x25519Secret,
      claimBase: cfg.claimBaseUrl, notifier,
    }));

  // inbound 需真实 Gmail 凭证；未配置时跳过（通知已降级，无回复可收）。
  if (cfg.gmail) {
    void supervise("inbound", () => runInboundFromEnv(deps));
  }

  console.log(`[relayer] up: rpc=${cfg.rpcUrl} relayer=${relayerKeypair.publicKey.toBase58()}`);
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
main().catch((e) => { console.error("[relayer] FAIL:", e?.message ?? e); process.exit(1); });
