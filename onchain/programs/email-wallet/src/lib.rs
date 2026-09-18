use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;
pub mod verifying_key;
pub mod zk;

use instructions::*;

declare_id!("5Dte2nXTSr5yLpr1MAH8QhjxfaHo4BbszutNyuTq3A45");

#[program]
pub mod email_wallet {
    use super::*;

    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        commitment: [u8; 32],
        amount: u64,
    ) -> Result<()> {
        instructions::create_escrow(ctx, commitment, amount)
    }

    pub fn initialize_registry(ctx: Context<InitializeRegistry>, authority: Pubkey) -> Result<()> {
        instructions::initialize_registry(ctx, authority)
    }

    pub fn registry_upsert(
        ctx: Context<RegistryUpsert>,
        domain_commitment: [u8; 32],
        selector: String,
        pubkey_hash: [u8; 32],
        expires_at: i64,
    ) -> Result<()> {
        instructions::registry_upsert(ctx, domain_commitment, selector, pubkey_hash, expires_at)
    }

    pub fn claim(ctx: Context<Claim>, args: ClaimArgs) -> Result<()> {
        instructions::claim(ctx, args)
    }

    pub fn sweep_inbox<'info>(
        ctx: Context<'_, '_, '_, 'info, SweepInbox<'info>>,
        args: ClaimArgs,
    ) -> Result<()> {
        instructions::sweep_inbox(ctx, args)
    }

    pub fn registry_revoke(
        ctx: Context<RegistryRevoke>,
        domain_commitment: [u8; 32],
        selector: String,
    ) -> Result<()> {
        instructions::registry_revoke(ctx, domain_commitment, selector)
    }
}
