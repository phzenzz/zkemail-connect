pragma circom 2.1.6;

include "circomlib/circuits/comparators.circom";

// ASCII decimal digits followed by zero padding -> integer.
// First char must be a digit; once a zero byte appears, the rest must be zero.
template Digit2IntStrict(N) {
    signal input in[N];
    signal output out;

    component geLo[N]; component leHi[N]; component isZero[N];
    signal isDigit[N]; signal seenZero[N + 1];
    signal digit[N]; signal sums[N + 1];
    sums[0] <== 0; seenZero[0] <== 0;
    for (var i = 0; i < N; i++) {
        isZero[i] = IsZero();
        isZero[i].in <== in[i];
        geLo[i] = LessEqThan(8); geLo[i].in[0] <== 48; geLo[i].in[1] <== in[i];
        leHi[i] = LessEqThan(8); leHi[i].in[0] <== in[i]; leHi[i].in[1] <== 57;
        isDigit[i] <== geLo[i].out * leHi[i].out;
        // valid iff digit or zero-padding
        isDigit[i] + isZero[i].out === 1;
        // padding must be contiguous: if seenZero, current must be zero
        seenZero[i] * (1 - isZero[i].out) === 0;
        seenZero[i + 1] <== seenZero[i] + isZero[i].out - seenZero[i] * isZero[i].out;
        // digit = in - 48 for digits, 0 for zero-padding; written linearly to stay quadratic
        digit[i] <== in[i] - 48 + 48 * isZero[i].out;
        // accumulate ×10 on digit bytes only; on zero padding hold the value (isZero.out ∈ {0,1})
        sums[i + 1] <== sums[i] * 10 - sums[i] * 9 * isZero[i].out + digit[i];
    }
    // first byte must be a digit (isDigit[0] == 1)
    (1 - isDigit[0]) === 0;
    out <== sums[N];
}
