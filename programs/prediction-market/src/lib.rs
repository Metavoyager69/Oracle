use anchor_lang::prelude::*;
use anchor_lang::solana_program::{hash::hashv, program::invoke, program::invoke_signed, system_instruction};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

// Unique ID for our Prediction Market program on the Solana blockchain.
declare_id!("PredMkt1111111111111111111111111111111111111");

// Standard "Seeds" used to find our program's private data folders (PDAs).
pub const MARKET_SEED: &[u8] = b"market";
pub const VAULT_SEED: &[u8] = b"vault";
pub const POSITION_SEED: &[u8] = b"position";
pub const REGISTRY_SEED: &[u8] = b"registry";
pub const BOND_VAULT_SEED: &[u8] = b"bond-vault";

// Safety limits and protocol settings.
pub const MIN_STAKE: u64 = 1_000_000;  
pub const MIN_CHALLENGE_BOND: u64 = 5_000_000; // [FIX: GRIEFING] - Require significant bond to challenge.
pub const ORACLE_VOTE_THRESHOLD: u8 = 3; 
pub const CHALLENGE_WINDOW_SECS: i64 = 24 * 60 * 60; // 24-hour window.
pub const LIVENESS_TIMEOUT_SECS: i64 = 7 * 24 * 60 * 60; // 7-day escape hatch.

// [DATABASE WIZARD] - Perfectly aligned memory spaces (Multiples of 8).
pub const REGISTRY_SPACE: usize = 8 + 32 + 32 + (32 * 5) + 8 + 8; 
pub const MARKET_SPACE: usize = 8 + 1200; 
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
    pub authority: Pubkey,
    pub arcium_cluster: Pubkey,
    pub oracle_keys: [Pubkey; 5],
    pub total_markets: u64,
    pub version: u8,
    pub bump: u8,
}

#[account]
pub struct Market {
    // [OPTIMIZED LAYOUT] - Large fields first for 8-byte alignment.
    pub id: u64,
    pub creator: Pubkey,
    pub vault: Pubkey,
    pub bond_vault: Pubkey,
    pub arcium_cluster: Pubkey,
    pub resolution_timestamp: i64,
    pub challenge_deadline: i64,
    pub total_yes_stake: u64,
    pub total_no_stake: u64,
    pub challenge_bond_amount: u64,
    pub challenger: Pubkey,
    pub title: [u8; 128],
    pub description: [u8; 512],
    pub voters: [Pubkey; 5],
    pub vote_records: [u8; 5], // 1=Yes, 2=No
    pub status: MarketStatus,
    pub outcome: Option<bool>,
    pub challenged: bool,
    pub version: u8,
    pub bump: u8,
    pub vault_bump: u8,
    pub bond_vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Default, Copy)]
pub enum MarketStatus {
    #[default] Open, SettledPending, Settled, Invalid, Cancelled,
}

#[account]
pub struct Position {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub deposited_stake: u64,
    pub choice: bool,
    pub claimed: bool,
    pub version: u8,
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
    #[msg("Challenge window expired")] ChallengeWindowClosed,
    #[msg("Challenge bond too low")] BondTooLow,
    #[msg("Market is already challenged")] AlreadyChallenged,
    #[msg("Liveness timeout not reached")] TimeoutNotReached,
}

#[program]
pub mod prediction_market {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, arcium_cluster: Pubkey, oracles: [Pubkey; 5]) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        registry.authority = ctx.accounts.authority.key();
        registry.arcium_cluster = arcium_cluster;
        registry.oracle_keys = oracles;
        registry.total_markets = 0;
        registry.version = 1;
        registry.bump = ctx.bumps.registry;
        Ok(())
    }

    pub fn create_market(ctx: Context<CreateMarket>, title: String, description: String, resolution_timestamp: i64) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        let market = &mut ctx.accounts.market;
        
        market.id = registry.total_markets;
        market.creator = ctx.accounts.creator.key();
        market.vault = ctx.accounts.vault.key();
        market.bond_vault = ctx.accounts.bond_vault.key();
        market.arcium_cluster = registry.arcium_cluster;
        market.title = write_fixed_bytes::<128>(&title);
        market.description = write_fixed_bytes::<512>(&description);
        market.resolution_timestamp = resolution_timestamp;
        market.status = MarketStatus::Open;
        market.version = 1;
        market.bump = ctx.bumps.market;
        market.vault_bump = ctx.bumps.vault;
        market.bond_vault_bump = ctx.bumps.bond_vault;

        registry.total_markets += 1;
        Ok(())
    }

    pub fn submit_position(ctx: Context<SubmitPosition>, _encrypted_stake: Ciphertext, zk_proof: ZkStakeProof, choice: bool) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;

        require!(clock.unix_timestamp < market.resolution_timestamp, PredictionMarketError::MarketNotOpen);
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
        position.version = 1;
        position.bump = ctx.bumps.position;
        Ok(())
    }

    pub fn vote_on_outcome(ctx: Context<VoteOnOutcome>, yes_won: bool) -> Result<()> {
        let registry = &ctx.accounts.registry;
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;

        let oracle_key = ctx.accounts.oracle.key();
        let is_valid_oracle = registry.oracle_keys.iter().any(|&k| k == oracle_key);
        require!(is_valid_oracle, PredictionMarketError::UnauthorizedOracle);
        require!(!market.voters.iter().any(|&k| k == oracle_key), PredictionMarketError::AlreadyVoted);

        for (idx, voter) in market.voters.iter_mut().enumerate() {
            if *voter == Pubkey::default() {
                *voter = oracle_key;
                market.vote_records[idx] = if yes_won { 1 } else { 2 };
                break;
            }
        }

        let (mut y, mut n) = (0u8, 0u8);
        for v in market.vote_records.iter() {
            if *v == 1 { y += 1; } else if *v == 2 { n += 1; }
        }

        if y >= ORACLE_VOTE_THRESHOLD {
            market.outcome = Some(true);
            market.status = MarketStatus::SettledPending;
            market.challenge_deadline = clock.unix_timestamp + CHALLENGE_WINDOW_SECS;
        } else if n >= ORACLE_VOTE_THRESHOLD {
            market.outcome = Some(false);
            market.status = MarketStatus::SettledPending;
            market.challenge_deadline = clock.unix_timestamp + CHALLENGE_WINDOW_SECS;
        }
        Ok(())
    }

    /// [FIX: GRIEFING] - To challenge, you must pay a bond.
    pub fn challenge_settlement(ctx: Context<ChallengeSettlement>, bond_amount: u64) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;

        require!(!market.challenged, PredictionMarketError::AlreadyChallenged);
        require!(clock.unix_timestamp < market.challenge_deadline, PredictionMarketError::ChallengeWindowClosed);
        require!(bond_amount >= MIN_CHALLENGE_BOND, PredictionMarketError::BondTooLow);

        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.challenger_token_account.to_account_info(),
                to: ctx.accounts.bond_vault.to_account_info(),
                authority: ctx.accounts.challenger.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, bond_amount)?;

        market.status = MarketStatus::Invalid;
        market.challenged = true;
        market.challenger = ctx.accounts.challenger.key();
        market.challenge_bond_amount = bond_amount;
        Ok(())
    }

    pub fn finalize_settlement(ctx: Context<FinalizeSettlement>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;
        require!(clock.unix_timestamp > market.challenge_deadline, PredictionMarketError::TimeoutNotReached);
        require!(!market.challenged, PredictionMarketError::AlreadyChallenged);
        market.status = MarketStatus::Settled;
        Ok(())
    }

    pub fn claim_winnings(ctx: Context<ClaimWinnings>) -> Result<()> {
        let market = &ctx.accounts.market;
        let position = &mut ctx.accounts.position;

        require!(market.status == MarketStatus::Settled, PredictionMarketError::MarketNotSettled);
        require!(!position.claimed, PredictionMarketError::AlreadyClaimed);

        let outcome = market.outcome.unwrap();
        require!(position.choice == outcome, PredictionMarketError::DidNotWin);

        // [CEI PATTERN] - Mark as claimed BEFORE transfer to prevent re-entrancy.
        position.claimed = true;

        let total_pool = market.total_yes_stake + market.total_no_stake;
        let winning_pool = if outcome { market.total_yes_stake } else { market.total_no_stake };
        
        let payout = (position.deposited_stake as u128)
            .checked_mul(total_pool as u128).unwrap()
            .checked_div(winning_pool as u128).unwrap() as u64;

        let seeds = &[VAULT_SEED, market.id.to_le_bytes().as_ref(), &[market.vault_bump]];
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
        Ok(())
    }

    /// [FIX: ESCAPE HATCH] - Refund if market is broken or stuck.
    pub fn refund_position(ctx: Context<RefundPosition>) -> Result<()> {
        let market = &ctx.accounts.market;
        let position = &mut ctx.accounts.position;
        let clock = Clock::get()?;

        let timed_out = clock.unix_timestamp > market.resolution_timestamp + LIVENESS_TIMEOUT_SECS;
        let is_broken = market.status == MarketStatus::Cancelled || market.status == MarketStatus::Invalid;

        require!(timed_out || is_broken, PredictionMarketError::TimeoutNotReached);
        require!(!position.claimed, PredictionMarketError::AlreadyClaimed);

        position.claimed = true;

        let seeds = &[VAULT_SEED, market.id.to_le_bytes().as_ref(), &[market.vault_bump]];
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
        token::transfer(cpi_ctx, position.deposited_stake)?;
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
    #[account(init, payer = creator, token::mint = token_mint, token::authority = bond_vault, seeds = [BOND_VAULT_SEED, registry.total_markets.to_le_bytes().as_ref()], bump)]
    pub bond_vault: Account<'info, TokenAccount>,
    pub token_mint: Account<'info, Mint>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SubmitPosition<'info> {
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
pub struct VoteOnOutcome<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut, seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    pub oracle: Signer<'info>,
}

#[derive(Accounts)]
pub struct ChallengeSettlement<'info> {
    #[account(mut, seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [BOND_VAULT_SEED, market.id.to_le_bytes().as_ref()], bump = market.bond_vault_bump)]
    pub bond_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub challenger_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub challenger: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct FinalizeSettlement<'info> {
    #[account(mut, seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
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

#[derive(Accounts)]
pub struct RefundPosition<'info> {
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
