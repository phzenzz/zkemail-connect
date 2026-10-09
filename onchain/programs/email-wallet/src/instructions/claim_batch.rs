use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use solana_program::hash::hash;

use crate::errors::ErrorCode;
use crate::events::BatchClaimed;
use crate::instructions::claim::{verify_claim_common, ClaimArgs};
use crate::state::{Batch, DkimRegistry, ProtocolConfig};
use crate::zk;

const LEAF_DOMAIN_SEP: &[u8] = b"zkemail:batch:v1:leaf";

fn leaf_hash(commitment: &[u8; 32]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(LEAF_DOMAIN_SEP.len() + 32);
    buf.extend_from_slice(LEAF_DOMAIN_SEP);
    buf.extend_from_slice(commitment);
    hash(&buf).to_bytes()
}

/// 链上 Merkle 路径校验，与 circuits/scripts/merkle.ts 逐字节同构。
/// indices[i] = 第 i 层走右子 = 1；比特序列即叶子索引。返回 leaf_index。
pub(crate) fn verify_batch_path(
    root: &[u8; 32],
    commitment: &[u8; 32],
    siblings: &[[u8; 32]],
    indices: &[u8],
) -> Result<u32> {
    require!(siblings.len() == indices.len(), ErrorCode::BatchInvalidProof);
    require!(siblings.len() <= crate::state::MAX_MERKLE_DEPTH as usize, ErrorCode::BatchTreeTooDeep);
    let mut cur = leaf_hash(commitment);
    let mut index: u32 = 0;
    for (i, sib) in siblings.iter().enumerate() {
        let (left, right) = if indices[i] % 2 == 0 { (cur, *sib) } else { (*sib, cur) };
        index |= ((indices[i] & 1) as u32) << i;
        let mut buf = [0u8; 64];
        buf[..32].copy_from_slice(&left);
        buf[32..].copy_from_slice(&right);
        cur = hash(&buf).to_bytes();
    }
    require!(&cur == root, ErrorCode::BatchInvalidProof);
    Ok(index)
}

#[derive(Accounts)]
pub struct ClaimBatch<'info> {
    #[account(mut, seeds = [b"batch", batch.sender.as_ref(), batch.merkle_root.as_ref()], bump = batch.bump)]
    pub batch: Account<'info, Batch>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = batch)]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    /// CHECK: PDA 由 handler 按 pi 重新推导并校验（动机见 claim.rs：压 try_accounts 栈帧）
    #[account()]
    pub registry: Account<'info, DkimRegistry>,

    /// CHECK: dest owner, decoded from the proof and compared in the handler
    pub dest_owner: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = dest_owner,
    )]
    pub dest_ata: Account<'info, TokenAccount>,

    /// Relayer: pays the tx (and dest ATA rent); the proof binds this key.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: 零数据标记账户；PDA 校验 + handler 手动创建（同 claim.rs）
    #[account(mut)]
    pub nullifier: UncheckedAccount<'info>,

    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn claim_batch(
    ctx: Context<ClaimBatch>,
    args: ClaimArgs,
    merkle_siblings: Vec<[u8; 32]>,
    merkle_indices: Vec<u8>,
) -> Result<()> {
    let batch = &mut ctx.accounts.batch;
    let now = Clock::get()?.unix_timestamp;

    // 便宜检查优先（失败省 Groth16 的 ~110k CU；也让错误路径无需真证明即可测试）
    require!(batch.sealed, ErrorCode::BatchNotSealed);
    require!(now <= batch.expire_at, ErrorCode::BatchExpired);

    let pi = zk::parse_public_inputs(&args.public_inputs)?;
    require!(pi.relayer_email_hash == batch.relayer_email_hash, ErrorCode::RelayerEmailHashMismatch);

    // 手动校验 registry / nullifier PDA（同 claim.rs：压 try_accounts 栈帧）
    let (registry_pda, _) = Pubkey::find_program_address(
        &[b"dkim", pi.domain_commitment.as_ref(), args.selector.as_bytes()],
        &crate::ID,
    );
    require!(ctx.accounts.registry.key() == registry_pda, ErrorCode::Unauthorized);
    let (nullifier_pda, nullifier_bump) =
        Pubkey::find_program_address(&[b"nullifier", pi.email_nullifier.as_ref()], &crate::ID);
    require!(ctx.accounts.nullifier.key() == nullifier_pda, ErrorCode::Unauthorized);
    require!(
        ctx.accounts.nullifier.data_is_empty(),
        ErrorCode::NullifierAlreadyUsed
    );
    let nullifier_seeds: &[&[u8]] = &[
        b"nullifier",
        pi.email_nullifier.as_ref(),
        &[nullifier_bump],
    ];
    system_program::create_account(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            CreateAccount {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.nullifier.to_account_info(),
            },
            &[nullifier_seeds],
        ),
        Rent::get()?.minimum_balance(8),
        8,
        &crate::ID,
    )?;

    // Merkle 成员资格 + 叶子级 exactly-once（位图）
    let leaf_index = verify_batch_path(
        &batch.merkle_root,
        &pi.commitment,
        &merkle_siblings,
        &merkle_indices,
    )?;
    require!(leaf_index < batch.leaf_count, ErrorCode::BatchLeafOutOfRange);
    let byte = &mut batch.claimed[(leaf_index / 8) as usize];
    let mask = 1u8 << (leaf_index % 8);
    require!(*byte & mask == 0, ErrorCode::BatchLeafAlreadyClaimed);
    *byte |= mask;
    batch.claimed_count += 1;

    // 电路校验（registry / 时间窗 / relayer 绑定 / dest 绑定 / Groth16）
    verify_claim_common(
        &args,
        &pi,
        &ctx.accounts.registry,
        &ctx.accounts.protocol_config,
        &ctx.accounts.payer.key(),
        &ctx.accounts.dest_owner.key(),
    )?;

    // 打款该叶份额；批次与 vault 保持开放，直到领完或过期由 sender 关闭退款
    let seeds: &[&[u8]] = &[
        b"batch",
        batch.sender.as_ref(),
        batch.merkle_root.as_ref(),
        &[batch.bump],
    ];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.dest_ata.to_account_info(),
                authority: batch.to_account_info(),
            },
            &[seeds],
        ),
        batch.amount_per_recipient,
    )?;

    emit!(BatchClaimed {
        batch: batch.key(),
        leaf_index,
        dest: ctx.accounts.dest_owner.key(),
        amount: batch.amount_per_recipient,
    });
    Ok(())
}
