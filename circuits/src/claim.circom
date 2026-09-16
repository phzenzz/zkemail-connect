pragma circom 2.1.6;

include "@zk-email/circuits/email-verifier.circom";
include "@zk-email/circuits/utils/regex.circom";
include "@zk-email/zk-regex-circom/circuits/common/from_addr_regex.circom";
include "@zk-email/zk-regex-circom/circuits/common/email_domain_regex.circom";
include "@zk-email/zk-regex-circom/circuits/common/timestamp_regex.circom";
include "circomlib/circuits/poseidon.circom";
include "./lib/pack.circom";
include "./lib/hex.circom";
include "./lib/digits.circom";
include "./regexes/claim_to_regex.circom";
include "./regexes/subject_addr_regex.circom";

// Claim circuit: proves "a DKIM-valid email exists whose From hashes to commitment,
// whose To carries escrowId, whose Subject is exactly a base58 address (dest)",
// revealing dest + relayer + timestamp, hiding the email address.
//
// Public signals (order fixed, on-chain program depends on it):
//   [pubkeyHash, commitment, escrowId, timestamp, nullifier, relayer, destA, destB, domainCommitment]
//
// SECURITY NOTE: `timestamp` comes from the DKIM-Signature header's `t=` tag. That tag
// sits inside the hashed header bytes (the DKIM-Signature header is hashed with b=
// emptied), but the `t=` value itself is not bound by any other field, so a malicious
// prover can forge the timestamp to pass a freshness window. Real replay protection
// relies on: escrow_id being unique per escrow (old emails don't contain a new id) +
// the Escrow state machine being one-shot + the Inbox nullifier PDA. Production
// hardening: mix `t=` into the nullifier or switch to an RFC5322 `Date:` parsing
// circuit (high cost, deferred).
template ClaimCircuit(maxHeadersLength, n, k) {
    var MAX_EMAIL_LEN = 341;   // 11 chunks of 31 bytes
    var EMAIL_CHUNKS = 11;
    var MAX_DOMAIN_LEN = 124;  // 4 chunks
    var DOMAIN_CHUNKS = 4;
    var MAX_DEST_LEN = 44;
    var MAX_TS_DIGITS = 12;

    // ---- private inputs
    signal input emailHeader[maxHeadersLength];
    signal input emailHeaderLength;
    signal input pubkey[k];
    signal input signature[k];
    signal input fromAddrIdx;
    signal input escrowIdIdx;
    signal input subjectAddrIdx;
    signal input timestampIdx;

    // ---- public signals (constrained equal to computed values below)
    signal input pubkeyHash;
    signal input commitment;
    signal input escrowId;
    signal input timestamp;
    signal input nullifier;
    signal input relayer;
    signal input destA;
    signal input destB;
    signal input domainCommitment;

    // C1-C3: DKIM RSA-2048 verify over canonicalized signed headers, body hash ignored.
    component ev = EmailVerifier(maxHeadersLength, 0, n, k, 1, 0, 0, 0);
    ev.emailHeader <== emailHeader;
    ev.emailHeaderLength <== emailHeaderLength;
    ev.pubkey <== pubkey;
    ev.signature <== signature;
    ev.pubkeyHash === pubkeyHash;

    // C5: From address -> lowercase -> Poseidon == commitment
    signal fromOut; signal fromReveal[maxHeadersLength];
    (fromOut, fromReveal) <== FromAddrRegex(maxHeadersLength)(emailHeader);
    fromOut === 1;
    signal fromAddr[MAX_EMAIL_LEN] <== SelectRegexReveal(maxHeadersLength, MAX_EMAIL_LEN)(fromReveal, fromAddrIdx);
    AssertNotUppercase(MAX_EMAIL_LEN)(fromAddr);
    signal emailChunks[EMAIL_CHUNKS] <== PackBytes31xN(MAX_EMAIL_LEN, EMAIL_CHUNKS)(fromAddr);
    signal commitmentComputed <== Poseidon(EMAIL_CHUNKS)(emailChunks);
    commitment === commitmentComputed;

    // C6: To carries claim+<32 lower hex>@relay.xyz -> escrowId
    signal toOut; signal toReveal[maxHeadersLength];
    (toOut, toReveal) <== ClaimToRegex(maxHeadersLength)(emailHeader);
    toOut === 1;
    signal escrowHex[32] <== SelectRegexReveal(maxHeadersLength, 32)(toReveal, escrowIdIdx);
    signal escrowIdComputed <== HexToField(32)(escrowHex);
    escrowId === escrowIdComputed;

    // C7 (structural): from-domain -> Poseidon == domainCommitment.
    // On-chain, the DKIM registry PDA is derived from domainCommitment and must hold
    // pubkeyHash as Active, i.e. the proving key belongs to the From domain.
    signal fdOut; signal fdReveal[MAX_EMAIL_LEN];
    (fdOut, fdReveal) <== EmailDomainRegex(MAX_EMAIL_LEN)(fromAddr);
    fdOut === 1;
    // EmailDomainRegex reveals the domain at its position inside fromAddr (after '@').
    // Repack the reveal window into a zero-left-padded 124-byte array: find first non-zero.
    // Simpler: domain sits contiguously; we shift it out via SelectRegexReveal on the
    // domain regex reveal, using fromAddrIdx + (index of '@') + 1 computed off-chain.
    signal input domainIdx;   // index of first domain byte within fromAddr window
    signal domainBytes[MAX_DOMAIN_LEN] <== SelectRegexReveal(MAX_EMAIL_LEN, MAX_DOMAIN_LEN)(fdReveal, domainIdx);
    signal domainChunks[DOMAIN_CHUNKS] <== PackBytes31xN(MAX_DOMAIN_LEN, DOMAIN_CHUNKS)(domainBytes);
    signal domainCommitmentComputed <== Poseidon(DOMAIN_CHUNKS)(domainChunks);
    domainCommitment === domainCommitmentComputed;

    // C8: DKIM t= -> timestamp (see security note above)
    signal tsOut; signal tsReveal[maxHeadersLength];
    (tsOut, tsReveal) <== TimestampRegex(maxHeadersLength)(emailHeader);
    tsOut === 1;
    signal tsDigits[MAX_TS_DIGITS] <== SelectRegexReveal(maxHeadersLength, MAX_TS_DIGITS)(tsReveal, timestampIdx);
    signal timestampComputed <== Digit2IntStrict(MAX_TS_DIGITS)(tsDigits);
    timestamp === timestampComputed;

    // C9: nullifier = Poseidon(emailChunks, escrowId)
    component nul = Poseidon(EMAIL_CHUNKS + 1);
    for (var i = 0; i < EMAIL_CHUNKS; i++) nul.inputs[i] <== emailChunks[i];
    nul.inputs[EMAIL_CHUNKS] <== escrowId;
    nullifier === nul.out;

    // C11: Subject strictly one base58 address -> destA/destB (31-byte LE chunks)
    signal sOut; signal sReveal[maxHeadersLength];
    (sOut, sReveal) <== SubjectAddrRegex(maxHeadersLength)(emailHeader);
    sOut === 1;
    signal destBytes[MAX_DEST_LEN] <== SelectRegexReveal(maxHeadersLength, MAX_DEST_LEN)(sReveal, subjectAddrIdx);
    component packA = PackBytesLE(31);
    for (var i = 0; i < 31; i++) packA.in[i] <== destBytes[i];
    destA === packA.out;
    component packB = PackBytesLE(13);
    for (var i = 0; i < 13; i++) packB.in[i] <== destBytes[31 + i];
    destB === packB.out;

    // relayer: pass-through public signal, bound into the proof; checked on-chain
    // against the fee payer (pubkey mod Fr). No constraint needed here.
    signal relayerBound <== relayer;
}

// maxHeadersLength = 1024 (fallback from 2048: at 2048 the circuit is ~10.7M constraints,
// over the ptau22 budget of 2^22 = 4,194,304; canonicalized headers of real replies are ~1KB).
component main {public [pubkeyHash, commitment, escrowId, timestamp, nullifier, relayer, destA, destB, domainCommitment]} = ClaimCircuit(1024, 121, 17);
