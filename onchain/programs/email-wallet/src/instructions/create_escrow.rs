use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

use crate::errors::ErrorCode;
use crate::state::Escrow;

#[derive(Accounts)]
#[instruction(commitment: [u8; 32], escrow_id: [u8; 16])]
pub struct CreateEscrow<'info> {
    #[account(
        init,
        payer = sender,
        space = Escrow::SIZE,
        seeds = [b"escrow", commitment.as_ref(), sender.key().as_ref(), escrow_id.as_ref()],
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

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn create_escrow(
    ctx: Context<CreateEscrow>,
    commitment: [u8; 32],
    escrow_id: [u8; 16],
    amount: u64,
) -> Result<()> {
    require!(amount > 0, ErrorCode::InvalidAmount);
    let escrow = &mut ctx.accounts.escrow;
    escrow.commitment = commitment;
    escrow.sender = ctx.accounts.sender.key();
    escrow.mint = ctx.accounts.mint.key();
    escrow.amount = amount;
    escrow.escrow_id = escrow_id;
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
    Ok(())
}
