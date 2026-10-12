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
import {
  program,
  provider,
  escrowPda,
  randomEscrowNonce,
  ata,
  fundSender,
  fieldToBE,
  relayerEntryPda,
  protocolConfigPda,
  sleep,
} from "./helpers";

// BN254 Fr; create_escrow rejects commitments >= Fr (no valid proof could match).
const FR = BigInt(
  "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001"
);
const randomFieldCommitment = () => {
  let c: bigint;
  do {
    c = BigInt(`0x${randomBytes(32).toString("hex")}`);
  } while (c >= FR);
  return fieldToBE(c.toString());
};

describe("create_escrow", () => {
  const sender = Keypair.generate();
  const treasury = Keypair.generate();
  const relayerHash = randomBytes(32);
  let mint: PublicKey;
  let senderAta: PublicKey;
  const commitment = randomFieldCommitment();

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
    // protocol config 先到先得；其他套件已初始化时以 authority 重置为本套件的 treasury/fee
    const authority = provider.wallet.publicKey;
    try {
      await program.methods.initializeProtocol(treasury.publicKey, new anchor.BN(10_000_000), new anchor.BN(2_592_000))
        .accounts({ config: protocolConfigPda(), payer: authority }).rpc();
    } catch {
      await program.methods.updateProtocol(treasury.publicKey, new anchor.BN(10_000_000), new anchor.BN(2_592_000))
        .accounts({ config: protocolConfigPda(), authority }).rpc();
    }
    // 注册本套件使用的 relayer（active）
    await program.methods.registerRelayer(
        "relay@zkemail.io", Array.from(relayerHash), Array.from(randomBytes(32)),
        sender.publicKey, new anchor.BN(0))
      .accounts({ relayerEntry: relayerEntryPda(relayerHash), claimAuthority: sender.publicKey })
      .signers([sender]).rpc();
  });

  it("creates escrow with cipher + relayer hash and pays protocol fee", async () => {
    const nonce = randomEscrowNonce();
    const escrow = escrowPda(commitment, sender.publicKey, nonce);
    const cipher = randomBytes(100);
    const before = await provider.connection.getBalance(treasury.publicKey);
    let seen: any = null;
    const sub = program.addEventListener("escrowCreated", (e: any) => { seen = e; });
    await program.methods
      .createEscrow(Array.from(commitment), new anchor.BN(500_000),
        cipher, Array.from(relayerHash), nonce)
      .accounts({
        escrow,
        mint,
        vault: ata(mint, escrow),
        senderAta,
        sender: sender.publicKey,
        config: protocolConfigPda(),
        treasury: treasury.publicKey,
        relayerEntry: relayerEntryPda(relayerHash),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sender])
      .rpc();
    await sleep(1500);
    await program.removeEventListener(sub);
    const acc = await program.account.escrow.fetch(escrow);
    assert.equal(acc.amount.toNumber(), 500_000);
    assert.deepEqual([...acc.relayerEmailHash], [...relayerHash]);
    assert.deepEqual([...acc.emailCipher], [...cipher]);
    assert.isTrue(acc.nonce.eq(nonce));
    const after = await provider.connection.getBalance(treasury.publicKey);
    assert.equal(after - before, 10_000_000); // 手续费精确到账
    assert.ok(seen);
    assert.equal(seen.escrow.toBase58(), escrow.toBase58());
    assert.deepEqual([...seen.relayerEmailHash], [...relayerHash]);
    const vault = await getAccount(provider.connection, ata(mint, escrow));
    assert.equal(vault.amount.toString(), "500000");
  });

  it("rejects zero amount", async () => {
    const otherCommitment = randomFieldCommitment();
    const nonce = randomEscrowNonce();
    const escrow = escrowPda(otherCommitment, sender.publicKey, nonce);
    await expect(
      program.methods
        .createEscrow(Array.from(otherCommitment), new anchor.BN(0),
          randomBytes(60), Array.from(relayerHash), nonce)
        .accounts({
          escrow,
          mint,
          vault: ata(mint, escrow),
          senderAta,
          sender: sender.publicKey,
          config: protocolConfigPda(),
          treasury: treasury.publicKey,
          relayerEntry: relayerEntryPda(relayerHash),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sender])
        .rpc()
    ).to.be.rejectedWith(/InvalidAmount/);
  });

  it("rejects commitment >= BN254 Fr (funds would be permanently locked)", async () => {
    // Fr = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001;
    // no valid proof can ever match it, so create_escrow must reject it.
    const fr = Buffer.from(
      "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
      "hex"
    );
    const nonce = randomEscrowNonce();
    const escrow = escrowPda(fr, sender.publicKey, nonce);
    await expect(
      program.methods
        .createEscrow(Array.from(fr), new anchor.BN(1000),
          randomBytes(60), Array.from(relayerHash), nonce)
        .accounts({
          escrow,
          mint,
          vault: ata(mint, escrow),
          senderAta,
          sender: sender.publicKey,
          config: protocolConfigPda(),
          treasury: treasury.publicKey,
          relayerEntry: relayerEntryPda(relayerHash),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sender])
        .rpc()
    ).to.be.rejectedWith(/InvalidCommitment/);
  });

  it("same (commitment, sender, nonce) cannot be created twice; a fresh nonce succeeds", async () => {
    const otherCommitment = randomFieldCommitment();
    const nonce = randomEscrowNonce();
    const escrow = escrowPda(otherCommitment, sender.publicKey, nonce);
    const mk = () =>
      program.methods
        .createEscrow(Array.from(otherCommitment), new anchor.BN(1000),
          randomBytes(60), Array.from(relayerHash), nonce)
        .accounts({
          escrow,
          mint,
          vault: ata(mint, escrow),
          senderAta,
          sender: sender.publicKey,
          config: protocolConfigPda(),
          treasury: treasury.publicKey,
          relayerEntry: relayerEntryPda(relayerHash),
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([sender])
        .rpc();
    await mk();
    await expect(mk()).to.be.rejected; // 同 nonce：PDA already initialized
    // issue #9 回归：同一 (commitment, sender) 换 nonce 可重复发送
    const nonce2 = randomEscrowNonce();
    const escrow2 = escrowPda(otherCommitment, sender.publicKey, nonce2);
    await program.methods
      .createEscrow(Array.from(otherCommitment), new anchor.BN(1000),
        randomBytes(60), Array.from(relayerHash), nonce2)
      .accounts({
        escrow: escrow2,
        mint,
        vault: ata(mint, escrow2),
        senderAta,
        sender: sender.publicKey,
        config: protocolConfigPda(),
        treasury: treasury.publicKey,
        relayerEntry: relayerEntryPda(relayerHash),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sender])
      .rpc();
    const acc = await program.account.escrow.fetch(escrow2);
    assert.equal(acc.amount.toNumber(), 1000);
    assert.isTrue(acc.nonce.eq(nonce2));
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
      .createEscrow(Array.from(commitment), new anchor.BN(7),
        randomBytes(60), Array.from(relayerHash), new anchor.BN(0))
      .accounts({
        escrow: escrow2,
        mint,
        vault: ata(mint, escrow2),
        senderAta: sender2Ata,
        sender: sender2.publicKey,
        config: protocolConfigPda(),
        treasury: treasury.publicKey,
        relayerEntry: relayerEntryPda(relayerHash),
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sender2])
      .rpc();
    const acc = await program.account.escrow.fetch(escrow2);
    assert.equal(acc.amount.toNumber(), 7);
    assert.equal(acc.sender.toBase58(), sender2.publicKey.toBase58());
  });

  it("rejects inactive relayer", async () => {
    const h = randomBytes(32);
    await program.methods.registerRelayer("dead@x.io", Array.from(h),
        Array.from(randomBytes(32)), sender.publicKey, new anchor.BN(0))
      .accounts({ relayerEntry: relayerEntryPda(h), claimAuthority: sender.publicKey })
      .signers([sender]).rpc();
    await program.methods.updateRelayer(Array.from(h), null, null, null, false)
      .accounts({ relayerEntry: relayerEntryPda(h), claimAddress: sender.publicKey })
      .signers([sender]).rpc();
    const c = randomFieldCommitment();
    await expect(program.methods
      .createEscrow(Array.from(c), new anchor.BN(1), randomBytes(60), Array.from(h), new anchor.BN(0))
      .accounts({
        escrow: escrowPda(c, sender.publicKey), mint,
        vault: ata(mint, escrowPda(c, sender.publicKey)), senderAta,
        sender: sender.publicKey,
        config: protocolConfigPda(), treasury: treasury.publicKey,
        relayerEntry: relayerEntryPda(h), tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sender]).rpc()).to.be.rejectedWith(/RelayerNotActive/);
  });

  it("rejects oversize cipher (>137B)", async () => {
    const c = randomFieldCommitment();
    await expect(program.methods
      .createEscrow(Array.from(c), new anchor.BN(1), randomBytes(138), Array.from(relayerHash), new anchor.BN(0))
      .accounts({
        escrow: escrowPda(c, sender.publicKey), mint,
        vault: ata(mint, escrowPda(c, sender.publicKey)), senderAta,
        sender: sender.publicKey,
        config: protocolConfigPda(), treasury: treasury.publicKey,
        relayerEntry: relayerEntryPda(relayerHash), tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sender]).rpc()).to.be.rejectedWith(/InvalidCipherSize/);
  });

  it("rejects unknown relayer hash (PDA not initialized)", async () => {
    const c = randomFieldCommitment();
    const h = randomBytes(32);
    await expect(program.methods
      .createEscrow(Array.from(c), new anchor.BN(1), randomBytes(60), Array.from(h), new anchor.BN(0))
      .accounts({
        escrow: escrowPda(c, sender.publicKey), mint,
        vault: ata(mint, escrowPda(c, sender.publicKey)), senderAta,
        sender: sender.publicKey,
        config: protocolConfigPda(), treasury: treasury.publicKey,
        relayerEntry: relayerEntryPda(h), tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([sender]).rpc()).to.be.rejected; // AccountNotInitialized
  });
});
