import * as anchor from "@coral-xyz/anchor";
import { createMint, createAccount, mintTo, getAccount, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert, expect } from "chai";
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import fs from "fs";
import { buildBatchTree, merklePath } from "../../circuits/scripts/merkle";
import {
  program, provider, ata, fundSender, fieldToBE, relayerEntryPda, protocolConfigPda,
  nullifierPda, registryPda, configPda, createAltAccount, sendV0Tx, randNonce, batchPda,
} from "./helpers";

// 与 claim.eml / sweep.eml 同 From 邮箱的新邮件；不存在时 zk 用例自动跳过
// （nullifier 全局唯一，已被 claim.ts / sweep-inbox.ts 花费的 fixture 不可复用）。
const BATCH_EML = "../circuits/testdata/emails/batch-claim.eml";
const FIXTURE_PATH = "../circuits/build/batch-claim-proof.json";
const AMOUNT = 77_000;

describe("claim_batch", () => {
  const sender = Keypair.generate();
  const payer = Keypair.generate();
  const treasury = Keypair.generate();
  let mint: PublicKey;
  let senderAta: PublicKey;
  let fixture: any;
  const fakeHash = randomBytes(32);

  before(async function () {
    this.timeout(900_000);
    await fundSender(sender);
    await fundSender(payer);
    mint = await createMint(provider.connection, sender, sender.publicKey, null, 6);
    senderAta = await createAccount(provider.connection, sender, mint, sender.publicKey);
    await mintTo(provider.connection, sender, mint, senderAta, sender, 1_000_000_000);
    const authority = provider.wallet.publicKey;
    try {
      await program.methods.initializeProtocol(treasury.publicKey, new anchor.BN(10_000_000), new anchor.BN(2_592_000))
        .accounts({ config: protocolConfigPda(), payer: authority }).rpc();
    } catch {
      await program.methods.updateProtocol(treasury.publicKey, new anchor.BN(10_000_000), new anchor.BN(2_592_000))
        .accounts({ config: protocolConfigPda(), authority }).rpc();
    }
    await program.methods.registerRelayer("batch-claim-relay@zkemail.io", Array.from(fakeHash), Array.from(randomBytes(32)), sender.publicKey, new anchor.BN(0))
      .accounts({ relayerEntry: relayerEntryPda(fakeHash), claimAuthority: sender.publicKey }).signers([sender]).rpc();
    try {
      await program.methods.initializeRegistry(authority).accounts({ config: configPda(), payer: authority }).rpc();
    } catch { /* 其他套件已初始化 */ }
  });

  // fake 证明：timestamp 字段（[2]）高 24 字节须为零，否则 parse_public_inputs 先拒；
  // 其余字段随机。[8] = relayerEmailHash，建 batch 时指到它即可命中 Merkle 检查。
  const fakeProof = (relayerEmailHash?: Buffer) => {
    const publicInputs = Array.from({ length: 9 }, () => Array.from(randomBytes(32)));
    const ts = Buffer.alloc(32);
    ts.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)), 24);
    publicInputs[2] = Array.from(ts);
    if (relayerEmailHash) publicInputs[8] = Array.from(relayerEmailHash);
    return {
      proofA: Array.from(randomBytes(64)), proofB: Array.from(randomBytes(128)),
      proofC: Array.from(randomBytes(64)), publicInputs, selector: "s",
    };
  };

  const setupBatch = async (commitments: Buffer[], relayerEmailHash: Buffer) => {
    const tree = buildBatchTree(commitments);
    const root = tree.root;
    const nonce = randNonce();
    const batch = batchPda(sender.publicKey, root, nonce);
    const cipherLen = 64;
    await program.methods.createBatch(Array.from(root), new anchor.BN(AMOUNT), commitments.length, cipherLen,
      new anchor.BN(Math.floor(Date.now() / 1000) + 86_400), Array.from(relayerEmailHash), nonce)
      .accounts({
        batch, mint, vault: ata(mint, batch), senderAta, sender: sender.publicKey,
        config: protocolConfigPda(), treasury: treasury.publicKey, relayerEntry: relayerEntryPda(relayerEmailHash),
        tokenProgram: TOKEN_PROGRAM_ID,
      }).signers([sender]).rpc();
    await program.methods.appendBatchCipher(Buffer.alloc(cipherLen, 7))
      .accounts({ batch, sender: sender.publicKey }).signers([sender]).rpc();
    await program.methods.sealBatch().accounts({ batch, sender: sender.publicKey }).signers([sender]).rpc();
    return { tree, root, batch };
  };

  const claimBatchIxs = (
    batch: PublicKey, commitment: Buffer, path: { siblings: Buffer[]; indices: number[] },
    proof: any, nullifier: Buffer, registry: PublicKey, destOwner: PublicKey, destAta: PublicKey
  ) =>
    program.methods.claimBatch(
      { proofA: proof.proofA, proofB: proof.proofB, proofC: proof.proofC,
        publicInputs: proof.publicInputs, selector: proof.selector } as any,
      path.siblings.map((s) => Array.from(s)),
      Buffer.from(path.indices),
    ).accounts({
      batch, vault: ata(mint, batch), mint, registry, destOwner, destAta,
      payer: payer.publicKey, nullifier, protocolConfig: protocolConfigPda(), tokenProgram: TOKEN_PROGRAM_ID,
    }).preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .transaction().then((t: any) => t.instructions);
  it("rejects claim on unsealed batch", async () => {
    const proof = fakeProof();
    const c = randomBytes(32);
    const tree = buildBatchTree([c]);
    const nonce = randNonce();
    const batch = batchPda(sender.publicKey, tree.root, nonce);
    await program.methods.createBatch(Array.from(tree.root), new anchor.BN(AMOUNT), 1, 32,
      new anchor.BN(Math.floor(Date.now() / 1000) + 86_400), Array.from(fakeHash), nonce)
      .accounts({
        batch, mint, vault: ata(mint, batch), senderAta, sender: sender.publicKey,
        config: protocolConfigPda(), treasury: treasury.publicKey, relayerEntry: relayerEntryPda(fakeHash),
        tokenProgram: TOKEN_PROGRAM_ID,
      }).signers([sender]).rpc();
    // 账户约束先于 handler 执行：registry 必须已初始化且 seeds 命中 proof[6]，否则到不了 BatchNotSealed
    await program.methods.registryUpsert(
      Array.from(proof.publicInputs[6]), "s", Array.from(proof.publicInputs[0]),
      new anchor.BN(Math.floor(Date.now() / 1000) + 3600))
      .accounts({ config: configPda(), registry: registryPda(Buffer.from(proof.publicInputs[6]), "s"), authority: provider.wallet.publicKey }).rpc();
    const ixs = await claimBatchIxs(batch, c, { siblings: [], indices: [] }, proof,
      nullifierPda(Buffer.from(proof.publicInputs[7])), registryPda(Buffer.from(proof.publicInputs[6]), "s"), sender.publicKey, ata(mint, sender.publicKey));
    await expect(sendV0Tx(ixs, [payer], [], payer.publicKey)).to.be.rejectedWith(/BatchNotSealed/i);
  });

  it("rejects wrong merkle path (before groth16, no real proof needed)", async () => {
    const proof = fakeProof();
    const relayerHashFromProof = Buffer.from(proof.publicInputs[8]);
    await program.methods.registerRelayer("batch-path-relay@zkemail.io", Array.from(relayerHashFromProof), Array.from(randomBytes(32)), sender.publicKey, new anchor.BN(0))
      .accounts({ relayerEntry: relayerEntryPda(relayerHashFromProof), claimAuthority: sender.publicKey }).signers([sender]).rpc();
    const [c0, c1] = [randomBytes(32), randomBytes(32)];
    // fake 证明的 commitment（[1]）必须是要领的叶子，才能区分"路径错"与"承诺错"
    proof.publicInputs[1] = Array.from(c0);
    const { tree, batch } = await setupBatch([c0, c1], relayerHashFromProof);
    // 同上：registry 须初始化且 seeds 命中 proof[6]，错误路径才能到达 handler 的 Merkle 检查
    await program.methods.registryUpsert(
      Array.from(proof.publicInputs[6]), "s", Array.from(proof.publicInputs[0]),
      new anchor.BN(Math.floor(Date.now() / 1000) + 3600))
      .accounts({ config: configPda(), registry: registryPda(Buffer.from(proof.publicInputs[6]), "s"), authority: provider.wallet.publicKey }).rpc();
    const good = merklePath(tree, 0);
    const badSiblings = good.siblings.slice();
    badSiblings[0] = randomBytes(32);
    const ixs = await claimBatchIxs(batch, c0, { siblings: badSiblings, indices: good.indices }, proof,
      nullifierPda(Buffer.from(proof.publicInputs[7])), registryPda(Buffer.from(proof.publicInputs[6]), "s"), sender.publicKey, ata(mint, sender.publicKey));
    await expect(sendV0Tx(ixs, [payer], [], payer.publicKey)).to.be.rejectedWith(/BatchInvalidProof/i);
  });

  it("rejects claiming a padding leaf (index >= leaf_count)", async () => {
    const proof = fakeProof();
    const relayerHashFromProof = Buffer.from(proof.publicInputs[8]);
    await program.methods.registerRelayer("batch-pad-relay@zkemail.io", Array.from(relayerHashFromProof), Array.from(randomBytes(32)), sender.publicKey, new anchor.BN(0))
      .accounts({ relayerEntry: relayerEntryPda(relayerHashFromProof), claimAuthority: sender.publicKey }).signers([sender]).rpc();
    // 树按 2 叶建，但 leaf_count=1 → 索引 1 是 padding
    const [c0, c1] = [randomBytes(32), randomBytes(32)];
    // fake 证明的 commitment（[1]）必须是所领叶子 c1，才能走到 leaf_index 越界检查
    proof.publicInputs[1] = Array.from(c1);
    const tree = buildBatchTree([c0, c1]);
    const root = tree.root;
    const nonce = randNonce();
    const batch = batchPda(sender.publicKey, root, nonce);
    await program.methods.createBatch(Array.from(root), new anchor.BN(AMOUNT), 1, 32,
      new anchor.BN(Math.floor(Date.now() / 1000) + 86_400), Array.from(relayerHashFromProof), nonce)
      .accounts({
        batch, mint, vault: ata(mint, batch), senderAta, sender: sender.publicKey,
        config: protocolConfigPda(), treasury: treasury.publicKey, relayerEntry: relayerEntryPda(relayerHashFromProof),
        tokenProgram: TOKEN_PROGRAM_ID,
      }).signers([sender]).rpc();
    await program.methods.appendBatchCipher(Buffer.alloc(32, 7))
      .accounts({ batch, sender: sender.publicKey }).signers([sender]).rpc();
    await program.methods.sealBatch().accounts({ batch, sender: sender.publicKey }).signers([sender]).rpc();
    const p = merklePath(tree, 1);
    // 同上：registry 须初始化且 seeds 命中 proof[6]
    await program.methods.registryUpsert(
      Array.from(proof.publicInputs[6]), "s", Array.from(proof.publicInputs[0]),
      new anchor.BN(Math.floor(Date.now() / 1000) + 3600))
      .accounts({ config: configPda(), registry: registryPda(Buffer.from(proof.publicInputs[6]), "s"), authority: provider.wallet.publicKey }).rpc();
    const ixs = await claimBatchIxs(batch, c1, p, proof,
      nullifierPda(Buffer.from(proof.publicInputs[7])), registryPda(Buffer.from(proof.publicInputs[6]), "s"), sender.publicKey, ata(mint, sender.publicKey));
    await expect(sendV0Tx(ixs, [payer], [], payer.publicKey)).to.be.rejectedWith(/BatchLeafOutOfRange/i);
  });

  // —— 以下用例需要 batch-claim.eml（与 claim.eml 同 From、不同 DKIM 签名）——
  const hasEml = fs.existsSync(BATCH_EML);
  const itOrSkip = hasEml ? it : it.skip;

  itOrSkip("claims a leaf with a real proof (needs batch-claim.eml)", async function () {
    this.timeout(900_000);
    execFileSync("npx", ["tsx", "../circuits/scripts/prove-for.ts", BATCH_EML, payer.publicKey.toBase58(), "build/batch-claim-proof.json"], {
      cwd: "../circuits", stdio: "inherit", env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=16384" },
    });
    fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
    // proof 绑定的 relayerEmailHash 必须作为 batch 的 relayer_email_hash
    const relayerHash = fieldToBE(fixture.meta.relayerEmailHash);
    const commitment = fieldToBE(fixture.meta.commitment);
    await program.methods.registerRelayer(fixture.meta.toEmail, Array.from(relayerHash), Array.from(randomBytes(32)), sender.publicKey, new anchor.BN(0))
      .accounts({ relayerEntry: relayerEntryPda(relayerHash), claimAuthority: sender.publicKey }).signers([sender]).rpc();
    const expires = Math.floor(Date.now() / 1000) + 3600;
    await program.methods.registryUpsert(
      Array.from(fieldToBE(fixture.meta.domainCommitment)), fixture.meta.selector,
      Array.from(fieldToBE(fixture.meta.pubkeyHash)), new anchor.BN(expires))
      .accounts({ config: configPda(), registry: registryPda(fieldToBE(fixture.meta.domainCommitment), fixture.meta.selector), authority: provider.wallet.publicKey }).rpc();

    const other = randomBytes(32);
    const { tree, batch } = await setupBatch([commitment, other], relayerHash);
    const destOwner = new PublicKey(fixture.meta.destBase58);
    const registry = registryPda(fieldToBE(fixture.meta.domainCommitment), fixture.meta.selector);
    const nullifier = nullifierPda(fieldToBE(fixture.meta.emailNullifier));
    const altAccount = await createAltAccount([
      program.programId, SystemProgram.programId, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      mint, batch, ata(mint, batch), registry, destOwner, ata(mint, destOwner), nullifier, protocolConfigPda(),
    ]);
    const path = merklePath(tree, 0);
    const tx = await program.methods.claimBatch(
      { proofA: fixture.proofA, proofB: fixture.proofB, proofC: fixture.proofC,
        publicInputs: fixture.publicInputs, selector: fixture.meta.selector } as any,
      path.siblings.map((s) => Array.from(s)), Buffer.from(path.indices),
    ).accounts({
      batch, vault: ata(mint, batch), mint, registry, destOwner, destAta: ata(mint, destOwner),
      payer: payer.publicKey, nullifier, protocolConfig: protocolConfigPda(), tokenProgram: TOKEN_PROGRAM_ID,
    }).preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]).transaction();
    const sig = await sendV0Tx(tx.instructions, [payer], [altAccount], payer.publicKey);

    const destAta = await getAccount(provider.connection, ata(mint, destOwner));
    assert.equal(destAta.amount.toString(), AMOUNT.toString());
    const acc = await program.account.batch.fetch(batch);
    assert.equal(acc.claimedCount, 1);
    assert.equal(acc.claimed[0] & 1, 1);
    const vault = await getAccount(provider.connection, ata(mint, batch));
    assert.equal(vault.amount.toString(), AMOUNT.toString()); // 剩余 1 份
    const txInfo = await provider.connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    console.log(`claim_batch tx ${sig} consumed ${txInfo?.meta?.computeUnitsConsumed} CU`);

    // 同叶双领：位图已置位 + nullifier 已花 → 拒绝
    await expect(sendV0Tx(tx.instructions, [payer], [altAccount], payer.publicKey)).to.be.rejected;
  });
});
