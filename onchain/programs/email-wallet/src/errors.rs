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
    #[msg("escrow id mismatch")]
    EscrowIdMismatch,
    #[msg("timestamp outside allowed window")]
    TimestampOutOfWindow,
    #[msg("nullifier already used")]
    NullifierUsed,
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
    #[msg("inbox sweep requires nonzero escrow id uniqueness")]
    InboxNullifierConflict,
    #[msg("amount must be positive")]
    InvalidAmount,
}
