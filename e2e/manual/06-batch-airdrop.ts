// 06: 批量空投——createBatch(2 叶) → append → seal → claim_batch（leaf 0）。
// 依赖 00/01/04 步（meta + relayer 注册）。proof 用 prove-for 现算（绑 relayer 公钥）。
// 注意：密文里的邮箱仅作 relayer 通知用；叶子承诺直接取自 meta.commitment（真实 From），
// 因此即使密文邮箱是占位符也不影响本步的链上 claim_batch 验证。
// 运行：npx tsx e2e/manual/06-batch-airdrop.ts
import * as anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount, AddressLookupTableProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { execFileSync } from "child_process";
import fs from "fs";
import nacl from "tweetnacl";
import { buildBatchTree, merklePath } from "../../circuits/scripts/merkle";
import { ata, conn, fieldToBE, loadKeypair, loadProgram, loadState, programId, relayerEmailFromState, saveState, PROOF_FILE, ROOT } from "./common";
import { relayerEmailHash, sealBytes } from "../../relayer/crypto";

const AMOUNT_PER = 25_000_000; // 每人 25 代币
// 只能指向与 01 步解析的 e2e.eml 相同的邮件：leaf 0 承诺绑 state.meta.commitment，
// 换邮件不会在前置步骤报错，但会静默打破该绑定，链上 claim 时以 BatchInvalidProof 失败。
const EML = process.env.CLAIM_EML ?? `${ROOT}/circuits/testdata/emails/claim.eml`;

// anchor 0.32 的 emit! 在 logMessages 里落成 `Program data: base64(discriminator || 事件数据)`，
// 事件名不在明文——按判别字节匹配，另留明文兜底。
const BATCH_CLAIMED_DISC = Buffer.from([60, 42, 120, 40, 81, 126, 128, 160]);
function hasBatchClaimedEvent(logMessages: string[] | null | undefined): boolean {
  return (logMessages ?? []).some((m) => {
    if (m.includes("BatchClaimed")) return true;
    const mm = m.match(/Program (?:data|log): (\S+)/);
    if (!mm) return false;
    try {
      const payload = Buffer.from(mm[1], "base64");
      return payload.length >= 8 && payload.subarray(0, 8).equals(BATCH_CLAIMED_DISC);
    } catch { return false; }
  });
}

async function main() {
  const state = loadState();
  if (!state.meta?.commitment) throw new Error("先跑 00/01 步");
  if (!state.relayerX25519Secret) throw new Error("先跑 04 步");
  if (!state.mint) throw new Error("state 缺 mint——先跑 02 步（本步复用其 mint/senderAta 资金）");
  const sender = loadKeypair("sender");
  const relayer = loadKeypair("relayer");
  const program = loadProgram(relayer);
  const mint = new PublicKey(state.mint);
  const relayerHash = await relayerEmailHash(relayerEmailFromState(state));
  const relayerEntry = PublicKey.findProgramAddressSync([Buffer.from("relayer"), relayerHash], programId())[0];
  const protocolConfig = PublicKey.findProgramAddressSync([Buffer.from("protocol")], programId())[0];
  const cfg = await program.account.protocolConfig.fetch(protocolConfig);
  const senderAta = getAssociatedTokenAddressSync(mint, sender.publicKey);

  // leaf 0 = 真实 From 的 commitment（proof 绑定它，取自 meta）；leaf 1 = 第二邮箱的 commitment。
  // 密文邮箱与树叶一一对应：indexer 解密后会重算 root 与链上比对（防篡改），两边必须一致。
  const emails = [state.meta.fromEmail as string, "batch-holder@example.com"];
  const commitment0 = fieldToBE(state.meta.commitment as string);
  const { computeCommitment } = await import("../../circuits/scripts/poseidon");
  const commitment1 = fieldToBE((await computeCommitment(emails[1])).toString());
  const tree = buildBatchTree([commitment0, commitment1]);
  // 持久化叶子承诺：claim 段网络失败时可单独断点重跑（path 依赖同一棵树）
  saveState({ batchLeaves: [commitment0.toString("hex"), commitment1.toString("hex")] });
  const batch = PublicKey.findProgramAddressSync(
    [Buffer.from("batch"), sender.publicKey.toBuffer(), tree.root], programId())[0];

  // 密文 = 真实邮箱列表（relayer 解密后据此通知 + 重建树）
  const x25519 = nacl.box.keyPair.fromSecretKey(Buffer.from(state.relayerX25519Secret, "hex"));
  const cipher = sealBytes(Buffer.from(JSON.stringify(emails)), x25519.publicKey);
  console.log(`[06] cipher=${cipher.length}B root=${tree.root.toString("hex").slice(0, 16)}… emails=${emails.join(",")}`);

  await program.methods.createBatch(Array.from(tree.root), new anchor.BN(AMOUNT_PER), 2, cipher.length,
    new anchor.BN(Math.floor(Date.now() / 1000) + 7 * 86_400), Array.from(relayerHash))
    .accounts({
      batch, mint, vault: ata(mint, batch), senderAta, sender: sender.publicKey,
      config: protocolConfig, treasury: cfg.treasury, relayerEntry,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([sender]).rpc();
  const CHUNK = 800;
  for (let i = 0; i < cipher.length; i += CHUNK) {
    await program.methods.appendBatchCipher(cipher.subarray(i, i + CHUNK))
      .accounts({ batch, sender: sender.publicKey }).signers([sender]).rpc();
  }
  await program.methods.sealBatch().accounts({ batch, sender: sender.publicKey }).signers([sender]).rpc();
  saveState({ batch: batch.toBase58() });
  console.log(`[06] batch=${batch.toBase58()} sealed, 2 leaves × ${AMOUNT_PER}`);

  // —— claim_batch（leaf 0）——
  // prove-for 的中间产物（build/pf-input.json 等）相对 cwd 写，须在 circuits/ 下运行（同指南 03 步）。
  // EML / PROOF_FILE 均为绝对路径，不受 cwd 影响；eml 与 out 参数仍传绝对路径。
  execFileSync("npx", ["tsx", `${ROOT}/circuits/scripts/prove-for.ts`, EML, relayer.publicKey.toBase58(), PROOF_FILE], {
    cwd: `${ROOT}/circuits`, stdio: "inherit", env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=16384" },
  });
  const proof = JSON.parse(fs.readFileSync(PROOF_FILE, "utf8"));
  const meta: any = state.meta;
  const registry = PublicKey.findProgramAddressSync(
    [Buffer.from("dkim"), fieldToBE(meta.domainCommitment as string), Buffer.from(meta.selector as string)], programId())[0];
  const destOwner = new PublicKey(meta.destBase58 as string);
  const destAta = getAssociatedTokenAddressSync(mint, destOwner, true);
  const nullifier = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), fieldToBE(meta.emailNullifier as string)], programId())[0];
  const path = merklePath(tree, 0);

  const recentSlot = await conn.getSlot("finalized");
  const [createAltIx, altAddress] = AddressLookupTableProgram.createLookupTable({
    authority: relayer.publicKey, payer: relayer.publicKey, recentSlot,
  });
  const wallet = new anchor.Wallet(relayer);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  await provider.sendAndConfirm(new Transaction().add(createAltIx), []);
  await provider.sendAndConfirm(new Transaction().add(
    AddressLookupTableProgram.extendLookupTable({
      payer: relayer.publicKey, authority: relayer.publicKey, lookupTable: altAddress,
      addresses: [programId(), SystemProgram.programId, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
        mint, batch, ata(mint, batch), registry, destOwner, destAta, nullifier, protocolConfig],
    })
  ), []);
  const extSlot = await conn.getSlot();
  for (let i = 0; i < 20 && (await conn.getSlot()) <= extSlot; i++) await new Promise((r) => setTimeout(r, 400));
  let altAccount: AddressLookupTableAccount | null = null;
  for (let i = 0; i < 10; i++) {
    const res = await conn.getAddressLookupTable(altAddress);
    if (res.value && res.value.state.addresses.length === 12) { altAccount = res.value; break; }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!altAccount) throw new Error("ALT not ready");

  // IDL 中 merkle_indices 为 bytes 类型，anchor 编码要求 Buffer（number[] 会报 Blob.encode 错误）。
  const claimTx = await program.methods.claimBatch(
    { proofA: proof.proofA, proofB: proof.proofB, proofC: proof.proofC,
      publicInputs: proof.publicInputs, selector: meta.selector },
    path.siblings.map((s: Buffer) => Array.from(s)), Buffer.from(path.indices),
  ).accounts({
    batch, vault: ata(mint, batch), mint, registry, destOwner, destAta,
    payer: relayer.publicKey, nullifier, protocolConfig, tokenProgram: TOKEN_PROGRAM_ID,
  }).preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]).transaction();

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: relayer.publicKey, recentBlockhash: blockhash, instructions: claimTx.instructions,
  }).compileToV0Message([altAccount]);
  const vtx = new VersionedTransaction(msg);
  vtx.sign([relayer]);
  const sig = await conn.sendRawTransaction(vtx.serialize());
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  const dest = await getAccount(conn, destAta);
  console.log(`[06] claimed leaf 0 → ${meta.destBase58} balance=${dest.amount} tx=${sig}`);

  // CU 与事件回填（spec §4.3）：成功路径只有本脚本能覆盖。
  const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  console.log(`[06] claim CU=${tx?.meta?.computeUnitsConsumed ?? "unknown"} BatchClaimed event: ${hasBatchClaimedEvent(tx?.meta?.logMessages)}`);
}
main().catch((e) => { console.error("[06] FAIL:", e?.message ?? e); process.exit(1); });
