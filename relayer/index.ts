// relayer 编排:indexer(通知)+ inbound(收信)→ claimer(兑现)。无 DB,状态全在链上。
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";
import { runIndexer } from "./indexer";
import { runInboundFromEnv, InboundDeps, ClaimableMail } from "./inbound";
import { claimEscrow, ClaimerDeps } from "./claimer";
import { ConsoleNotifier, Notifier } from "./notify";

const ROOT = path.resolve(__dirname, "..");
const IDL_PATH = path.join(ROOT, "onchain/target/idl/email_wallet.json");

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const relayerKeyPath = process.env.RELAYER_KEYPAIR_PATH ?? path.join(os.homedir(), ".config/solana/id.json");
  const proverUrl = process.env.PROVER_URL ?? "http://localhost:8080";
  const relayerKeypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(relayerKeyPath, "utf8"))));
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
  const connection = new Connection(rpc, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(relayerKeypair), { commitment: "confirmed" });
  const program: any = new anchor.Program(idl as any, provider);
  const programId: PublicKey = program.programId as PublicKey;

  // inbound 的引导回复需要真实 notifier(GMAIL_APP_PASSWORD 决定 Gmail SMTP,否则控制台回退)
  let notifier: Notifier = new ConsoleNotifier();
  if (process.env.GMAIL_APP_PASSWORD) {
    const { GmailNotifier } = await import("./notify");
    notifier = new GmailNotifier({ user: process.env.RELAYER_EMAIL!, pass: process.env.GMAIL_APP_PASSWORD });
  }

  // claim 队列:inbound 收到合法回复即入队,逐个兑现(串行,prover 本身串行)
  const queue: ClaimableMail[] = [];
  let working = false;
  const claimerDeps: ClaimerDeps = { connection, program, programId, relayerKeypair, proverUrl };

  async function pump() {
    if (working) return;
    working = true;
    while (queue.length > 0) {
      const mail = queue.shift()!;
      try {
        await claimEscrow(claimerDeps, mail);
      } catch (e) {
        console.error(`[relayer] claim failed for ${mail.escrow.toBase58()}:`, (e as Error)?.message ?? e);
      }
    }
    working = false;
  }

  const deps: InboundDeps = {
    connection, programId, notifier,
    onClaimable: async (m) => { queue.push(m); void pump(); },
  };

  // indexer 需要长期驻留:在其内部循环外以 fire-and-forget 启动
  void runIndexer().catch((e) => { console.error("[indexer] fatal:", e); process.exit(1); });
  void runInboundFromEnv(deps).catch((e) => { console.error("[inbound] fatal:", e); process.exit(1); });
  console.log(`[relayer] up: rpc=${rpc} relayer=${relayerKeypair.publicKey.toBase58()}`);
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
main().catch((e) => { console.error("[relayer] FAIL:", e?.message ?? e); process.exit(1); });
