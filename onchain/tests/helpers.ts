import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { EmailWallet } from "../target/types/email_wallet";
import { Keypair, PublicKey } from "@solana/web3.js";
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
