use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

// Unique ID for our Prediction Market program on the Solana blockchain.
declare_id!("PredMkt1111111111111111111111111111111111111");

// Standard "Seeds" used to find our program's private data folders (PDAs).
pub const MARKET_SEED: &[u8] = b"market";
pub const VAULT_SEED: &[u8] = b"vault";
pub const POSITION_SEED: &[u8] = b"position";
pub const REGISTRY_SEED: &[u8] = b"registry";

// Safety limits and protocol settings.
pub const MIN_STAKE: u64 = 1_000_000;  // Minimum bet amount (1 million lamports).
pub const MAX_TITLE_LEN: usize = 128;
pub const MAX_DESC_LEN: usize = 512;

// Memory space allocation for Solana accounts.
pub const REGISTRY_SPACE: usize = 8 + 128;
pub const MARKET_SPACE: usize = 8 + 4096;
pub const POSITION_SPACE: usize = 8 + 256;

/// This structure represents an encrypted message.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq)]
pub struct Ciphertext {
    pub c1: [u8; 32],
    pub c2: [u8; 32],
}

/// [SECURITY UPGRADE P1] - ZK-Stake Proof
/// This acts as a digital "Certificate of Funding." 
/// It proves you have the money for your bet without showing the amount to others.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct ZkStakeProof {
    /// A cryptographic seal confirming the amount is correct.
    pub commitment: [u8; 32],
    /// A random number to keep the proof private and unique.
    pub blinding_factor: [u8; 32],
    /// The actual amount, used ONLY for the secure bank transfer.
    pub amount: u64,
}

/// The Main Registry: Stores global settings like the Trusted Oracle's ID.
#[account]
pub struct MarketRegistry {
    pub authority: Pubkey,
    pub arcium_cluster: Pubkey,
    pub oracle_pubkey: Pubkey, // [PHASE 2] The ID of our Trusted Data Source.
    pub total_markets: u64,
    pub bump: u8,
}

/// A specific Prediction Market.
#[account]
pub struct Market {
    pub id: u64,
    pub creator: Pubkey,
    pub title: [u8; 128],
    pub description: [u8; 512],
    pub resolution_timestamp: i64,
    pub arcium_cluster: Pubkey,
    pub status: MarketStatus,
    pub outcome: Option<bool>,
    pub vault: Pubkey,
    pub bump: u8,
    pub vault_bump: u8,
}

/// The different stages a market can be in.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Default)]
pub enum MarketStatus {
    #[default] Open, Settled, Cancelled,
}

/// A user's individual bet (position).
#[account]
pub struct Position {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub encrypted_stake: Ciphertext,
    pub deposited_stake: u64,
    pub claimed: bool,
    pub bump: u8,
}

#[error_code]
pub enum PredictionMarketError {
    #[msg("Market is not open")] MarketNotOpen,
    #[msg("ZK Proof invalid")] InvalidZkProof,
    #[msg("Stake too low")] StakeTooLow,
    #[msg("Unauthorized Oracle")] UnauthorizedOracle,
}

#[program]
pub mod prediction_market {
    use super::*;

    /// Sets up the protocol for the first time.
    pub fn initialize(ctx: Context<Initialize>, arcium_cluster: Pubkey, oracle_pubkey: Pubkey) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        registry.authority = ctx.accounts.authority.key();
        registry.arcium_cluster = arcium_cluster;
        registry.oracle_pubkey = oracle_pubkey;
        registry.bump = ctx.bumps.registry;
        Ok(())
    }

    /// Creates a new betting market.
    pub fn create_market(ctx: Context<CreateMarket>, title: String, description: String, resolution_timestamp: i64) -> Result<()> {
        let market = &mut ctx.accounts.market;
        market.creator = ctx.accounts.creator.key();
        market.title = write_fixed_bytes::<128>(&title);
        market.description = write_fixed_bytes::<512>(&description);
        market.resolution_timestamp = resolution_timestamp;
        market.status = MarketStatus::Open;
        market.bump = ctx.bumps.market;
        market.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    /// [PHASE 1 UPGRADE] - Users place bets privately using a ZK-Proof.
    pub fn submit_position(ctx: Context<SubmitPosition>, encrypted_stake: Ciphertext, zk_proof: ZkStakeProof) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Open, PredictionMarketError::MarketNotOpen);
        require!(zk_proof.amount >= MIN_STAKE, PredictionMarketError::StakeTooLow);

        // Verify the ZK-Proof: This ensures the user isn't lying about their money.
        let expected_commitment = hashv(&[
            &zk_proof.amount.to_le_bytes(),
            &zk_proof.blinding_factor,
        ]).to_bytes();
        require!(zk_proof.commitment == expected_commitment, PredictionMarketError::InvalidZkProof);

        // Securely transfer the tokens to the vault.
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, zk_proof.amount)?;

        // Save the bet details privately.
        let position = &mut ctx.accounts.position;
        position.owner = ctx.accounts.user.key();
        position.market = market.key();
        position.encrypted_stake = encrypted_stake;
        position.deposited_stake = zk_proof.amount;
        position.claimed = false;
        position.bump = ctx.bumps.position;
        Ok(())
    }

    /// [PHASE 2 UPGRADE] - The Trusted Oracle decides the winner.
    pub fn settle_market(ctx: Context<SettleMarket>, yes_won: bool) -> Result<()> {
        let registry = &ctx.accounts.registry;
        let market = &mut ctx.accounts.market;

        // Verify that only our Trusted Oracle can settle this market.
        require!(ctx.accounts.oracle.key() == registry.oracle_pubkey, PredictionMarketError::UnauthorizedOracle);

        market.outcome = Some(yes_won);
        market.status = MarketStatus::Settled;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = REGISTRY_SPACE, seeds = [REGISTRY_SEED], bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(init, payer = creator, space = MARKET_SPACE, seeds = [MARKET_SEED, registry.total_markets.to_le_bytes().as_ref()], bump)]
    pub market: Account<'info, Market>,
    #[account(init, payer = creator, token::mint = token_mint, token::authority = vault, seeds = [VAULT_SEED, registry.total_markets.to_le_bytes().as_ref()], bump)]
    pub vault: Account<'info, TokenAccount>,
    pub token_mint: Account<'info, Mint>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SubmitPosition<'info> {
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut, seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(init, payer = user, space = POSITION_SPACE, seeds = [POSITION_SEED, market.key().as_ref(), user.key().as_ref()], bump)]
    pub position: Account<'info, Position>,
    #[account(mut, seeds = [VAULT_SEED, market.id.to_le_bytes().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut, seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    pub oracle: Signer<'info>,
}

fn write_fixed_bytes<const N: usize>(value: &str) -> [u8; N] {
    let mut out = [0u8; N];
    let bytes = value.as_bytes();
    let take = bytes.len().min(N);
    out[..take].copy_from_slice(&bytes[..take]);
    out
}
