use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer as SystemTransfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::ErrorCode;
use crate::events::EscrowCreated;
use crate::state::{Escrow, ProtocolConfig, RelayerEntry, MAX_CIPHER_LEN};

#[derive(Accounts)]
#[instruction(commitment: [u8; 32], amount: u64, email_cipher: Vec<u8>, relayer_email_hash: [u8; 32])]
pub struct CreateEscrow<'info> {
    #[account(
        init,
        payer = sender,
        space = Escrow::SIZE,
        seeds = [b"escrow", commitment.as_ref(), sender.key().as_ref()],
        bump,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        init,
        payer = sender,
        associated_token::mint = mint,
        associated_token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = sender,
    )]
    pub sender_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub sender: Signer<'info>,

    #[account(seeds = [b"protocol"], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,

    /// CHECK: 仅作手续费收款账户；地址已由 address = config.treasury 约束
    #[account(mut, address = config.treasury @ ErrorCode::Unauthorized)]
    pub treasury: UncheckedAccount<'info>,

    #[account(
        seeds = [b"relayer", relayer_email_hash.as_ref()],
        bump = relayer_entry.bump,
    )]
    pub relayer_entry: Account<'info, RelayerEntry>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn create_escrow(
    ctx: Context<CreateEscrow>,
    commitment: [u8; 32],
    amount: u64,
    email_cipher: Vec<u8>,
    relayer_email_hash: [u8; 32],
) -> Result<()> {
    require!(amount > 0, ErrorCode::InvalidAmount);
    require!(
        !crate::zk::ge_be(&commitment, &crate::zk::FR_MODULUS),
        ErrorCode::InvalidCommitment
    );
    require!(
        !email_cipher.is_empty() && email_cipher.len() <= MAX_CIPHER_LEN,
        ErrorCode::InvalidCipherSize
    );
    require!(ctx.accounts.relayer_entry.active, ErrorCode::RelayerNotActive);

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            SystemTransfer {
                from: ctx.accounts.sender.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
            },
        ),
        ctx.accounts.config.fee_lamports,
    )?;

    let escrow = &mut ctx.accounts.escrow;
    escrow.commitment = commitment;
    escrow.sender = ctx.accounts.sender.key();
    escrow.mint = ctx.accounts.mint.key();
    escrow.amount = amount;
    escrow.relayer_email_hash = relayer_email_hash;
    escrow.email_cipher = email_cipher;
    escrow.bump = ctx.bumps.escrow;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.sender_ata.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.sender.to_account_info(),
            },
        ),
        amount,
    )?;

    emit!(EscrowCreated {
        escrow: escrow.key(),
        sender: escrow.sender,
        commitment,
        amount,
        relayer_email_hash,
    });
    Ok(())
}
