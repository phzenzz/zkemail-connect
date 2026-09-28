use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("unauthorized registry authority")]
    Unauthorized,
    #[msg("registry entry not active")]
    RegistryNotActive,
    #[msg("registry key expired")]
    RegistryExpired,
    #[msg("pubkey hash mismatch")]
    PubkeyHashMismatch,
    #[msg("commitment mismatch")]
    CommitmentMismatch,
    #[msg("timestamp outside allowed window")]
    TimestampOutOfWindow,
    #[msg("relayer mismatch")]
    RelayerMismatch,
    #[msg("invalid dest field encoding")]
    InvalidDestField,
    #[msg("invalid base58 dest address")]
    InvalidDestAddress,
    #[msg("dest owner mismatch")]
    DestOwnerMismatch,
    #[msg("groth16 verification failed")]
    ProofVerificationFailed,
    #[msg("vault balance mismatch")]
    VaultBalanceMismatch,
    #[msg("amount must be positive")]
    InvalidAmount,
    #[msg("commitment must be < BN254 scalar field modulus")]
    InvalidCommitment,
    #[msg("email must be non-empty and at most 64 bytes")]
    InvalidEmail,
    #[msg("email cipher must be non-empty and at most 137 bytes")]
    InvalidCipherSize,
    #[msg("relayer not active")]
    RelayerNotActive,
    #[msg("email nullifier already used")]
    NullifierAlreadyUsed,
    #[msg("relayer email hash does not match escrow")]
    RelayerEmailHashMismatch,
    #[msg("batch cipher must be non-empty and at most 64000 bytes")]
    InvalidBatchCipher,
    #[msg("leaf_count must be between 1 and 65536")]
    BatchTooManyLeaves,
    #[msg("expire_at must be at least 3600s in the future")]
    BatchInvalidExpiry,
    #[msg("batch not sealed")]
    BatchNotSealed,
    #[msg("batch already sealed")]
    BatchAlreadySealed,
    #[msg("cipher exceeds cipher_len_expected")]
    BatchCipherOverflow,
    #[msg("batch expired")]
    BatchExpired,
    #[msg("batch not yet expirable")]
    BatchNotExpired,
    #[msg("merkle path does not match root")]
    BatchInvalidProof,
    #[msg("leaf index out of range")]
    BatchLeafOutOfRange,
    #[msg("leaf already claimed")]
    BatchLeafAlreadyClaimed,
    #[msg("merkle path too deep")]
    BatchTreeTooDeep,
}
