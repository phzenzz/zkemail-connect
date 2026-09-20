// 06: 验证终态——dest ATA 收到足额代币，escrow 和 vault 账户已关闭。
import fs from "fs";
import { PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { AMOUNT, ata, conn, mustState, PROOF_FILE } from "./common";

async function main() {
  const state = mustState();
  const fixture = JSON.parse(fs.readFileSync(PROOF_FILE, "utf8"));
  const mint = new PublicKey(state.mint);
  const escrow = new PublicKey(state.escrow);
  const destOwner = new PublicKey(fixture.meta.destBase58);

  const destAta = await getAccount(conn, ata(mint, destOwner));
  if (destAta.amount.toString() !== AMOUNT.toString()) {
    throw new Error(`dest balance mismatch: ${destAta.amount} != ${AMOUNT}`);
  }
  console.log(`[06] PASS: dest ${destOwner.toBase58()} 收到 ${destAta.amount}`);

  if (await conn.getAccountInfo(escrow)) throw new Error("escrow not closed");
  if (await conn.getAccountInfo(ata(mint, escrow))) throw new Error("vault not closed");
  console.log("[06] PASS: escrow + vault 已关闭");
}
main().catch((e) => { console.error("[06] FAIL:", e?.message ?? e); process.exit(1); });
