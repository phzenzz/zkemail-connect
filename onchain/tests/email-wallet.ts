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
    const escrowId = randomBytes(16);
    const escrow = escrowPda(commitment, sender.publicKey, escrowId);
    await program.methods
      .createEscrow(
        Array.from(commitment),
        Array.from(escrowId),
        new anchor.BN(500_000)
      )
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
    const escrowId = randomBytes(16);
    const escrow = escrowPda(commitment, sender.publicKey, escrowId);
    await expect(
      program.methods
        .createEscrow(
          Array.from(commitment),
          Array.from(escrowId),
          new anchor.BN(0)
        )
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

  it("same (commitment, sender, escrow_id) cannot be created twice", async () => {
    const escrowId = randomBytes(16);
    const escrow = escrowPda(commitment, sender.publicKey, escrowId);
    const mk = () =>
      program.methods
        .createEscrow(
          Array.from(commitment),
          Array.from(escrowId),
          new anchor.BN(1000)
        )
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

  it("different escrow_id for same email+sender creates independent escrows", async () => {
    const id2 = randomBytes(16);
    const escrow2 = escrowPda(commitment, sender.publicKey, id2);
    await program.methods
      .createEscrow(Array.from(commitment), Array.from(id2), new anchor.BN(7))
      .accounts({
        escrow: escrow2,
        mint,
        vault: ata(mint, escrow2),
        senderAta,
        sender: sender.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sender])
      .rpc();
    const acc = await program.account.escrow.fetch(escrow2);
    assert.equal(acc.amount.toNumber(), 7);
  });
});
