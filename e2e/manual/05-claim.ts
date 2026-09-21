// 05: claim——单笔交易完成 验证明 + 解码 dest + 转账 + 关闭 escrow/vault。
//     relayer 代付并发交易（证明已绑定 relayer 公钥），dest 来自邮件 Subject。
import fs from "fs";
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ata, fieldToBE, loadKeypair, loadProgram, mustState, PROOF_FILE, programId } from "./common";

async function main() {
  const state = mustState();
  const fixture = JSON.parse(fs.readFileSync(PROOF_FILE, "utf8"));
  const sender = loadKeypair("sender");
  const relayer = loadKeypair("relayer");
  const program = loadProgram(relayer);

  const mint = new PublicKey(state.mint);
  const escrow = new PublicKey(state.escrow);
  const destOwner = new PublicKey(fixture.meta.destBase58);
  const registry = PublicKey.findProgramAddressSync(
    [Buffer.from("dkim"), fieldToBE(fixture.meta.domainCommitment), Buffer.from(fixture.selector)],
    programId())[0];
  const nullifier = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), fieldToBE(fixture.meta.emailNullifier)],
    programId())[0];
  const protocolConfig = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")], programId())[0];

  const sig = await program.methods.claim({
    proofA: fixture.proofA, proofB: fixture.proofB, proofC: fixture.proofC,
    publicInputs: fixture.publicInputs, selector: fixture.selector,
  })
    .accounts({
      escrow, sender: sender.publicKey, vault: ata(mint, escrow), mint,
      registry, destOwner, destAta: ata(mint, destOwner), payer: relayer.publicKey,
      nullifier, protocolConfig,
      tokenProgram: TOKEN_PROGRAM_ID })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
    .signers([relayer]).rpc();
  console.log(`[05] claim tx: ${sig}`);
}
main().catch((e) => { console.error("[05] FAIL:", e?.message ?? e); process.exit(1); });
