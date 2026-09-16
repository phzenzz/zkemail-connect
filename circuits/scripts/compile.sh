#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
# npm deps are hoisted to the repo-root node_modules (no circuits/node_modules),
# so circom is invoked with -l ../node_modules.
# --O2 (full constraint reduction) is required: with --O1 the circuit has 5.5M constraints,
# over the ptau22 budget (2^22 = 4,194,304).
circom src/claim.circom -l ../node_modules --r1cs --wasm --sym --O2 -o build
# snarkjs r1cs info on this circuit needs a large heap (~5GB+); 16GB fits the 32GB dev machine.
# Lower it (e.g. 8192) on smaller machines if needed.
export NODE_OPTIONS="--max-old-space-size=16384"
npx snarkjs r1cs info build/claim.r1cs
