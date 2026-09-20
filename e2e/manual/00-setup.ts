// 00: 生成 sender / relayer 密钥对并各空投 5 SOL（幂等：已存在则复用）。
import fs from "fs";
import path from "path";
import { Keypair } from "@solana/web3.js";
import { conn, STATE_DIR } from "./common";

async function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  for (const name of ["sender", "relayer"] as const) {
    const p = path.join(STATE_DIR, `${name}.json`);
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, JSON.stringify(Array.from(Keypair.generate().secretKey)));
    }
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
    const sig = await conn.requestAirdrop(kp.publicKey, 5e9);
    await conn.confirmTransaction(sig);
    console.log(`[00] ${name}: ${kp.publicKey.toBase58()} (airdropped 5 SOL)`);
  }
}
main().catch((e) => { console.error("[00] FAIL:", e?.message ?? e); process.exit(1); });
