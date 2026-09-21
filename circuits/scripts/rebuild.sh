#!/usr/bin/env bash
#
# Full trusted-setup rebuild after changing the circuit (circuits/src/claim.circom
# or a checked-in regex spec). to_addr_regex.circom is a STATIC spec — the relay
# address is NOT compiled into any DFA anymore — so step 1 only verifies the
# artifact exists. The ptau is reused, ~10 min total; constraint count must stay
# < 2^22:
#
#   1. test -f src/regexes/to_addr_regex.circom
#        existence check for the static to_addr spec (to_addr.json /
#        to_addr_regex.circom are checked in; gen-regexes.ts is retired and
#        prints a one-line notice when invoked directly)
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
#      (check: vk_delta_2 != vk_gamma_2, IC = 10 / nr_pubinputs = 9)
#   7. node scripts/gen-vk-rust.mjs → build/verifying_key.rs
#   8. cp build/verifying_key.rs ../onchain/programs/email-wallet/src/verifying_key.rs
#
# DEV-ONLY trusted setup: pot22_final.ptau is the Hermez Powers-of-Tau ceremony ptau
# (power 22 of the 2^28 ceremony, Wayback snapshot — see setup.sh); the zkey built
# here gets a single local dev contribution (step 4). Needs a real multi-party
# contribution ceremony before any testnet/mainnet deployment.
#
# Usage: bash circuits/scripts/rebuild.sh   (from anywhere; cds to circuits/)
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_OPTIONS="--max-old-space-size=16384"

echo "[rebuild] 1/6 check to_addr static regex spec exists"
test -f src/regexes/to_addr_regex.circom || { echo "[rebuild] ERROR: missing src/regexes/to_addr_regex.circom (static spec, checked in)" >&2; exit 1; }

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
