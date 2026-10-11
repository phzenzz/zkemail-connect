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

#[event]
pub struct BatchCreated {
    pub batch: Pubkey,
    pub sender: Pubkey,
    pub mint: Pubkey,
    pub merkle_root: [u8; 32],
    pub relayer_email_hash: [u8; 32],
    pub amount_per_recipient: u64,
    pub total_amount: u64,
    pub leaf_count: u32,
    pub expire_at: i64,
}

#[event]
pub struct BatchSealed {
    pub batch: Pubkey,
    pub cipher_len: u32,
}

#[event]
pub struct BatchClaimed {
    pub batch: Pubkey,
    pub leaf_index: u32,
    pub dest: Pubkey,
    pub amount: u64,
}

#[event]
pub struct BatchClosed {
    pub batch: Pubkey,
    pub refunded: u64,
}
