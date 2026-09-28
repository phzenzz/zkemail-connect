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

pub const BATCH_CIPHER_MAX: usize = 64_000;
pub const BATCH_MAX_LEAVES: u32 = 65_536; // 2^16，受 claim calldata 深度上限约束
pub const MAX_MERKLE_DEPTH: u16 = 16;
pub const MIN_EXPIRY_SECS: i64 = 3_600;

/// 批量空投批次。v1 等额：amount_per_recipient × leaf_count = total_amount。
/// 字节布局：8(disc) + 32×4 + 8×2 + 4×3 + 8 + 1 + 1 = 174 固定前缀，
/// 之后 claimed vec(4+B) 与 recipients_cipher vec(4+C)——vec 数据区在 init 时
/// 按 cipher_len_expected 全额预留，append 只做内存 extend，Anchor 序列化原样写回，
/// 无需 realloc。
#[account]
pub struct Batch {
    pub sender: Pubkey,              // 32  创建者/退款接收人
    pub mint: Pubkey,                // 32
    pub merkle_root: [u8; 32],       // 32  邮箱承诺树的根
    pub relayer_email_hash: [u8; 32],// 32  与单发同语义：通知/代领 relayer 绑定
    pub amount_per_recipient: u64,   // 8
    pub total_amount: u64,           // 8   = amount_per_recipient × leaf_count
    pub leaf_count: u32,             // 4   真实叶子数
    pub claimed_count: u32,          // 4
    pub cipher_len_expected: u32,    // 4   seal 时要求 cipher 长度等于它
    pub expire_at: i64,              // 8
    pub sealed: bool,                // 1   @ 字节偏移 172（indexer 回填过滤用）
    pub bump: u8,                    // 1
    pub claimed: Vec<u8>,            // 4 + ceil(leaf_count/8)  领取位图
    pub recipients_cipher: Vec<u8>,  // 4 + ≤ BATCH_CIPHER_MAX
}

impl Batch {
    pub fn space(cipher_len_expected: usize, leaf_count: u32) -> usize {
        8 + 32 * 4 + 8 * 2 + 4 * 3 + 8 + 1 + 1
            + 4 + (leaf_count as usize + 7) / 8
            + 4 + cipher_len_expected
    }
}
