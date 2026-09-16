pragma circom 2.1.6;

include "circomlib/circuits/comparators.circom";

// N lowercase hex chars ([0-9a-f], no padding) -> one field element (big-endian semantics).
template HexToField(N) {
    signal input in[N];
    signal output out;

    component isNumLo[N]; component isNumHi[N];
    component isAlphaLo[N]; component isAlphaHi[N];
    signal isNum[N]; signal isAlpha[N]; signal nib[N];
    signal sums[N + 1];
    sums[0] <== 0;
    for (var i = 0; i < N; i++) {
        isNumLo[i] = LessEqThan(8); isNumLo[i].in[0] <== 48; isNumLo[i].in[1] <== in[i];
        isNumHi[i] = LessEqThan(8); isNumHi[i].in[0] <== in[i]; isNumHi[i].in[1] <== 57;
        isNum[i] <== isNumLo[i].out * isNumHi[i].out;

        isAlphaLo[i] = LessEqThan(8); isAlphaLo[i].in[0] <== 97; isAlphaLo[i].in[1] <== in[i];
        isAlphaHi[i] = LessEqThan(8); isAlphaHi[i].in[0] <== in[i]; isAlphaHi[i].in[1] <== 102;
        isAlpha[i] <== isAlphaLo[i].out * isAlphaHi[i].out;

        isNum[i] + isAlpha[i] === 1; // exactly one class
        // nib = in - 48 for digits, in - 87 for alpha; written linearly to stay quadratic
        nib[i] <== in[i] - 48 - 39 * isAlpha[i];
        sums[i + 1] <== sums[i] * 16 + nib[i];
    }
    out <== sums[N];
}
