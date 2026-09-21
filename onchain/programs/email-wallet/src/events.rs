use anchor_lang::prelude::*;

#[event]
pub struct EscrowCreated {
    pub escrow: Pubkey,
    pub sender: Pubkey,
    pub commitment: [u8; 32],
    pub amount: u64,
    pub relayer_email_hash: [u8; 32],
}

#[event]
pub struct RelayerRegistered {
    pub email_hash: [u8; 32],
    pub email: String,
    pub claim_address: Pubkey,
}

#[event]
pub struct RelayerUpdated {
    pub email_hash: [u8; 32],
    pub active: bool,
}
