#!/usr/bin/env bash
#
# DEV-ONLY trusted setup. Produces build/pot22_final.ptau (Hermez ceremony ptau),
# build/claim_final.zkey (single local dev contribution) and build/verification_key.json.
# Needs a real multi-party contribution ceremony before any testnet/mainnet deployment.
#
# ptau provenance: build/pot22_final.ptau is powersOfTau28_hez_final_22.ptau from the
# Hermez Powers-of-Tau ceremony (phase 1, 108 contributors; header: power 22,
# ceremonyPower 28). The original GCS bucket URL is dead (403), so the download uses
# the Wayback Machine snapshot (~4.8GB, slow — hours at Wayback speeds). Skipped if
# the file already exists.
#
# Pipeline (snarkjs, bn128):
#   1. download pot22_final.ptau if missing (Wayback snapshot of the Hermez file);
#      downloaded to a .tmp path and activated only after its byte size matches
#      the known ceremony file (4,831,921,304) — a truncated download is never
#      mistaken for a cached ptau
#   2. groth16 setup build/claim.r1cs pot22_final.ptau → claim_0000.zkey
#   3. zkey contribute (single dev entropy) → claim_final.zkey; afterwards
#      delta != gamma (a zero-contribution zkey has delta == gamma, trivially forgeable)
#   4. zkey verify → must print "ZKey Ok!" (tee'd to build/zkey-verify.log)
#   5. export verificationkey → build/verification_key.json for gen-vk-rust.mjs
#      (check: vk_delta_2 != vk_gamma_2, IC = 8 / nr_pubinputs = 7)
#
# npm deps are hoisted to the repo-root node_modules (no circuits/node_modules), so
# run this script from circuits/ (the cd above) and let npx resolve snarkjs upward.
# groth16 setup on ~2.7M constraints is memory-hungry (see compile.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
export NODE_OPTIONS="--max-old-space-size=16384"

PTAU=build/pot22_final.ptau
# Known size of powersOfTau28_hez_final_22.ptau (verified: stat -f %z on the ceremony file).
EXPECTED_SIZE=4831921304

file_size() { stat -f %z "$1" 2>/dev/null || stat -c %s "$1"; }

if [ -f "$PTAU" ]; then
  CACHED_SIZE=$(file_size "$PTAU")
  if [ "$CACHED_SIZE" != "$EXPECTED_SIZE" ]; then
    echo "[setup] ERROR: existing $PTAU is $CACHED_SIZE bytes, expected $EXPECTED_SIZE (corrupt/truncated)." >&2
    echo "[setup] delete it and rerun to re-download." >&2
    exit 1
  fi
else
  echo "[setup] downloading Hermez ceremony ptau (~4.8GB via Wayback, slow)"
  if ! curl -fL --retry 3 -o "$PTAU.tmp" \
    https://web.archive.org/web/20250726170323/https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_22.ptau; then
    echo "[setup] ERROR: download failed. Delete $PTAU.tmp and retry." >&2
    exit 1
  fi
  DOWNLOADED_SIZE=$(file_size "$PTAU.tmp")
  if [ "$DOWNLOADED_SIZE" != "$EXPECTED_SIZE" ]; then
    echo "[setup] ERROR: downloaded ptau is $DOWNLOADED_SIZE bytes, expected $EXPECTED_SIZE (truncated/corrupt)." >&2
    echo "[setup] Delete $PTAU.tmp and retry." >&2
    exit 1
  fi
  mv "$PTAU.tmp" "$PTAU"
fi

npx snarkjs groth16 setup build/claim.r1cs "$PTAU" build/claim_0000.zkey
npx snarkjs zkey contribute build/claim_0000.zkey build/claim_final.zkey \
  --name="zkemail-solana-dev" -e="$(openssl rand 32 | xxd -p -c 64)"
rm -f build/claim_0000.zkey
npx snarkjs zkey verify build/claim.r1cs "$PTAU" build/claim_final.zkey | tee build/zkey-verify.log
npx snarkjs zkey export verificationkey build/claim_final.zkey build/verification_key.json
echo "setup done: $PTAU + build/claim_final.zkey + build/verification_key.json"
