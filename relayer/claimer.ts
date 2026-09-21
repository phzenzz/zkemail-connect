// relayer 兑现:回复邮件 → 证明 → (DKIM 注册表兜底)→ ALT → claim 交易。
// 顺序与 e2e/e2e.ts §3-5 一致。relayer 即注册表 authority(e2e 同角色),缺失/过期自动 upsert。
import fs from "fs";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey,
         AddressLookupTableAccount, AddressLookupTableProgram,
         Transaction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { loadClaimEmail } from "../circuits/scripts/load-email";
import { convertProofForSolana } from "../circuits/scripts/convert-proof";
import { relayerToField, computeDomainCommitment } from "../circuits/scripts/poseidon";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fieldToBE(v: bigint): Buffer {
  const b = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

export interface ClaimerDeps {
  connection: Connection;
  program: any; // anchor Program(email-wallet IDL)
  programId: PublicKey;
  relayerKeypair: Keypair; // 代付方;证明绑定该公钥;同时是 DKIM registry authority
  proverUrl: string;       // http://localhost:8080
}

export function buildAltAddressList(x: {
  programId: PublicKey; systemProgram: PublicKey; tokenProgram: PublicKey; ataProgram: PublicKey;
  mint: PublicKey; escrow: PublicKey; vault: PublicKey; sender: PublicKey; registry: PublicKey;
  destOwner: PublicKey; destAta: PublicKey; nullifier: PublicKey; protocolConfig: PublicKey;
}): PublicKey[] {
  return [
    x.programId, x.systemProgram, x.tokenProgram, x.ataProgram,
    x.mint, x.escrow, x.vault, x.sender, x.registry, x.destOwner, x.destAta, x.nullifier, x.protocolConfig,
  ];
}

/** 注册表兜底:不存在 / 过期 / 公钥哈希不匹配时 upsert(authority = relayer)。 */
export async function ensureRegistry(
  deps: ClaimerDeps, domainCommitment: bigint, selector: string, pubkeyHash: bigint
): Promise<PublicKey> {
  const dc = fieldToBE(domainCommitment);
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], deps.programId);
  const [registry] = PublicKey.findProgramAddressSync(
    [Buffer.from("dkim"), dc, Buffer.from(selector)], deps.programId);
  const now = Math.floor(Date.now() / 1000);
  const existing = await deps.connection.getAccountInfo(registry);
  let needsUpsert = !existing;
  if (existing) {
    const acc = await deps.program.account.dkimRegistry.fetch(registry);
    needsUpsert =
      acc.pubkeyHash !== undefined
        ? Buffer.from(acc.pubkeyHash).compare(fieldToBE(pubkeyHash)) !== 0
            // anchor 把 i64 解码成 BN:Number(bn) 走 valueOf 得十六进制串 → NaN,
            // 故先 toString() 取十进制(普通 number 时 toString 同样成立)
            || Number(acc.expiresAt.toString()) < now
        : true;
  }
  if (needsUpsert) {
    await deps.program.methods
      .registryUpsert(Array.from(dc), selector, Array.from(fieldToBE(pubkeyHash)), new anchor.BN(now + 30 * 24 * 3600))
      .accounts({ config, registry, authority: deps.relayerKeypair.publicKey })
      .rpc();
    console.log(`[claimer] registry upserted: selector=${selector}`);
  }
  return registry;
}

export async function claimEscrow(
  deps: ClaimerDeps, mail: { emlPath: string; escrow: PublicKey }
): Promise<string> {
  const relayerField = relayerToField(deps.relayerKeypair.publicKey.toBytes());
  const email = await loadClaimEmail(mail.emlPath, relayerField);
  const meta = email.meta;

  // 一致性校验:邮件与目标托管/relayer 绑定
  const escrowAcc = await deps.program.account.escrow.fetchNullable(mail.escrow);
  if (!escrowAcc) throw new Error("escrow already closed (claimed)");
  if (fieldToBE(BigInt(meta.commitment)).compare(Buffer.from(escrowAcc.commitment)) !== 0) {
    throw new Error("email commitment does not match escrow");
  }
  const relayerEmail = process.env.RELAYER_EMAIL ?? "";
  if (meta.toEmail.toLowerCase() !== relayerEmail.toLowerCase()) {
    throw new Error(`email To(${meta.toEmail}) != relayer email(${relayerEmail})`);
  }

  const selector: string = meta.selector;
  const registry = await ensureRegistry(deps, BigInt(meta.domainCommitment), selector, BigInt(meta.pubkeyHash));

  // 出证明(prover 容器)
  const resp = await fetch(`${deps.proverUrl}/prove`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(email.inputs),
  });
  if (!resp.ok) throw new Error(`prover failed: ${resp.status} ${await resp.text()}`);
  const { proof, publicSignals } = await resp.json();
  const fixture = convertProofForSolana(proof, publicSignals);

  // 组装 claim(e2e 同款:ALT + v0 + 400k CU)
  const destOwner = new PublicKey(meta.destBase58);
  const mint = new PublicKey(escrowAcc.mint);
  // vault 的 owner 是 escrow PDA(曲线外),必须 allowOwnerOffCurve=true
  // (e2e 的 anchor.utils.token.associatedAddress 是不校验曲线的原始 PDA 推导)
  const vault = getAssociatedTokenAddressSync(mint, mail.escrow, true);
  const destAta = getAssociatedTokenAddressSync(mint, destOwner, true);
  const nullifier = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), fieldToBE(BigInt(meta.emailNullifier))], deps.programId)[0];
  const [protocolConfig] = PublicKey.findProgramAddressSync([Buffer.from("protocol")], deps.programId);

  const recentSlot = await deps.connection.getSlot("finalized");
  const [createAltIx, altAddress] = AddressLookupTableProgram.createLookupTable({
    authority: deps.relayerKeypair.publicKey, payer: deps.relayerKeypair.publicKey, recentSlot,
  });
  const wallet = new anchor.Wallet(deps.relayerKeypair);
  const provider = new anchor.AnchorProvider(deps.connection, wallet, { commitment: "confirmed" });
  await provider.sendAndConfirm(new Transaction().add(createAltIx), []);
  await provider.sendAndConfirm(new Transaction().add(
    AddressLookupTableProgram.extendLookupTable({
      payer: deps.relayerKeypair.publicKey, authority: deps.relayerKeypair.publicKey,
      lookupTable: altAddress,
      addresses: buildAltAddressList({
        programId: deps.programId, systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID, ataProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        mint, escrow: mail.escrow, vault, sender: new PublicKey(escrowAcc.sender),
        registry, destOwner, destAta, nullifier, protocolConfig,
      }),
    })
  ), []);
  const extendedSlot = await deps.connection.getSlot();
  for (let i = 0; i < 20 && (await deps.connection.getSlot()) <= extendedSlot; i++) await sleep(400);
  let altAccount: AddressLookupTableAccount | null = null;
  for (let i = 0; i < 10; i++) {
    const res = await deps.connection.getAddressLookupTable(altAddress);
    if (res.value && res.value.state.addresses.length === 13) { altAccount = res.value; break; }
    await sleep(400);
  }
  if (!altAccount) throw new Error("address lookup table not ready");

  const claimTx = await deps.program.methods
    .claim({
      proofA: fixture.proofA, proofB: fixture.proofB, proofC: fixture.proofC,
      publicInputs: fixture.publicInputs, selector,
    })
    .accounts({
      escrow: mail.escrow, sender: new PublicKey(escrowAcc.sender), vault, mint,
      registry, destOwner, destAta, payer: deps.relayerKeypair.publicKey, nullifier, protocolConfig,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
    .transaction();

  let sig = "";
  for (let attempt = 0; attempt < 3 && !sig; attempt++) {
    const { blockhash, lastValidBlockHeight } = await deps.connection.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: deps.relayerKeypair.publicKey, recentBlockhash: blockhash,
      instructions: claimTx.instructions,
    }).compileToV0Message([altAccount]);
    const vtx = new VersionedTransaction(msg);
    vtx.sign([deps.relayerKeypair]);
    try {
      sig = await deps.connection.sendRawTransaction(vtx.serialize());
      await deps.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    } catch { sig = ""; }
  }
  if (!sig) throw new Error("claim tx failed to land after 3 attempts");
  console.log(`[claimer] claimed ${mail.escrow.toBase58()} → ${meta.destBase58} tx=${sig}`);
  return sig;
}
