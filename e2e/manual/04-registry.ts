// 04: 运营侧——初始化 DKIM registry（首个调用者成为 authority，重复调用会报错可忽略）
//     并 upsert 该邮件服务商的 DKIM 公钥哈希（数据取自 03 步产出的 proof.json）。
import fs from "fs";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { fieldToBE, loadKeypair, loadProgram, PROOF_FILE, programId } from "./common";

async function main() {
  const fixture = JSON.parse(fs.readFileSync(PROOF_FILE, "utf8"));
  const relayer = loadKeypair("relayer");
  const program = loadProgram(relayer);

  const config = PublicKey.findProgramAddressSync([Buffer.from("config")], programId())[0];
  try {
    await program.methods.initializeRegistry(relayer.publicKey)
      .accounts({ config, payer: relayer.publicKey }).rpc();
    console.log("[04] registry initialized, authority = relayer");
  } catch {
    console.log("[04] registry already initialized, skip");
  }

  const selector: string = fixture.selector;
  const registry = PublicKey.findProgramAddressSync(
    [Buffer.from("dkim"), fieldToBE(fixture.meta.domainCommitment), Buffer.from(selector)],
    programId())[0];
  await program.methods.registryUpsert(
    Array.from(fieldToBE(fixture.meta.domainCommitment)), selector,
    Array.from(fieldToBE(fixture.meta.pubkeyHash)),
    new anchor.BN(Math.floor(Date.now() / 1000) + 3600))
    .accounts({ config, registry, authority: relayer.publicKey }).rpc();
  console.log(`[04] dkim registry upserted: domain=${fixture.meta.domain} selector=${selector}`);
  console.log(`[04] registry PDA=${registry.toBase58()}`);
}
main().catch((e) => { console.error("[04] FAIL:", e?.message ?? e); process.exit(1); });
