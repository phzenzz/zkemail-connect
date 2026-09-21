// 02: sender 侧建 SPL mint + 存币建托管（createEscrow v1.6：commitment + amount
//     + 加密邮箱 + relayer 标识 + 协议手续费）。依赖 04 步已注册 relayer（链上 entry + state.json 私钥）。
import nacl from "tweetnacl";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createMint, createAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  AMOUNT, ata, conn, fieldToBE, loadKeypair, loadProgram, loadState,
  programId, RELAYER_EMAIL, saveState,
} from "./common";
import { relayerEmailHash, sealEmailForRelayer } from "../../relayer/crypto";

const MINT_SUPPLY = 1_000_000_000;
// 占位收件邮箱（= 邮件 From，indexer 解密后会校验其 Poseidon commitment）；
// 手动测试时替换为真实收件邮箱。
const RECIPIENT_EMAIL = "recipient@example.com";

async function main() {
  // 本步创建 mint/escrow，只需要 01 写入的 meta（mustState 是给后续步骤用的）。
  const state = loadState();
  if (!state.meta?.commitment) throw new Error("state 缺 meta——请先跑 00/01 步（见 docs/手动测试指南.md）");
  if (!state.relayerX25519Secret) {
    throw new Error("state 缺 relayerX25519Secret——请先跑 04 步注册 relayer（见 docs/手动测试指南.md）");
  }
  const commitment = fieldToBE(state.meta.commitment as string);
  const sender = loadKeypair("sender");
  const relayer = loadKeypair("relayer");
  const program = loadProgram(relayer);

  const mint = await createMint(conn, sender, sender.publicKey, null, 6);
  const senderAta = await createAccount(conn, sender, mint, sender.publicKey);
  await mintTo(conn, sender, mint, senderAta, sender, MINT_SUPPLY);

  const relayerHash = await relayerEmailHash(RELAYER_EMAIL);
  const relayerEntry = PublicKey.findProgramAddressSync(
    [Buffer.from("relayer"), relayerHash], programId())[0];
  let entry: any;
  try {
    entry = await program.account.relayerEntry.fetch(relayerEntry);
  } catch {
    throw new Error("链上无 relayerEntry——请先跑 04 步注册 relayer（见 docs/手动测试指南.md）");
  }
  const x25519 = nacl.box.keyPair.fromSecretKey(Buffer.from(state.relayerX25519Secret, "hex"));
  if (Buffer.from(x25519.publicKey).compare(Buffer.from(entry.x25519Key)) !== 0) {
    throw new Error("state.json 的 relayerX25519Secret 与链上 relayerEntry 不匹配——请重跑 04 步并同步 state");
  }
  const protocolConfig = PublicKey.findProgramAddressSync([Buffer.from("protocol")], programId())[0];
  const cfg = await program.account.protocolConfig.fetch(protocolConfig); // treasury 以链上 config 为准
  const cipher = sealEmailForRelayer(RECIPIENT_EMAIL, x25519.publicKey);
  console.log(`[02] email cipher length=${cipher.length} (relayer=${RELAYER_EMAIL})`);

  const escrow = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), commitment, sender.publicKey.toBuffer()], programId())[0];
  await program.methods.createEscrow(Array.from(commitment), new anchor.BN(AMOUNT), cipher, Array.from(relayerHash))
    .accounts({
      escrow, mint, vault: ata(mint, escrow), senderAta, sender: sender.publicKey,
      config: protocolConfig, treasury: cfg.treasury, relayerEntry,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([sender]).rpc();

  saveState({ mint: mint.toBase58(), escrow: escrow.toBase58() });
  console.log(`[02] mint=${mint.toBase58()}`);
  console.log(`[02] escrow=${escrow.toBase58()} amount=${AMOUNT}`);
}
main().catch((e) => { console.error("[02] FAIL:", e?.message ?? e); process.exit(1); });
