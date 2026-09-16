import * as anchor from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { assert, expect } from "chai";
import { randomBytes } from "crypto";
import { program, provider, registryPda, configPda, fundSender } from "./helpers";

describe("registry", () => {
  // authority 固定为 provider 默认钱包：claim/sweep 套件共享同一 config
  const authority = provider.wallet.publicKey;
  const stranger = Keypair.generate();
  const domainCommitment = randomBytes(32);
  const pubkeyHash = randomBytes(32);

  before(async () => { await fundSender(stranger); });

  it("initializes config once", async () => {
    try {
      await program.methods.initializeRegistry(authority)
        .accounts({ config: configPda(), payer: authority }).rpc();
    } catch { /* 其他套件可能已初始化 */ }
    const cfg = await program.account.registryConfig.fetch(configPda());
    assert.equal(cfg.authority.toBase58(), authority.toBase58());
    await expect(program.methods.initializeRegistry(stranger.publicKey)
      .accounts({ config: configPda(), payer: stranger.publicKey })
      .signers([stranger]).rpc()).to.be.rejected; // already init
  });

  it("authority can upsert", async () => {
    const expires = Math.floor(Date.now() / 1000) + 90 * 24 * 3600;
    await program.methods.registryUpsert(Array.from(domainCommitment), "s1", Array.from(pubkeyHash), new anchor.BN(expires))
      .accounts({ config: configPda(), registry: registryPda(domainCommitment, "s1"), authority })
      .rpc();
    const r = await program.account.dkimRegistry.fetch(registryPda(domainCommitment, "s1"));
    assert.deepEqual(r.status, { active: {} });
  });

  it("stranger cannot upsert", async () => {
    await expect(program.methods.registryUpsert(Array.from(domainCommitment), "s2", Array.from(randomBytes(32)), new anchor.BN(0))
      .accounts({ config: configPda(), registry: registryPda(domainCommitment, "s2"), authority: stranger.publicKey })
      .signers([stranger]).rpc()).to.be.rejectedWith(/Unauthorized/);
  });

  it("authority can revoke; revoked entry stays", async () => {
    await program.methods.registryRevoke(Array.from(domainCommitment), "s1")
      .accounts({ config: configPda(), registry: registryPda(domainCommitment, "s1"), authority })
      .rpc();
    const r = await program.account.dkimRegistry.fetch(registryPda(domainCommitment, "s1"));
    assert.deepEqual(r.status, { revoked: {} });
  });
});
