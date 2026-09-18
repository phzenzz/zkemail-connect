use anchor_lang::prelude::*;
use anchor_spl::associated_token::{self, AssociatedToken, Create};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::ErrorCode;
use crate::instructions::claim::{verify_claim_common, ClaimArgs};
use crate::state::DkimRegistry;
use crate::zk;

#[derive(Accounts)]
#[instruction(args: ClaimArgs)]
pub struct SweepInbox<'info> {
    /// CHECK: zero-data inbox PDA, token authority only; seeds bind it to the proven commitment
    #[account(seeds = [b"inbox", args.public_inputs[1].as_ref()], bump)]
    pub inbox: UncheckedAccount<'info>,

    #[account(
        seeds = [b"dkim", args.public_inputs[6].as_ref(), args.selector.as_bytes()],
        bump = registry.bump,
    )]
    pub registry: Account<'info, DkimRegistry>,

    /// CHECK: dest owner, decoded from the proof and compared in the handler
    pub dest_owner: UncheckedAccount<'info>,

    /// Relayer: pays the tx (and dest ATA rent); the proof binds this key.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: repeating triples [mint, inbox_ata, dest_ata]
}

pub fn sweep_inbox<'info>(
    ctx: Context<'_, '_, '_, 'info, SweepInbox<'info>>,
    args: ClaimArgs,
) -> Result<()> {
    // 1-6. same proof preconditions as claim (registry/timestamp/relayer/dest/groth16)
    let pi = zk::parse_public_inputs(&args.public_inputs)?;
    let dest = verify_claim_common(
        &args,
        &pi,
        &ctx.accounts.registry,
        &ctx.accounts.payer.key(),
        &ctx.accounts.dest_owner.key(),
    )?;

    // 7. sweep every (mint, inbox_ata, dest_ata) triple from remaining_accounts
    let remaining = &ctx.remaining_accounts;
    require!(remaining.len() % 3 == 0, ErrorCode::VaultBalanceMismatch);

    let inbox_bump = ctx.bumps.inbox;
    let signer: &[&[&[u8]]] = &[&[b"inbox", pi.commitment.as_ref(), &[inbox_bump]]];
    for triple in remaining.chunks(3) {
        let (mint_ai, inbox_ata, dest_ata) = (&triple[0], &triple[1], &triple[2]);

        // each ATA must be the canonical ATA of (inbox/dest, mint)
        let expected_inbox_ata =
            associated_token::get_associated_token_address(&ctx.accounts.inbox.key(), mint_ai.key);
        require!(inbox_ata.key() == expected_inbox_ata, ErrorCode::VaultBalanceMismatch);
        let expected_dest_ata = associated_token::get_associated_token_address(&dest, mint_ai.key);
        require!(dest_ata.key() == expected_dest_ata, ErrorCode::DestOwnerMismatch);

        // nothing ever deposited for this mint -> nothing to sweep
        if inbox_ata.data_is_empty() {
            continue;
        }
        let from = TokenAccount::try_deserialize(&mut &inbox_ata.try_borrow_data()?[..])?;
        if from.amount == 0 {
            continue;
        }

        // dest ATA created idempotently by the relayer (no-op once it exists)
        associated_token::create_idempotent(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            Create {
                payer: ctx.accounts.payer.to_account_info(),
                associated_token: dest_ata.clone(),
                authority: ctx.accounts.dest_owner.to_account_info(),
                mint: mint_ai.clone(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: inbox_ata.clone(),
                    to: dest_ata.clone(),
                    authority: ctx.accounts.inbox.to_account_info(),
                },
                signer,
            ),
            from.amount,
        )?;
    }
    Ok(())
}
