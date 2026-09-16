# Test fixtures

- `proof.json` — Task 11 expects `../circuits/build/solana-proof.json` copied here (real
  claim-circuit proof converted by `circuits/scripts/convert-proof.ts`).
- **Status (Task 7): NOT generated.** `circuits/testdata/emails/claim.eml` is a 585-byte
  unsigned stub with no DKIM-Signature header, so no valid witness/proof can be produced
  (the claim circuit verifies DKIM in-circuit). Generate after exporting a real,
  in-window (48h) DKIM-signed email per `circuits/testdata/emails/README.md`:

  ```bash
  # from repo root, with a real claim.eml in place
  npx tsx -e "import('./circuits/scripts/load-email.ts').then(async (m) => {
    const r = await m.loadClaimEmail('circuits/testdata/emails/claim.eml', 123n);
    require('fs').writeFileSync('circuits/build/claim-input.json', JSON.stringify(r.inputs));
    require('fs').writeFileSync('circuits/build/claim-meta.json', JSON.stringify(r.meta));
  })"
  cd circuits && node build/claim_js/generate_witness.js build/claim_js/claim.wasm \
    build/claim-input.json build/claim-witness.wtns
  NODE_OPTIONS=--max-old-space-size=16384 npx snarkjs groth16 prove build/claim_final.zkey \
    build/claim-witness.wtns build/proof.json build/public.json
  npx snarkjs groth16 verify build/verification_key.json build/public.json build/proof.json
  # then convert to solana-proof.json via circuits/scripts/convert-proof.ts and copy here
  ```
