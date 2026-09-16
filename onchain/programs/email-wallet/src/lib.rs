use anchor_lang::prelude::*;

pub mod errors;
pub mod state;
pub mod verifying_key;
pub mod zk;

declare_id!("5Dte2nXTSr5yLpr1MAH8QhjxfaHo4BbszutNyuTq3A45");

#[program]
pub mod email_wallet {
    use super::*;
    // instructions added by later tasks
}
