#!/usr/bin/env bash
# Compiles src/claim.circom → build/claim.{r1cs,wasm,sym} and prints r1cs info.
#
# NOTE (v1.6): to_addr_regex.circom is a static artifact (regex-specs/to_addr.json,
# checked in) — the relay address is NOT compiled into any DFA anymore. This script
# alone suffices for witness/unit tests; proof-key changes require the full
# `bash circuits/scripts/rebuild.sh` chain (to_addr spec existence check → compile →
# groth16 setup → contribute → zkey verify → export vk → gen-vk-rust → copy
# verifying_key.rs), documented step-by-step in rebuild.sh's header.
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
