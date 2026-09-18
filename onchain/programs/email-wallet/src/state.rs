use anchor_lang::prelude::*;

#[derive(Clone, Copy, PartialEq, Eq, AnchorSerialize, AnchorDeserialize)]
#[repr(u8)]
pub enum RegistryStatus {
    Active = 0,
    Revoked = 1,
}

/// v1: 仅不可退款托管。账户存在即 Open；claim 成功即关闭（租金退 sender）。
/// v2 若恢复可退款模式：重新引入 mode/expiry/status 字段（见 PRD §4.4 备注）。
#[account]
pub struct Escrow {
    pub commitment: [u8; 32],
    pub sender: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub bump: u8,
}
impl Escrow {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 1;
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
