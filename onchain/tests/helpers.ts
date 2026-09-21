import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { EmailWallet } from "../target/types/email_wallet";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { use } from "chai";
import chaiAsPromised from "chai-as-promised";

use(chaiAsPromised);

export const program = anchor.workspace.EmailWallet as Program<EmailWallet>;
export const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

export function escrowPda(commitment: Buffer, sender: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), commitment, sender.toBuffer()],
    program.programId
  )[0];
}
export function inboxPda(commitment: Buffer) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("inbox"), commitment],
    program.programId
  )[0];
}
export function registryPda(domainCommitment: Buffer, selector: string) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("dkim"), domainCommitment, Buffer.from(selector)],
    program.programId
  )[0];
}
export function configPda() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  )[0];
}
export const ata = (mint: PublicKey, owner: PublicKey) =>
  anchor.utils.token.associatedAddress({ mint, owner });

export async function fundSender(sender: Keypair, amount = 2e9) {
  const sig = await provider.connection.requestAirdrop(
    sender.publicKey,
    amount
  );
  await provider.connection.confirmTransaction(sig);
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const fieldToBE = (s: string) => {
  // decimal field -> 32-byte BE buffer
  let v = BigInt(s);
  const b = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
};

export function relayerEntryPda(emailHash: Buffer) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("relayer"), emailHash],
    program.programId
  )[0];
}
export function protocolConfigPda() {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId
  )[0];
}
export function nullifierPda(emailNullifier: Buffer) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), emailNullifier],
    program.programId
  )[0];
}

/**
 * 创建地址查找表（v0 交易用）。claim/sweep 交易携带 Groth16 证明
 * （3 段 proof + 9 个 public input ≈ 550B），legacy 交易 1232B 上限放不下，
 * 静态账户列表必须经 ALT 压缩（每个账户引用 32B → 1B 索引）。
 */
export async function createAltAccount(
  addresses: PublicKey[]
): Promise<AddressLookupTableAccount> {
  const authority = provider.wallet.publicKey;
  const recentSlot = await provider.connection.getSlot("finalized");
  const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
    authority,
    payer: authority,
    recentSlot,
  });
  await provider.sendAndConfirm(new Transaction().add(createIx), []);
  await provider.sendAndConfirm(
    new Transaction().add(
      AddressLookupTableProgram.extendLookupTable({
        payer: authority,
        authority,
        lookupTable: altAddress,
        addresses,
      })
    ),
    []
  );
  // 运行时不允许在同一 slot 引用刚扩展过的表（last_extended_slot 必须 < tx slot）
  const extendedSlot = await provider.connection.getSlot();
  for (let i = 0; i < 20 && (await provider.connection.getSlot()) <= extendedSlot; i++) {
    await sleep(400);
  }
  for (let i = 0; i < 10; i++) {
    const res = await provider.connection.getAddressLookupTable(altAddress);
    if (res.value && res.value.state.addresses.length === addresses.length) {
      return res.value;
    }
    await sleep(400);
  }
  throw new Error(`address lookup table ${altAddress.toBase58()} not ready`);
}

/** 组装并发送 v0 交易（配合 createAltAccount 产出的查找表）。返回签名。
 *  不传 maxRetries：验证器刚启动时 send_transaction_service 前几次转发可能失败，
 *  由节点持续重试至 blockhash 过期（anchor 默认路径同款行为）；本函数再兜底重发 3 次。 */
export async function sendV0Tx(
  instructions: TransactionInstruction[],
  signers: Keypair[],
  lookupTables: AddressLookupTableAccount[],
  feePayer: PublicKey
): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { blockhash, lastValidBlockHeight } =
      await provider.connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: feePayer,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(lookupTables);
    const vtx = new VersionedTransaction(message);
    vtx.sign(signers);
    try {
      const sig = await provider.connection.sendRawTransaction(vtx.serialize());
      await provider.connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed"
      );
      return sig;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
