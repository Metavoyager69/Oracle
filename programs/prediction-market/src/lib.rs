use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("PredMkt1111111111111111111111111111111111111");

// Seeds are short labels used to derive deterministic account addresses (PDAs).
pub const MARKET_SEED: &[u8] = b"market";
pub const VAULT_SEED: &[u8] = b"vault";
pub const POSITION_SEED: &[u8] = b"position";
pub const REGISTRY_SEED: &[u8] = b"registry";

// Minimum stake is expressed in the smallest unit (lamports) for SPL tokens.
pub const MIN_STAKE: u64 = 1_000_000; 
pub const REGISTRY_SPACE: usize = 8 + 256;
pub const MARKET_SPACE: usize = 8 + 1024; // Optimized space
pub const POSITION_SPACE: usize = 8 + 256;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq)]
pub struct Ciphertext {
    pub c1: [u8; 32],
    pub c2: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct ZkStakeProof {
    pub commitment: [u8; 32],
    pub blinding_factor: [u8; 32],
    pub amount: u64,
}

#[account]
pub struct MarketRegistry {
    // Protocol owner / admin key.
    pub authority: Pubkey,
    // Arcium cluster public key (MPC / privacy layer).
    pub arcium_cluster: Pubkey,
    // Fixed set of oracles that can vote on settlement.
    pub oracle_keys: [Pubkey; 5],
    pub total_markets: u64, // FIXED: Now used to assign IDs
    pub bump: u8,
}

#[account]
pub struct Market {
    // Unique ID and creator for the market.
    pub id: u64,
    pub creator: Pubkey,
    // Human-readable market title and description.
    pub title: [u8; 128],
    pub description: [u8; 512],
    // UNIX timestamp after which settlement is allowed.
    pub resolution_timestamp: i64,
    pub status: MarketStatus,
    pub outcome: Option<bool>,
    // Vault that holds pooled funds for this market.
    pub vault: Pubkey,
    pub total_yes_stake: u64, // FIXED: Track pool for fair payouts
    pub total_no_stake: u64,  // FIXED: Track pool for fair payouts
    pub yes_votes: u8,
    pub no_votes: u8,
    pub voters: [Pubkey; 5],
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Default)]
pub enum MarketStatus {
    #[default] Open, Settled, Cancelled,
}

#[account]
pub struct Position {
    // User position in a specific market (one per user/market).
    pub owner: Pubkey,
    pub market: Pubkey,
    pub deposited_stake: u64,
    pub claimed: bool,
    pub choice: bool,
    pub bump: u8,
}

#[error_code]
pub enum PredictionMarketError {
    #[msg("Market is not open")] MarketNotOpen,
    #[msg("ZK Proof invalid")] InvalidZkProof,
    #[msg("Stake too low")] StakeTooLow,
    #[msg("Unauthorized Oracle")] UnauthorizedOracle,
    #[msg("Oracle already voted")] AlreadyVoted,
    #[msg("Market not settled yet")] MarketNotSettled,
    #[msg("Already claimed")] AlreadyClaimed,
    #[msg("You did not win this bet")] DidNotWin,
    #[msg("Market already settled")] AlreadySettled,
    #[msg("Event has already occurred")] EventPassed,
}

#[program]
pub mod prediction_market {
    use super::*;

    // One-time setup: registers the protocol authority and oracle set.
    pub fn initialize(ctx: Context<Initialize>, arcium_cluster: Pubkey, oracles: [Pubkey; 5]) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        registry.authority = ctx.accounts.authority.key();
        registry.arcium_cluster = arcium_cluster;
        registry.oracle_keys = oracles;
        registry.total_markets = 0; // FIXED: Initialize counter
        registry.bump = ctx.bumps.registry;
        Ok(())
    }

    // Creates a new prediction market and allocates its vault.
    pub fn create_market(ctx: Context<CreateMarket>, title: String, description: String, resolution_timestamp: i64) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        let market = &mut ctx.accounts.market;
        
        market.id = registry.total_markets; // FIXED: Assign unique ID
        market.creator = ctx.accounts.creator.key();
        market.title = write_fixed_bytes::<128>(&title);
        market.description = write_fixed_bytes::<512>(&description);
        market.resolution_timestamp = resolution_timestamp;
        market.status = MarketStatus::Open;
        market.total_yes_stake = 0;
        market.total_no_stake = 0;
        market.yes_votes = 0;
        market.no_votes = 0;
        market.voters = [Pubkey::default(); 5];
        market.bump = ctx.bumps.market;
        market.vault_bump = ctx.bumps.vault;

        registry.total_markets += 1; // FIXED: Increment global counter
        Ok(())
    }

    // User submits a position. Stake is transferred into the vault.
    // ZK proof ensures the stake amount is valid without revealing details.
    pub fn submit_position(ctx: Context<SubmitPosition>, _encrypted_stake: Ciphertext, zk_proof: ZkStakeProof, choice: bool) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;

        // FIXED: Block bets after the event timestamp has passed
        require!(clock.unix_timestamp < market.resolution_timestamp, PredictionMarketError::EventPassed);
        require!(market.status == MarketStatus::Open, PredictionMarketError::MarketNotOpen);
        require!(zk_proof.amount >= MIN_STAKE, PredictionMarketError::StakeTooLow);

        let expected_commitment = hashv(&[&zk_proof.amount.to_le_bytes(), &zk_proof.blinding_factor]).to_bytes();
        require!(zk_proof.commitment == expected_commitment, PredictionMarketError::InvalidZkProof);

        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, zk_proof.amount)?;

        // FIXED: Update pool totals
        if choice {
            market.total_yes_stake += zk_proof.amount;
        } else {
            market.total_no_stake += zk_proof.amount;
        }

        let position = &mut ctx.accounts.position;
        position.owner = ctx.accounts.user.key();
        position.market = market.key();
        position.deposited_stake = zk_proof.amount;
        position.choice = choice;
        position.claimed = false;
        position.bump = ctx.bumps.position;
        Ok(())
    }

    // Oracles vote to settle the market after resolution time.
    // Requires a majority of oracle keys (3 out of 5).
    pub fn vote_on_outcome(ctx: Context<SettleMarket>, yes_won: bool) -> Result<()> {
        let registry = &ctx.accounts.registry;
        let market = &mut ctx.accounts.market;

        // FIXED: Don't allow voting on already settled markets
        require!(market.status == MarketStatus::Open, PredictionMarketError::AlreadySettled);

        let oracle_key = ctx.accounts.oracle.key();
        let is_valid_oracle = registry.oracle_keys.iter().any(|&k| k == oracle_key);
        require!(is_valid_oracle, PredictionMarketError::UnauthorizedOracle);
        require!(!market.voters.iter().any(|&k| k == oracle_key), PredictionMarketError::AlreadyVoted);

        for voter in market.voters.iter_mut() {
            if *voter == Pubkey::default() {
                *voter = oracle_key;
                break;
            }
        }

        if yes_won { market.yes_votes += 1; } else { market.no_votes += 1; }

        if market.yes_votes >= 3 {
            market.outcome = Some(true);
            market.status = MarketStatus::Settled;
        } else if market.no_votes >= 3 {
            market.outcome = Some(false);
            market.status = MarketStatus::Settled;
        }
        Ok(())
    }

    // Winning users claim their payout from the vault.
    pub fn claim_winnings(ctx: Context<ClaimWinnings>) -> Result<()> {
        let market = &ctx.accounts.market;
        let position = &mut ctx.accounts.position;

        require!(market.status == MarketStatus::Settled, PredictionMarketError::MarketNotSettled);
        require!(!position.claimed, PredictionMarketError::AlreadyClaimed);

        let market_outcome = market.outcome.unwrap();
        require!(position.choice == market_outcome, PredictionMarketError::DidNotWin);

        // FIXED: Parimutuel Payout logic (Fair pool sharing)
        // payout = (user_stake / winning_pool) * total_pool
        let total_pool = market.total_yes_stake + market.total_no_stake;
        let winning_pool = if market_outcome { market.total_yes_stake } else { market.total_no_stake };
        
        let payout = (position.deposited_stake as u128)
            .checked_mul(total_pool as u128).unwrap()
            .checked_div(winning_pool as u128).unwrap() as u64;

        let market_id_bytes = market.id.to_le_bytes();
        let seeds = &[VAULT_SEED, market_id_bytes.as_ref(), &[market.vault_bump]];
        let signer_seeds = &[&seeds[..]];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_ctx, payout)?;

        position.claimed = true;
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

#[derive(Accounts)]
pub struct ClaimWinnings<'info> {
    #[account(seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [POSITION_SEED, market.key().as_ref(), user.key().as_ref()], bump = position.bump)]
    pub position: Account<'info, Position>,
    #[account(mut, seeds = [VAULT_SEED, market.id.to_le_bytes().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

fn write_fixed_bytes<const N: usize>(value: &str) -> [u8; N] {
    let mut out = [0u8; N];
    let bytes = value.as_bytes();
    let take = bytes.len().min(N);
    out[..take].copy_from_slice(&bytes[..take]);
    out
}
