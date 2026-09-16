#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build

# DEV-ONLY setup: local ptau with no multi-party contribution — trivially forgeable.
# MUST be replaced by ceremony-verified ptau + contributions before any testnet/mainnet deployment.
#
# Pipeline (snarkjs, bn128):
#   1. powersoftau new bn128 22     — fresh 1-party phase-1 ptau (2^22; the circuit has
#                                     3,396,026 constraints > 2^21, so 2^22 is the minimum
#                                     power of two that covers it). Expect 15-60 min CPU.
#   2. powersoftau prepare phase2   — Lagrange-form sections required by groth16 setup.
#                                     This is the slow step (many EC-FFTs up to 2^23).
#   3. groth16 setup                — claim_0000 zkey equivalent, written straight to
#                                     claim_final.zkey (no zkey contribute — see header).
#   4. export verificationkey       — build/verification_key.json for gen-vk-rust.mjs.
#
# npm deps are hoisted to the repo-root node_modules (no circuits/node_modules), so
# run this script from circuits/ (the cd above) and let npx resolve snarkjs upward.
# groth16 setup on ~3.4M constraints is memory-hungry (see compile.sh).
export NODE_OPTIONS="--max-old-space-size=16384"

npx snarkjs powersoftau new bn128 22 build/pot22_0.ptau -v
npx snarkjs powersoftau prepare phase2 build/pot22_0.ptau build/pot22_final.ptau -v
npx snarkjs groth16 setup build/claim.r1cs build/pot22_final.ptau build/claim_final.zkey
npx snarkjs zkey export verificationkey build/claim_final.zkey build/verification_key.json
echo "setup done: build/pot22_final.ptau + build/claim_final.zkey + build/verification_key.json"
