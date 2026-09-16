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
        escrow_id: [u8; 16],
        amount: u64,
    ) -> Result<()> {
        instructions::create_escrow(ctx, commitment, escrow_id, amount)
    }
}
