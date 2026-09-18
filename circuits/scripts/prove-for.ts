// 用法: PROVER_URL=http://localhost:8080 npx tsx scripts/prove-for.ts <emlPath> <relayerPubkeyBase58> <outJson>
// dest / selector / timestamp 全部从 .eml 解析（loadClaimEmail）；relayer 绑定到给定公钥。
// 出证后端：设了 PROVER_URL 走 prover 容器（HTTP），否则本地 snarkjs（慢但无 Docker 依赖）。
import fs from "fs";
import { execFileSync } from "child_process";
import { PublicKey } from "@solana/web3.js";
import { loadClaimEmail } from "./load-email";
import { convertProofForSolana } from "./convert-proof";
import { relayerToField } from "./poseidon";

async function proveWithContainer(inputs: unknown): Promise<{ proof: any; publicSignals: string[] }> {
  const t0 = Date.now();
  const resp = await fetch(`${process.env.PROVER_URL}/prove`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(inputs),
  });
  if (!resp.ok) throw new Error(`prover failed: ${resp.status} ${await resp.text()}`);
  const r = await resp.json();
  console.log(`[prove-for] prover container latency: ${r.ms}ms (http roundtrip ${Date.now() - t0}ms)`);
  return r;
}

function proveLocal(): { proof: any; publicSignals: string[] } {
  execFileSync("node", ["build/claim_js/generate_witness.js", "build/claim_js/claim.wasm",
    "build/pf-input.json", "build/pf-witness.wtns"], { stdio: "inherit" });
  execFileSync("npx", ["snarkjs", "groth16", "prove", "build/claim_final.zkey",
    "build/pf-witness.wtns", "build/pf-proof.json", "build/pf-public.json"], { stdio: "inherit" });
  return {
    proof: JSON.parse(fs.readFileSync("build/pf-proof.json", "utf8")),
    publicSignals: JSON.parse(fs.readFileSync("build/pf-public.json", "utf8")),
  };
}

async function main() {
  const [emlPath, relayerB58, out] = process.argv.slice(2);
  if (!emlPath || !relayerB58 || !out) {
    throw new Error("usage: prove-for.ts <emlPath> <relayerPubkeyBase58> <outJson>");
  }
  const relayerField = relayerToField(new PublicKey(relayerB58).toBytes());
  const r = await loadClaimEmail(emlPath, relayerField);
  fs.writeFileSync("build/pf-input.json", JSON.stringify(r.inputs));

  const { proof, publicSignals } = process.env.PROVER_URL
    ? await proveWithContainer(r.inputs)
    : proveLocal();

  const sol = convertProofForSolana(proof, publicSignals);
  fs.writeFileSync(out, JSON.stringify({ ...sol, selector: r.meta.selector, meta: r.meta }, null, 2));
  console.log("proof written to", out);
}
main();
