use anchor_lang::prelude::*;

use crate::errors::ErrorCode;
use crate::state::{DkimRegistry, RegistryConfig, RegistryStatus};

#[derive(Accounts)]
pub struct InitializeRegistry<'info> {
    #[account(init, payer = payer, space = RegistryConfig::SIZE, seeds = [b"config"], bump)]
    pub config: Account<'info, RegistryConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_registry(ctx: Context<InitializeRegistry>, authority: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.authority = authority;
    config.bump = ctx.bumps.config;
    Ok(())
}

#[derive(Accounts)]
#[instruction(domain_commitment: [u8; 32], selector: String)]
pub struct RegistryUpsert<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, RegistryConfig>,

    #[account(
        init_if_needed,
        payer = authority,
        space = DkimRegistry::SIZE,
        seeds = [b"dkim", domain_commitment.as_ref(), selector.as_bytes()],
        bump,
    )]
    pub registry: Account<'info, DkimRegistry>,

    #[account(mut, address = config.authority @ ErrorCode::Unauthorized)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn registry_upsert(
    ctx: Context<RegistryUpsert>,
    _domain_commitment: [u8; 32],
    _selector: String,
    pubkey_hash: [u8; 32],
    expires_at: i64,
) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    registry.pubkey_hash = pubkey_hash;
    registry.status = RegistryStatus::Active;
    registry.expires_at = expires_at;
    registry.bump = ctx.bumps.registry;
    Ok(())
}

#[derive(Accounts)]
#[instruction(domain_commitment: [u8; 32], selector: String)]
pub struct RegistryRevoke<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, RegistryConfig>,

    #[account(
        mut,
        seeds = [b"dkim", domain_commitment.as_ref(), selector.as_bytes()],
        bump = registry.bump,
    )]
    pub registry: Account<'info, DkimRegistry>,

    #[account(address = config.authority @ ErrorCode::Unauthorized)]
    pub authority: Signer<'info>,
}

pub fn registry_revoke(ctx: Context<RegistryRevoke>, _domain_commitment: [u8; 32], _selector: String) -> Result<()> {
    ctx.accounts.registry.status = RegistryStatus::Revoked;
    Ok(())
}
