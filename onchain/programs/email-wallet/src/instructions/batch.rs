use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer as SystemTransfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

use crate::errors::ErrorCode;
use crate::events::{BatchClosed, BatchCreated, BatchSealed};
use crate::state::{Batch, ProtocolConfig, RelayerEntry, BATCH_CIPHER_MAX, BATCH_MAX_LEAVES, MIN_EXPIRY_SECS};

#[derive(Accounts)]
#[instruction(merkle_root: [u8; 32], amount_per_recipient: u64, leaf_count: u32, cipher_len_expected: u32, expire_at: i64, relayer_email_hash: [u8; 32], nonce: u64)]
pub struct CreateBatch<'info> {
    #[account(
        init,
        payer = sender,
        space = Batch::space(cipher_len_expected as usize, leaf_count),
        seeds = [b"batch", sender.key().as_ref(), merkle_root.as_ref(), nonce.to_le_bytes().as_ref()],
        bump,
    )]
    pub batch: Account<'info, Batch>,

    #[account(
        init,
        payer = sender,
        associated_token::mint = mint,
        associated_token::authority = batch,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = sender)]
    pub sender_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub sender: Signer<'info>,

    #[account(seeds = [b"protocol"], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,

    /// CHECK: 仅作手续费收款账户；地址已由 address = config.treasury 约束
    #[account(mut, address = config.treasury @ ErrorCode::Unauthorized)]
    pub treasury: UncheckedAccount<'info>,

    #[account(seeds = [b"relayer", relayer_email_hash.as_ref()], bump = relayer_entry.bump)]
    pub relayer_entry: Account<'info, RelayerEntry>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn create_batch(
    ctx: Context<CreateBatch>,
    merkle_root: [u8; 32],
    amount_per_recipient: u64,
    leaf_count: u32,
    cipher_len_expected: u32,
    expire_at: i64,
    relayer_email_hash: [u8; 32],
    nonce: u64,
) -> Result<()> {
    require!(amount_per_recipient > 0, ErrorCode::InvalidAmount);
    require!(leaf_count >= 1 && leaf_count <= BATCH_MAX_LEAVES, ErrorCode::BatchTooManyLeaves);
    require!(
        cipher_len_expected >= 1 && cipher_len_expected as usize <= BATCH_CIPHER_MAX,
        ErrorCode::InvalidBatchCipher
    );
    let now = Clock::get()?.unix_timestamp;
    require!(expire_at >= now + MIN_EXPIRY_SECS, ErrorCode::BatchInvalidExpiry);
    require!(ctx.accounts.relayer_entry.active, ErrorCode::RelayerNotActive);
    let total_amount = amount_per_recipient
        .checked_mul(leaf_count as u64)
        .ok_or(ErrorCode::InvalidAmount)?;
    let protocol_fee = ctx.accounts.config.fee_lamports
        .checked_mul(leaf_count as u64)
        .ok_or(ErrorCode::InvalidAmount)?;

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            SystemTransfer {
                from: ctx.accounts.sender.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
            },
        ),
        protocol_fee,
    )?;

    let batch = &mut ctx.accounts.batch;
    batch.sender = ctx.accounts.sender.key();
    batch.mint = ctx.accounts.mint.key();
    batch.merkle_root = merkle_root;
    batch.relayer_email_hash = relayer_email_hash;
    batch.amount_per_recipient = amount_per_recipient;
    batch.total_amount = total_amount;
    batch.leaf_count = leaf_count;
    batch.claimed_count = 0;
    batch.cipher_len_expected = cipher_len_expected;
    batch.expire_at = expire_at;
    batch.sealed = false;
    batch.bump = ctx.bumps.batch;
    batch.nonce = nonce;
    batch.claimed = vec![0u8; (leaf_count as usize + 7) / 8];
    batch.recipients_cipher = Vec::new();

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.sender_ata.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.sender.to_account_info(),
            },
        ),
        total_amount,
    )?;

    emit!(BatchCreated {
        batch: batch.key(),
        sender: batch.sender,
        mint: batch.mint,
        merkle_root,
        relayer_email_hash,
        amount_per_recipient,
        total_amount,
        leaf_count,
        expire_at,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AppendBatchCipher<'info> {
    #[account(mut, seeds = [b"batch", batch.sender.as_ref(), batch.merkle_root.as_ref(), batch.nonce.to_le_bytes().as_ref()], bump = batch.bump)]
    pub batch: Account<'info, Batch>,
    #[account(mut)]
    pub sender: Signer<'info>,
}

pub fn append_batch_cipher(ctx: Context<AppendBatchCipher>, chunk: Vec<u8>) -> Result<()> {
    let batch = &mut ctx.accounts.batch;
    require!(ctx.accounts.sender.key() == batch.sender, ErrorCode::Unauthorized);
    require!(!batch.sealed, ErrorCode::BatchAlreadySealed);
    require!(
        batch.recipients_cipher.len() + chunk.len() <= batch.cipher_len_expected as usize,
        ErrorCode::BatchCipherOverflow
    );
    batch.recipients_cipher.extend_from_slice(&chunk);
    Ok(())
}

#[derive(Accounts)]
pub struct SealBatch<'info> {
    #[account(mut, seeds = [b"batch", batch.sender.as_ref(), batch.merkle_root.as_ref(), batch.nonce.to_le_bytes().as_ref()], bump = batch.bump)]
    pub batch: Account<'info, Batch>,
    #[account(mut)]
    pub sender: Signer<'info>,
}

pub fn seal_batch(ctx: Context<SealBatch>) -> Result<()> {
    let batch = &mut ctx.accounts.batch;
    require!(ctx.accounts.sender.key() == batch.sender, ErrorCode::Unauthorized);
    require!(!batch.sealed, ErrorCode::BatchAlreadySealed);
    require!(
        batch.recipients_cipher.len() == batch.cipher_len_expected as usize,
        ErrorCode::BatchNotSealed
    );
    batch.sealed = true;
    emit!(BatchSealed {
        batch: batch.key(),
        cipher_len: batch.recipients_cipher.len() as u32,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CloseBatch<'info> {
    #[account(
        mut,
        close = sender,
        seeds = [b"batch", batch.sender.as_ref(), batch.merkle_root.as_ref(), batch.nonce.to_le_bytes().as_ref()],
        bump = batch.bump,
    )]
    pub batch: Account<'info, Batch>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = batch)]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = sender,
        associated_token::mint = mint,
        associated_token::authority = sender,
    )]
    pub sender_ata: Account<'info, TokenAccount>,

    #[account(mut, address = batch.sender)]
    pub sender: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn close_batch(ctx: Context<CloseBatch>) -> Result<()> {
    let batch = &ctx.accounts.batch;
    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= batch.expire_at || batch.claimed_count == batch.leaf_count,
        ErrorCode::BatchNotExpired
    );

    // 未领取余款退回 sender，随后关闭 vault（租金 → sender）与 batch 账户（租金 → sender）
    let remaining = ctx.accounts.vault.amount;
    let nonce_bytes = batch.nonce.to_le_bytes();
    let seeds: &[&[u8]] = &[
        b"batch",
        batch.sender.as_ref(),
        batch.merkle_root.as_ref(),
        nonce_bytes.as_ref(),
        &[batch.bump],
    ];
    if remaining > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.sender_ata.to_account_info(),
                    authority: ctx.accounts.batch.to_account_info(),
                },
                &[seeds],
            ),
            remaining,
        )?;
    }
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.sender.to_account_info(),
            authority: ctx.accounts.batch.to_account_info(),
        },
        &[seeds],
    ))?;

    emit!(BatchClosed {
        batch: batch.key(),
        refunded: remaining,
    });
    Ok(())
}
