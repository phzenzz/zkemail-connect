// circuits/scripts/convert-proof.ts
const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n; // BN254 Fq

function be32(dec: string | bigint): number[] {
  let v = BigInt(dec);
  const out = new Array<number>(32);
  for (let i = 31; i >= 0; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

export interface SolanaProof {
  proofA: number[];        // [64]  pi_a NEGATED
  proofB: number[];        // [128] c1,c0 per coordinate
  proofC: number[];        // [64]
  publicInputs: number[][]; // [9][32] big-endian, order = main public list
}

export function convertProofForSolana(proof: any, publicSignals: string[]): SolanaProof {
  if (publicSignals.length !== 9) throw new Error("expected 9 public signals");
  const negY = (Q - BigInt(proof.pi_a[1])) % Q;
  return {
    proofA: [...be32(proof.pi_a[0]), ...be32(negY)],
    proofB: [
      ...be32(proof.pi_b[0][1]), ...be32(proof.pi_b[0][0]),
      ...be32(proof.pi_b[1][1]), ...be32(proof.pi_b[1][0]),
    ],
    proofC: [...be32(proof.pi_c[0]), ...be32(proof.pi_c[1])],
    publicInputs: publicSignals.map(be32),
  };
}
