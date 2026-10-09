import * as anchor from "@coral-xyz/anchor";
import { createMint, createAccount, mintTo, getAccount, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert, expect } from "chai";
import { randomBytes } from "crypto";
import { program, provider, ata, fundSender, relayerEntryPda, protocolConfigPda, randNonce, batchPda } from "./helpers";

const randRoot = () => randomBytes(32);

describe("batch lifecycle", () => {
  const sender = Keypair.generate();
  const treasury = Keypair.generate();
  const relayerHash = randomBytes(32);
  let mint: PublicKey;
  let senderAta: PublicKey;

  before(async () => {
    await fundSender(sender);
    mint = await createMint(provider.connection, sender, sender.publicKey, null, 6);
    senderAta = await createAccount(provider.connection, sender, mint, sender.publicKey);
    await mintTo(provider.connection, sender, mint, senderAta, sender, 10_000_000_000);
    const authority = provider.wallet.publicKey;
    try {
      await program.methods.initializeProtocol(treasury.publicKey, new anchor.BN(10_000_000), new anchor.BN(2_592_000))
        .accounts({ config: protocolConfigPda(), payer: authority }).rpc();
    } catch {
      await program.methods.updateProtocol(treasury.publicKey, new anchor.BN(10_000_000), new anchor.BN(2_592_000))
        .accounts({ config: protocolConfigPda(), authority }).rpc();
    }
    await program.methods.registerRelayer("batch-relay@zkemail.io", Array.from(relayerHash), Array.from(randomBytes(32)), sender.publicKey, new anchor.BN(0))
      .accounts({ relayerEntry: relayerEntryPda(relayerHash), claimAuthority: sender.publicKey }).signers([sender]).rpc();
  });

  /** 组装 createBatch。nonce 默认随机（issue #9：同收件人列表凭不同 nonce 可重复发送）。 */
  const planCreate = (root: Buffer, amount: number, leaves: number, cipherLen: number, expireIn: number, nonce = randNonce()) => {
    const batch = batchPda(sender.publicKey, root, nonce);
    const ix = program.methods.createBatch(Array.from(root), new anchor.BN(amount), leaves, cipherLen,
      new anchor.BN(Math.floor(Date.now() / 1000) + expireIn), Array.from(relayerHash), nonce)
      .accounts({
        batch, mint,
        vault: ata(mint, batch),
        senderAta, sender: sender.publicKey, config: protocolConfigPda(),
        treasury: treasury.publicKey, relayerEntry: relayerEntryPda(relayerHash),
        tokenProgram: TOKEN_PROGRAM_ID,
      }).signers([sender]);
    return { nonce, batch, ix };
  };

  it("creates batch, pays per-leaf protocol fee and deposits total", async () => {
    const root = randRoot();
    const { batch, ix } = planCreate(root, 500_000, 3, 120, 86_400);
    const before = await provider.connection.getBalance(treasury.publicKey);
    let seen: any = null;
    const sub = program.addEventListener("batchCreated", (e: any) => { seen = e; });
    await ix.rpc();
    await new Promise((r) => setTimeout(r, 1500));
    await program.removeEventListener(sub);
    const acc = await program.account.batch.fetch(batch);
    assert.equal(acc.amountPerRecipient.toNumber(), 500_000);
    assert.equal(acc.totalAmount.toNumber(), 1_500_000);
    assert.equal(acc.leafCount, 3);
    assert.equal(acc.claimedCount, 0);
    assert.equal(acc.claimed.length, 1); // ceil(3/8)
    assert.equal(acc.recipientsCipher.length, 0);
    assert.isFalse(acc.sealed);
    const after = await provider.connection.getBalance(treasury.publicKey);
    assert.equal(after - before, 3 * 10_000_000); // leaf_count × fee
    const vault = await getAccount(provider.connection, ata(mint, batch));
    assert.equal(vault.amount.toString(), "1500000");
    assert.ok(seen);
    assert.equal(seen.batch.toBase58(), batch.toBase58());
  });

  it("rejects zero amount / zero leaves / zero cipher / short expiry / too many leaves", async () => {
    await expect(planCreate(randRoot(), 0, 3, 120, 86_400).ix.rpc()).to.be.rejectedWith(/InvalidAmount/i);
    await expect(planCreate(randRoot(), 500, 0, 120, 86_400).ix.rpc()).to.be.rejectedWith(/BatchTooManyLeaves/i);
    await expect(planCreate(randRoot(), 500, 3, 0, 86_400).ix.rpc()).to.be.rejectedWith(/InvalidBatchCipher/i);
    await expect(planCreate(randRoot(), 500, 3, 120, 100).ix.rpc()).to.be.rejectedWith(/BatchInvalidExpiry/i);
    await expect(planCreate(randRoot(), 500, 65_537, 120, 86_400).ix.rpc()).to.be.rejectedWith(/BatchTooManyLeaves/i);
  });

  it("same root can be re-sent with a different nonce; same nonce replays are rejected (issue #9)", async () => {
    const root = randRoot();
    const first = planCreate(root, 500_000, 2, 9, 86_400);
    await first.ix.rpc();
    const second = planCreate(root, 600_000, 2, 9, 86_400);
    assert.notStrictEqual(second.batch.toBase58(), first.batch.toBase58());
    await second.ix.rpc();
    const acc1 = await program.account.batch.fetch(first.batch);
    const acc2 = await program.account.batch.fetch(second.batch);
    assert.strictEqual(acc1.nonce.toString(), first.nonce.toString());
    assert.strictEqual(acc2.amountPerRecipient.toNumber(), 600_000);
    // 相同 (sender, root, nonce) 重放：同一 PDA 已存在，链上 init 拒绝；
    // 客户端职责是预检后换新 nonce 重试（概率 ~1/2^64，见 issue #9）
    await expect(planCreate(root, 600_000, 2, 9, 86_400, first.nonce).ix.rpc()).to.be.rejected;
  });

  it("appends chunks until expected length, then seals", async () => {
    const root = randRoot();
    const { batch, ix } = planCreate(root, 500_000, 2, 9, 86_400);
    await ix.rpc();
    const chunk = (buf: Buffer) =>
      program.methods.appendBatchCipher(buf)
        .accounts({ batch, sender: sender.publicKey }).signers([sender]).rpc();
    const other = Keypair.generate();
    await fundSender(other);
    await expect(
      program.methods.appendBatchCipher(Buffer.from([1]))
        .accounts({ batch: batch, sender: other.publicKey }).signers([other]).rpc()
    ).to.be.rejectedWith(/Unauthorized/i);
    await chunk(Buffer.from([1, 2, 3, 4, 5]));
    await chunk(Buffer.from([6, 7, 8, 9]));
    await expect(chunk(Buffer.from([10, 11]))).to.be.rejectedWith(/BatchCipherOverflow/i);
    await program.methods.sealBatch().accounts({ batch: batch, sender: sender.publicKey }).signers([sender]).rpc();
    const acc = await program.account.batch.fetch(batch);
    assert.deepEqual([...acc.recipientsCipher], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.isTrue(acc.sealed);
    await expect(chunk(Buffer.from([1]))).to.be.rejectedWith(/BatchAlreadySealed/i);
  });

  it("seal rejects length mismatch", async () => {
    const root = randRoot();
    const { batch, ix } = planCreate(root, 500, 1, 10, 86_400);
    await ix.rpc();
    await program.methods.appendBatchCipher(Buffer.from([1])).accounts({ batch, sender: sender.publicKey }).signers([sender]).rpc();
    await expect(
      program.methods.sealBatch().accounts({ batch, sender: sender.publicKey }).signers([sender]).rpc()
    ).to.be.rejectedWith(/BatchNotSealed/i);
  });

  it("close_batch is rejected before expiry", async () => {
    const root = randRoot();
    const { batch, ix } = planCreate(root, 700_000, 2, 5, 3_600);
    await ix.rpc();
    await program.methods.appendBatchCipher(Buffer.from([9, 9, 9, 9, 9])).accounts({ batch, sender: sender.publicKey }).signers([sender]).rpc();
    await program.methods.sealBatch().accounts({ batch, sender: sender.publicKey }).signers([sender]).rpc();
    await expect(
      program.methods.closeBatch().accounts({
        batch, vault: ata(mint, batch), mint, senderAta, sender: sender.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).signers([sender]).rpc()
    ).to.be.rejectedWith(/BatchNotExpired/i);
    // 链上时钟无法快进；过期退款与领完关闭由 e2e/manual/06 覆盖。此处仅验证守卫存在。
  });
});
