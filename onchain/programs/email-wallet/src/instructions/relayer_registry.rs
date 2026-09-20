use anchor_lang::prelude::*;

use crate::errors::ErrorCode;
use crate::events::{RelayerRegistered, RelayerUpdated};
use crate::state::{ProtocolConfig, RelayerEntry, MAX_EMAIL_LEN};

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(init, payer = payer, space = ProtocolConfig::SIZE, seeds = [b"protocol"], bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_protocol(
    ctx: Context<InitializeProtocol>,
    treasury: Pubkey,
    fee_lamports: u64,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.payer.key();
    config.treasury = treasury;
    config.fee_lamports = fee_lamports;
    config.bump = ctx.bumps.config;
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateProtocol<'info> {
    #[account(mut, seeds = [b"protocol"], bump = config.bump, has_one = authority @ ErrorCode::Unauthorized)]
    pub config: Account<'info, ProtocolConfig>,
    pub authority: Signer<'info>,
}

pub fn update_protocol(
    ctx: Context<UpdateProtocol>,
    treasury: Option<Pubkey>,
    fee_lamports: Option<u64>,
) -> Result<()> {
    if let Some(treasury) = treasury {
        ctx.accounts.config.treasury = treasury;
    }
    if let Some(fee) = fee_lamports {
        ctx.accounts.config.fee_lamports = fee;
    }
    Ok(())
}

#[derive(Accounts)]
#[instruction(email: String, email_hash: [u8; 32])]
pub struct RegisterRelayer<'info> {
    #[account(init, payer = claim_authority, space = RelayerEntry::SIZE, seeds = [b"relayer", email_hash.as_ref()], bump)]
    pub relayer_entry: Account<'info, RelayerEntry>,
    #[account(mut)]
    pub claim_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn register_relayer(
    ctx: Context<RegisterRelayer>,
    email: String,
    email_hash: [u8; 32],
    x25519_key: [u8; 32],
    claim_address: Pubkey,
    fee: u64,
) -> Result<()> {
    let email = email.to_lowercase();
    require!(!email.is_empty() && email.len() <= MAX_EMAIL_LEN, ErrorCode::InvalidEmail);
    let entry = &mut ctx.accounts.relayer_entry;
    entry.email = email.clone();
    entry.email_hash = email_hash;
    entry.x25519_key = x25519_key;
    entry.claim_address = claim_address;
    entry.fee = fee;
    entry.active = true;
    entry.bump = ctx.bumps.relayer_entry;
    emit!(RelayerRegistered { email_hash, email, claim_address });
    Ok(())
}

#[derive(Accounts)]
#[instruction(email_hash: [u8; 32])]
pub struct UpdateRelayer<'info> {
    #[account(mut, seeds = [b"relayer", email_hash.as_ref()], bump = relayer_entry.bump, has_one = claim_address @ ErrorCode::Unauthorized)]
    pub relayer_entry: Account<'info, RelayerEntry>,
    pub claim_address: Signer<'info>,
}

pub fn update_relayer(
    ctx: Context<UpdateRelayer>,
    email_hash: [u8; 32],
    x25519_key: Option<[u8; 32]>,
    claim_address: Option<Pubkey>,
    fee: Option<u64>,
    active: Option<bool>,
) -> Result<()> {
    let entry = &mut ctx.accounts.relayer_entry;
    if let Some(k) = x25519_key {
        entry.x25519_key = k;
    }
    if let Some(a) = claim_address {
        entry.claim_address = a;
    }
    if let Some(f) = fee {
        entry.fee = f;
    }
    if let Some(s) = active {
        entry.active = s;
    }
    emit!(RelayerUpdated { email_hash, active: entry.active });
    Ok(())
}
