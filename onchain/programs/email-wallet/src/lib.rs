use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod verifying_key;
pub mod zk;

use instructions::*;

declare_id!("9Bk8J1CK23pH6zB5CMNZZvNimTfGeeAaHxopNbjURfBR");

#[program]
pub mod email_wallet {
    use super::*;

    pub fn create_escrow(
        ctx: Context<CreateEscrow>,
        commitment: [u8; 32],
        amount: u64,
        email_cipher: Vec<u8>,
        relayer_email_hash: [u8; 32],
    ) -> Result<()> {
        instructions::create_escrow(ctx, commitment, amount, email_cipher, relayer_email_hash)
    }

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        treasury: Pubkey,
        fee_lamports: u64,
        timestamp_window_past: i64,
    ) -> Result<()> {
        instructions::initialize_protocol(ctx, treasury, fee_lamports, timestamp_window_past)
    }

    pub fn update_protocol(
        ctx: Context<UpdateProtocol>,
        treasury: Option<Pubkey>,
        fee_lamports: Option<u64>,
        timestamp_window_past: Option<i64>,
    ) -> Result<()> {
        instructions::update_protocol(ctx, treasury, fee_lamports, timestamp_window_past)
    }

    pub fn register_relayer(
        ctx: Context<RegisterRelayer>,
        email: String,
        email_hash: [u8; 32],
        x25519_key: [u8; 32],
        claim_address: Pubkey,
        fee: u64,
    ) -> Result<()> {
        instructions::register_relayer(ctx, email, email_hash, x25519_key, claim_address, fee)
    }

    pub fn update_relayer(
        ctx: Context<UpdateRelayer>,
        email_hash: [u8; 32],
        x25519_key: Option<[u8; 32]>,
        claim_address: Option<Pubkey>,
        fee: Option<u64>,
        active: Option<bool>,
    ) -> Result<()> {
        instructions::update_relayer(ctx, email_hash, x25519_key, claim_address, fee, active)
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

    pub fn create_batch(
        ctx: Context<CreateBatch>,
        merkle_root: [u8; 32],
        amount_per_recipient: u64,
        leaf_count: u32,
        cipher_len_expected: u32,
        expire_at: i64,
        relayer_email_hash: [u8; 32],
    ) -> Result<()> {
        instructions::create_batch(
            ctx,
            merkle_root,
            amount_per_recipient,
            leaf_count,
            cipher_len_expected,
            expire_at,
            relayer_email_hash,
        )
    }

    pub fn append_batch_cipher(ctx: Context<AppendBatchCipher>, chunk: Vec<u8>) -> Result<()> {
        instructions::append_batch_cipher(ctx, chunk)
    }

    pub fn seal_batch(ctx: Context<SealBatch>) -> Result<()> {
        instructions::seal_batch(ctx)
    }

    pub fn close_batch(ctx: Context<CloseBatch>) -> Result<()> {
        instructions::close_batch(ctx)
    }
}
