use anchor_lang::prelude::*;

#[derive(Clone, Copy, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
#[repr(u8)]
pub enum RegistryStatus {
    Active = 0,
    Revoked = 1,
}

pub const MAX_EMAIL_LEN: usize = 64;
pub const MAX_CIPHER_LEN: usize = 137; // 1 + 32 + 24 header + 64 plaintext + 16 Poly1305 MAC

/// v1: 仅不可退款托管。账户存在即 Open；claim 成功即关闭（租金退 sender）。
/// v2 若恢复可退款模式：重新引入 mode/expiry/status 字段（见 PRD §4.4 备注）。
#[account]
pub struct Escrow {
    pub commitment: [u8; 32],
    pub sender: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub relayer_email_hash: [u8; 32],
    pub email_cipher: Vec<u8>,
    pub bump: u8,
}
impl Escrow {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 32 + 4 + MAX_CIPHER_LEN + 1;
}

#[account]
pub struct RelayerEntry {
    pub email: String,
    pub email_hash: [u8; 32],
    pub x25519_key: [u8; 32],
    pub claim_address: Pubkey,
    pub fee: u64,
    pub active: bool,
    pub bump: u8,
}
impl RelayerEntry {
    pub const SIZE: usize = 8 + 4 + MAX_EMAIL_LEN + 32 + 32 + 32 + 8 + 1 + 1;
}

#[account]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub fee_lamports: u64,
    pub timestamp_window_past: i64,
    pub bump: u8,
}
impl ProtocolConfig {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 1;
}

#[account]
pub struct DkimRegistry {
    pub pubkey_hash: [u8; 32],
    pub status: RegistryStatus,
    pub expires_at: i64,
    pub bump: u8,
}
impl DkimRegistry {
    pub const SIZE: usize = 8 + 32 + 1 + 8 + 1;
}

#[account]
pub struct RegistryConfig {
    pub authority: Pubkey,
    pub bump: u8,
}
impl RegistryConfig {
    pub const SIZE: usize = 8 + 32 + 1;
}
