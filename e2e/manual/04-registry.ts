// 04: 运营侧——初始化 protocol config + 注册 relayer（RELAYER_EMAIL）+ DKIM registry 初始化与 upsert。
// 本脚本幂等，在新顺序里先于 02 跑（02 依赖链上 relayerEntry）：
// proof.json（03 步产出）尚不存在时跳过 DKIM upsert，03 完成后再跑一次本脚本补齐。
import fs from "fs";
import nacl from "tweetnacl";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  fieldToBE, loadKeypair, loadProgram, loadState, programId,
  PROOF_FILE, PROTOCOL_FEE, RELAYER_EMAIL, saveState,
} from "./common";
import { relayerEmailHash } from "../../relayer/crypto";

async function main() {
  const relayer = loadKeypair("relayer");
  const program = loadProgram(relayer);

  const treasury = Keypair.generate(); // 演示用；每次跑 04 会重新 init（重跑需 --reset validator）
  const protocolConfig = PublicKey.findProgramAddressSync([Buffer.from("protocol")], programId())[0];
  try {
    await program.methods.initializeProtocol(treasury.publicKey, new anchor.BN(PROTOCOL_FEE))
      .accounts({ config: protocolConfig, payer: relayer.publicKey }).rpc();
    console.log("[04] protocol initialized, treasury =", treasury.publicKey.toBase58());
  } catch { console.log("[04] protocol already initialized, skip"); }

  const relayerHash = await relayerEmailHash(RELAYER_EMAIL);
  const relayerEntry = PublicKey.findProgramAddressSync(
    [Buffer.from("relayer"), relayerHash], programId())[0];
  const x25519 = nacl.box.keyPair();
  try {
    await program.methods.registerRelayer(
        RELAYER_EMAIL, Array.from(relayerHash), Array.from(x25519.publicKey),
        relayer.publicKey, new anchor.BN(0))
      .accounts({ relayerEntry, claimAuthority: relayer.publicKey }).rpc();
    const secretHex = Buffer.from(x25519.secretKey).toString("hex");
    saveState({ relayerX25519Secret: secretHex });
    console.log(`[04] relayer registered: ${RELAYER_EMAIL}`);
    console.log(`[04] relayer x25519 secret (hex, 存档供 indexer 用): ${secretHex}`);
  } catch {
    console.log("[04] relayer already registered, skip");
    if (!loadState().relayerX25519Secret) {
      console.log("[04] 警告: state.json 无 relayerX25519Secret——indexer 无法解密，建议 --reset validator 后重跑 04");
    }
  }

  if (!fs.existsSync(PROOF_FILE)) {
    console.log("[04] proof.json 不存在——跳过 DKIM upsert，03 步完成后再跑一次本脚本补齐");
    return;
  }
  const fixture = JSON.parse(fs.readFileSync(PROOF_FILE, "utf8"));
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
