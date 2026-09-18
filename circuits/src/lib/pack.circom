pragma circom 2.1.6;

include "circomlib/circuits/comparators.circom";

// Pack N bytes into one field element, little-endian: out = sum in[j] * 256^j. N <= 31.
template PackBytesLE(N) {
    signal input in[N];
    signal output out;
    signal sums[N + 1];
    sums[0] <== 0;
    for (var j = 0; j < N; j++) {
        sums[j + 1] <== sums[j] + (1 << (8 * j)) * in[j];
    }
    out <== sums[N];
}

// Pack N bytes into CHUNKS field elements (31 bytes each, LE). N must equal CHUNKS*31.
template PackBytes31xN(N, CHUNKS) {
    signal input in[N];
    signal output out[CHUNKS];
    component packers[CHUNKS];
    for (var c = 0; c < CHUNKS; c++) {
        packers[c] = PackBytesLE(31);
        for (var j = 0; j < 31; j++) packers[c].in[j] <== in[c * 31 + j];
        out[c] <== packers[c].out;
    }
}

// Assert no byte is uppercase ASCII A-Z (65..90). Zero bytes (padding) are allowed.
template AssertNotUppercase(N) {
    signal input in[N];
    component geLo[N];
    component leHi[N];
    for (var i = 0; i < N; i++) {
        geLo[i] = LessEqThan(8);
        geLo[i].in[0] <== 65; geLo[i].in[1] <== in[i];   // 65 <= b
        leHi[i] = LessEqThan(8);
        leHi[i].in[0] <== in[i]; leHi[i].in[1] <== 90;   // b <= 90
        geLo[i].out * leHi[i].out === 0;                 // not (both)
    }
}
