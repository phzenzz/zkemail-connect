#!/usr/bin/env bash
#
# Full circuit rebuild after changing the relay address (circuits/relay.config.json
# or RELAY_ADDRESS). The relay address is compiled into the ToPresenceRegex DFA, so
# ANY change requires the whole chain below — this script runs it end to end
# (ptau is reused, ~10 min total; constraint count must stay < 2^22):
#
#   1. npx tsx scripts/gen-regexes.ts
#        render circuits/regex-specs/to_presence.json from the configured address
#        (`(\r\n|^)to:<escaped-addr>(\r\n)`, match-only) and regenerate
#        circuits/src/regexes/to_presence_regex.circom via `zk-regex decomposed`
#        (appends the template's closing `}` — installed zk-regex 2.3.2 no-reveal quirk)
#   2. bash scripts/compile.sh
#        circom --O2 → build/claim.{r1cs,wasm,sym}; prints the constraint count
#   3. npx snarkjs groth16 setup build/claim.r1cs build/pot22_final.ptau build/claim_final.zkey
#   4. npx snarkjs zkey contribute build/claim_final.zkey build/claim_final_c.zkey \
#        --name="zkemail-solana-dev" -e="$(openssl rand 32 | xxd -p -c 64)"
#      mv build/claim_final_c.zkey build/claim_final.zkey
#      (zero-contribution zkeys have delta == gamma and are trivially forgeable)
#   5. npx snarkjs zkey verify build/claim.r1cs build/pot22_final.ptau build/claim_final.zkey
#      → must print "ZKey Ok!" (tee'd to build/zkey-verify.log)
#   6. npx snarkjs zkey export verificationkey build/claim_final.zkey build/verification_key.json
#      (check: vk_delta_2 != vk_gamma_2, IC = 8 / nr_pubinputs = 7)
#   7. node scripts/gen-vk-rust.mjs → build/verifying_key.rs
#   8. cp build/verifying_key.rs ../onchain/programs/email-wallet/src/verifying_key.rs
#
# DEV-ONLY trusted setup: pot22_final.ptau is the local dev ptau (see setup.sh);
# replace with a ceremony-verified ptau + multi-party contributions before any
# testnet/mainnet deployment.
#
# Usage: bash circuits/scripts/rebuild.sh   (from anywhere; cds to circuits/)
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_OPTIONS="--max-old-space-size=16384"

echo "[rebuild] 1/6 regenerate To-presence regex from configured relay address"
npx tsx scripts/gen-regexes.ts

echo "[rebuild] 2/6 compile circuit"
bash scripts/compile.sh

echo "[rebuild] 3/6 groth16 setup (reusing build/pot22_final.ptau)"
npx snarkjs groth16 setup build/claim.r1cs build/pot22_final.ptau build/claim_final.zkey

echo "[rebuild] 4/6 contribute dev entropy"
npx snarkjs zkey contribute build/claim_final.zkey build/claim_final_c.zkey \
  --name="zkemail-solana-dev" -e="$(openssl rand 32 | xxd -p -c 64)"
mv build/claim_final_c.zkey build/claim_final.zkey

echo "[rebuild] 5/6 verify zkey + export verification key"
npx snarkjs zkey verify build/claim.r1cs build/pot22_final.ptau build/claim_final.zkey | tee build/zkey-verify.log
npx snarkjs zkey export verificationkey build/claim_final.zkey build/verification_key.json

echo "[rebuild] 6/6 generate on-chain verifying key"
node scripts/gen-vk-rust.mjs
cp build/verifying_key.rs ../onchain/programs/email-wallet/src/verifying_key.rs

echo "[rebuild] done: new claim_final.zkey + verification_key.json + onchain verifying_key.rs"
