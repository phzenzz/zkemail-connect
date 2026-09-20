// 02: sender 侧建 SPL mint + 存币建托管（createEscrow，commitment 对应邮件 From 邮箱）。
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createMint, createAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  AMOUNT, ata, conn, fieldToBE, loadKeypair, loadProgram, loadState, programId, saveState,
} from "./common";

const MINT_SUPPLY = 1_000_000_000;

async function main() {
  // 本步创建 mint/escrow，只需要 01 写入的 meta（mustState 是给后续步骤用的）。
  const state = loadState();
  if (!state.meta?.commitment) throw new Error("state 缺 meta——请先跑 00/01 步（见 docs/手动测试指南.md）");
  const commitment = fieldToBE(state.meta.commitment as string);
  const sender = loadKeypair("sender");
  const relayer = loadKeypair("relayer");
  const program = loadProgram(relayer);

  const mint = await createMint(conn, sender, sender.publicKey, null, 6);
  const senderAta = await createAccount(conn, sender, mint, sender.publicKey);
  await mintTo(conn, sender, mint, senderAta, sender, MINT_SUPPLY);

  const escrow = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), commitment, sender.publicKey.toBuffer()], programId())[0];
  await program.methods.createEscrow(Array.from(commitment), new anchor.BN(AMOUNT))
    .accounts({ escrow, mint, vault: ata(mint, escrow), senderAta, sender: sender.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
    .signers([sender]).rpc();

  saveState({ mint: mint.toBase58(), escrow: escrow.toBase58() });
  console.log(`[02] mint=${mint.toBase58()}`);
  console.log(`[02] escrow=${escrow.toBase58()} amount=${AMOUNT}`);
}
main().catch((e) => { console.error("[02] FAIL:", e?.message ?? e); process.exit(1); });
