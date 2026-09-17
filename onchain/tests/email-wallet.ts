import * as anchor from "@coral-xyz/anchor";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assert, expect } from "chai";
import { randomBytes } from "crypto";
import { program, provider, escrowPda, ata, fundSender } from "./helpers";

describe("create_escrow", () => {
  const sender = Keypair.generate();
  let mint: PublicKey;
  let senderAta: PublicKey;
  const commitment = randomBytes(32);

  before(async () => {
    await fundSender(sender);
    mint = await createMint(
      provider.connection,
      sender,
      sender.publicKey,
      null,
      6
    );
    senderAta = await createAccount(
      provider.connection,
      sender,
      mint,
      sender.publicKey
    );
    await mintTo(
      provider.connection,
      sender,
      mint,
      senderAta,
      sender,
      1_000_000_000
    );
  });

  it("creates escrow and funds vault", async () => {
    const escrow = escrowPda(commitment, sender.publicKey);
    await program.methods
      .createEscrow(Array.from(commitment), new anchor.BN(500_000))
      .accounts({
        escrow,
        mint,
        vault: ata(mint, escrow),
        senderAta,
        sender: sender.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sender])
      .rpc();
    const acc = await program.account.escrow.fetch(escrow);
    assert.equal(acc.amount.toNumber(), 500_000);
    assert.equal(acc.sender.toBase58(), sender.publicKey.toBase58());
    const vault = await getAccount(provider.connection, ata(mint, escrow));
    assert.equal(vault.amount.toString(), "500000");
  });

  it("rejects zero amount", async () => {
    const otherCommitment = randomBytes(32);
    const escrow = escrowPda(otherCommitment, sender.publicKey);
    await expect(
      program.methods
        .createEscrow(Array.from(otherCommitment), new anchor.BN(0))
        .accounts({
          escrow,
          mint,
          vault: ata(mint, escrow),
          senderAta,
          sender: sender.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sender])
        .rpc()
    ).to.be.rejectedWith(/InvalidAmount/);
  });

  it("same (commitment, sender) cannot be created twice", async () => {
    const otherCommitment = randomBytes(32);
    const escrow = escrowPda(otherCommitment, sender.publicKey);
    const mk = () =>
      program.methods
        .createEscrow(Array.from(otherCommitment), new anchor.BN(1000))
        .accounts({
          escrow,
          mint,
          vault: ata(mint, escrow),
          senderAta,
          sender: sender.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sender])
        .rpc();
    await mk();
    await expect(mk()).to.be.rejected; // PDA already initialized
  });

  it("different sender creates independent escrow for same commitment", async () => {
    const sender2 = Keypair.generate();
    await fundSender(sender2);
    const sender2Ata = await createAccount(
      provider.connection,
      sender2,
      mint,
      sender2.publicKey
    );
    await mintTo(
      provider.connection,
      sender,
      mint,
      sender2Ata,
      sender,
      1_000_000
    );
    const escrow2 = escrowPda(commitment, sender2.publicKey);
    await program.methods
      .createEscrow(Array.from(commitment), new anchor.BN(7))
      .accounts({
        escrow: escrow2,
        mint,
        vault: ata(mint, escrow2),
        senderAta: sender2Ata,
        sender: sender2.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sender2])
      .rpc();
    const acc = await program.account.escrow.fetch(escrow2);
    assert.equal(acc.amount.toNumber(), 7);
    assert.equal(acc.sender.toBase58(), sender2.publicKey.toBase58());
  });
});
