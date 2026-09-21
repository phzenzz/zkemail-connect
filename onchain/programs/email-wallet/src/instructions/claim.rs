use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};
use groth16_solana::groth16::Groth16Verifier;

use crate::errors::ErrorCode;
use crate::state::{DkimRegistry, Escrow, ProtocolConfig, RegistryStatus};
use crate::verifying_key::VERIFYING_KEY;
use crate::zk::{self, PublicInputs};

pub const TIMESTAMP_WINDOW_FUTURE: i64 = 600; // 10min clock skew

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ClaimArgs {
    pub proof_a: [u8; 64],
    pub proof_b: [u8; 128],
    pub proof_c: [u8; 64],
    pub public_inputs: [[u8; 32]; 9],
    pub selector: String,
}

#[derive(Accounts)]
#[instruction(args: ClaimArgs)]
pub struct Claim<'info> {
    /// Escrow account existing = Open; closed here (rent -> sender).
    #[account(
        mut,
        close = sender,
        seeds = [b"escrow", escrow.commitment.as_ref(), escrow.sender.as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,

    /// CHECK: rent recipient, taken from escrow state
    #[account(mut, address = escrow.sender)]
    pub sender: UncheckedAccount<'info>,

    #[account(mut, associated_token::mint = mint, associated_token::authority = escrow)]
    pub vault: Account<'info, TokenAccount>,

    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [b"dkim", args.public_inputs[6].as_ref(), args.selector.as_bytes()],
        bump = registry.bump,
    )]
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

    /// CHECK: 零数据标记账户，存在即"该邮件已用过"；重复提交由 init 拒绝。
    #[account(init, payer = payer, space = 8, seeds = [b"nullifier", args.public_inputs[7].as_ref()], bump)]
    pub nullifier: UncheckedAccount<'info>,

    #[account(seeds = [b"protocol"], bump = protocol_config.bump)]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn claim(ctx: Context<Claim>, args: ClaimArgs) -> Result<()> {
    require!(ctx.accounts.nullifier.data_is_empty(), ErrorCode::NullifierAlreadyUsed);
    let escrow = &ctx.accounts.escrow;

    // 1. parse public inputs + bind commitment to the escrow being claimed
    let pi = zk::parse_public_inputs(&args.public_inputs)?;
    require!(pi.commitment == escrow.commitment, ErrorCode::CommitmentMismatch);

    // 2-6. registry + timestamp + relayer + dest + groth16 (shared with sweep_inbox)
    verify_claim_common(
        &args,
        &pi,
        &ctx.accounts.registry,
        &ctx.accounts.protocol_config,
        &ctx.accounts.payer.key(),
        &ctx.accounts.dest_owner.key(),
    )?;
    require!(pi.relayer_email_hash == escrow.relayer_email_hash, ErrorCode::RelayerEmailHashMismatch);

    // 7. transfer everything out of the vault, then close it; escrow closed by `close = sender`
    let seeds: &[&[u8]] = &[
        b"escrow",
        escrow.commitment.as_ref(),
        escrow.sender.as_ref(),
        &[escrow.bump],
    ];
    let signer = &[seeds];
    let amount = ctx.accounts.vault.amount;
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.dest_ata.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            signer,
        ),
        amount,
    )?;
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.sender.to_account_info(),
            authority: ctx.accounts.escrow.to_account_info(),
        },
        signer,
    ))?;
    Ok(())
}

/// Preconditions shared by claim and sweep_inbox: registry status/expiry/pubkey hash,
/// timestamp window, relayer binding, dest binding, Groth16 verify.
/// Returns the decoded dest pubkey.
pub fn verify_claim_common(
    args: &ClaimArgs,
    pi: &PublicInputs,
    registry: &DkimRegistry,
    protocol_config: &ProtocolConfig,
    payer: &Pubkey,
    dest_owner: &Pubkey,
) -> Result<Pubkey> {
    let now = Clock::get()?.unix_timestamp;

    // registry: key must be registered, active, unexpired, matching the proven pubkey hash
    require!(registry.status == RegistryStatus::Active, ErrorCode::RegistryNotActive);
    require!(registry.expires_at > now, ErrorCode::RegistryExpired);
    require!(registry.pubkey_hash == pi.pubkey_hash, ErrorCode::PubkeyHashMismatch);

    // timestamp window
    let ts = pi.timestamp as i64;
    require!(
        ts >= now - protocol_config.timestamp_window_past && ts <= now + TIMESTAMP_WINDOW_FUTURE,
        ErrorCode::TimestampOutOfWindow
    );

    // relayer binding: proof binds the fee payer
    require!(zk::pubkey_to_field(payer) == pi.relayer, ErrorCode::RelayerMismatch);

    // dest from proof (subject address), must match the provided dest_owner account
    let dest = zk::decode_dest(&pi.dest_a, &pi.dest_b)?;
    require!(dest == *dest_owner, ErrorCode::DestOwnerMismatch);

    // Groth16 verify
    let mut verifier = Groth16Verifier::new(
        &args.proof_a,
        &args.proof_b,
        &args.proof_c,
        &args.public_inputs,
        &VERIFYING_KEY,
    )
    .map_err(|_| ErrorCode::ProofVerificationFailed)?;
    verifier.verify().map_err(|_| ErrorCode::ProofVerificationFailed)?;

    Ok(dest)
}
