import * as anchor from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { assert, expect } from "chai";
import { randomBytes } from "crypto";
import { program, provider, relayerEntryPda, protocolConfigPda, fundSender } from "./helpers";

describe("relayer registry + protocol config", () => {
  const authority = provider.wallet.publicKey;
  const stranger = Keypair.generate();
  const treasury = Keypair.generate();
  const relayerHash = randomBytes(32);
  const relayerKp = Keypair.generate();

  before(async () => {
    await fundSender(stranger);
    // protocol config 先到先得；其他套件已初始化时以 authority 重置为本套件的 treasury/fee
    try {
      await program.methods.initializeProtocol(treasury.publicKey, new anchor.BN(10_000_000), new anchor.BN(2_592_000))
        .accounts({ config: protocolConfigPda(), payer: authority }).rpc();
    } catch {
      await program.methods.updateProtocol(treasury.publicKey, new anchor.BN(10_000_000), new anchor.BN(2_592_000))
        .accounts({ config: protocolConfigPda(), authority }).rpc();
    }
  });

  it("initializes protocol config once (first-come-first-served)", async () => {
    try {
      await program.methods.initializeProtocol(treasury.publicKey, new anchor.BN(10_000_000), new anchor.BN(2_592_000))
        .accounts({ config: protocolConfigPda(), payer: authority }).rpc();
    } catch { /* 其他套件可能已初始化 */ }
    const cfg = await program.account.protocolConfig.fetch(protocolConfigPda());
    assert.equal(cfg.authority.toBase58(), authority.toBase58());
    assert.equal(cfg.treasury.toBase58(), treasury.publicKey.toBase58());
    assert.equal(cfg.feeLamports.toNumber(), 10_000_000);
    await expect(program.methods.initializeProtocol(treasury.publicKey, new anchor.BN(1), new anchor.BN(2_592_000))
      .accounts({ config: protocolConfigPda(), payer: stranger.publicKey })
      .signers([stranger]).rpc()).to.be.rejected; // already init
  });

  it("authority can update protocol; stranger cannot", async () => {
    const t2 = Keypair.generate();
    await program.methods.updateProtocol(t2.publicKey, new anchor.BN(5_000_000), new anchor.BN(2_592_000))
      .accounts({ config: protocolConfigPda(), authority }).rpc();
    const cfg = await program.account.protocolConfig.fetch(protocolConfigPda());
    assert.equal(cfg.treasury.toBase58(), t2.publicKey.toBase58());
    assert.equal(cfg.feeLamports.toNumber(), 5_000_000);
    // 恢复，避免影响其他套件
    await program.methods.updateProtocol(treasury.publicKey, new anchor.BN(10_000_000), new anchor.BN(2_592_000))
      .accounts({ config: protocolConfigPda(), authority }).rpc();
    await expect(program.methods.updateProtocol(t2.publicKey, null, new anchor.BN(2_592_000))
      .accounts({ config: protocolConfigPda(), authority: stranger.publicKey })
      .signers([stranger]).rpc()).to.be.rejectedWith(/Unauthorized/);
  });

  it("authority can update timestamp window", async () => {
    await program.methods.updateProtocol(null, null, new anchor.BN(3600))
      .accounts({ config: protocolConfigPda(), authority }).rpc();
    const cfg = await program.account.protocolConfig.fetch(protocolConfigPda());
    assert.equal(cfg.timestampWindowPast.toNumber(), 3600);
    await program.methods.updateProtocol(null, null, new anchor.BN(2_592_000))
      .accounts({ config: protocolConfigPda(), authority }).rpc();
  });

  it("registers relayer (email lowercased) and emits event", async () => {
    let seen: any = null;
    const sub = program.addEventListener("relayerRegistered", (e: any) => { seen = e; });
    const email = "Relay@ZkEmail.io";
    await program.methods.registerRelayer(
        email, Array.from(relayerHash), Array.from(randomBytes(32)),
        relayerKp.publicKey, new anchor.BN(0))
      .accounts({ relayerEntry: relayerEntryPda(relayerHash), claimAuthority: authority })
      .rpc();
    await new Promise((r) => setTimeout(r, 1500));
    await program.removeEventListener(sub);
    const entry = await program.account.relayerEntry.fetch(relayerEntryPda(relayerHash));
    assert.equal(entry.email, "relay@zkemail.io");
    assert.deepEqual([...entry.emailHash], [...relayerHash]);
    assert.equal(entry.claimAddress.toBase58(), relayerKp.publicKey.toBase58());
    assert.isTrue(entry.active);
    assert.ok(seen);
    assert.equal(seen.email, "relay@zkemail.io");
  });

  it("rejects duplicate registration and oversize email", async () => {
    await expect(program.methods.registerRelayer(
        "other@x.io", Array.from(relayerHash), Array.from(randomBytes(32)),
        relayerKp.publicKey, new anchor.BN(0))
      .accounts({ relayerEntry: relayerEntryPda(relayerHash), claimAuthority: authority })
      .rpc()).to.be.rejected; // PDA already initialized
    const longHash = randomBytes(32);
    await expect(program.methods.registerRelayer(
        "a".repeat(65) + "@x.io", Array.from(longHash), Array.from(randomBytes(32)),
        relayerKp.publicKey, new anchor.BN(0))
      .accounts({ relayerEntry: relayerEntryPda(longHash), claimAuthority: authority })
      .rpc()).to.be.rejectedWith(/InvalidEmail/);
  });

  it("only claim_address can update relayer", async () => {
    await expect(program.methods.updateRelayer(Array.from(relayerHash), null, null, null, false)
      .accounts({ relayerEntry: relayerEntryPda(relayerHash), claimAddress: stranger.publicKey })
      .signers([stranger]).rpc()).to.be.rejectedWith(/Unauthorized/);
    await program.methods.updateRelayer(Array.from(relayerHash), null, null, null, false)
      .accounts({ relayerEntry: relayerEntryPda(relayerHash), claimAddress: relayerKp.publicKey })
      .signers([relayerKp]).rpc();
    const entry = await program.account.relayerEntry.fetch(relayerEntryPda(relayerHash));
    assert.isFalse(entry.active);
    // 恢复 active，供后续套件使用
    await program.methods.updateRelayer(Array.from(relayerHash), null, null, null, true)
      .accounts({ relayerEntry: relayerEntryPda(relayerHash), claimAddress: relayerKp.publicKey })
      .signers([relayerKp]).rpc();
  });
});
