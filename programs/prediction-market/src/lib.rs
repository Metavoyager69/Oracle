use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, program::invoke_signed, system_instruction};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("PredMkt1111111111111111111111111111111111111");

// Seeds are short labels used to derive deterministic account addresses (PDAs).
pub const MARKET_SEED: &[u8] = b"market";
pub const VAULT_SEED: &[u8] = b"vault";
pub const POSITION_SEED: &[u8] = b"position";
pub const REGISTRY_SEED: &[u8] = b"registry";
pub const ORACLE_STAKE_SEED: &[u8] = b"oracle-stake";

pub const DEFAULT_CHALLENGE_WINDOW_SECS: i64 = 24 * 60 * 60;

// Minimum stake is expressed in the smallest unit (lamports) for SPL tokens.
pub const MIN_STAKE: u64 = 1_000_000;
pub const REGISTRY_SPACE: usize = 8 + 512;
pub const MARKET_SPACE: usize = 8 + 4096;
pub const POSITION_SPACE: usize = 8 + 512;
pub const ORACLE_STAKE_SPACE: usize = 8 + 64;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq)]
pub struct Ciphertext {
    pub c1: [u8; 32],
    pub c2: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct SettlementArtifacts {
    pub settlement_hash: [u8; 32],
    pub proof_hash: [u8; 32],
    pub proof_uri: [u8; 96],
    pub settled_at: i64,
    pub challenge_deadline: i64,
    pub challenged: bool,
    pub challenger: Pubkey,
    pub challenge_reason_code: u8,
}

#[account]
pub struct MarketRegistry {
    // Protocol owner / admin key.
    pub authority: Pubkey,
    // Arcium cluster public key (MPC / privacy layer).
    pub arcium_cluster: Pubkey,
    // Fixed set of oracles that can vote on settlement.
    pub oracle_keys: [Pubkey; 5],
    pub oracle_min_stake: u64,
    pub total_markets: u64,
    pub bump: u8,
}

#[account]
pub struct OracleStake {
    pub oracle: Pubkey,
    pub amount: u64,
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
    // UNIX timestamp when the market closes (event start).
    pub resolution_timestamp: i64,
    pub status: MarketStatus,
    pub outcome: Option<bool>,
    // Vault that holds pooled funds for this market.
    pub vault: Pubkey,
    // Total stake deposited across all positions (encrypted until reveal).
    pub total_stake: u64,
    pub total_yes_stake: u64,
    pub total_no_stake: u64,
    pub yes_votes: u8,
    pub no_votes: u8,
    pub voters: [Pubkey; 5],
    // 0 = unset, 1 = yes, 2 = no (indexed to voters array).
    pub vote_records: [u8; 5],
    pub tally_requested_at: i64,
    pub settled_by: Pubkey,
    pub artifacts: SettlementArtifacts,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Default)]
pub enum MarketStatus {
    #[default]
    Open,
    Resolving,
    SettledPending,
    Settled,
    Invalid,
    Cancelled,
}

#[account]
pub struct Position {
    // User position in a specific market (one per user/market).
    pub owner: Pubkey,
    pub market: Pubkey,
    pub deposited_stake: u64,
    pub encrypted_stake: Ciphertext,
    pub encrypted_choice: Ciphertext,
    pub revealed_choice: Option<bool>,
    pub claimed: bool,
    pub bump: u8,
}

#[error_code]
pub enum PredictionMarketError {
    #[msg("Market is not open")] MarketNotOpen,
    #[msg("Stake too low")] StakeTooLow,
    #[msg("Unauthorized Oracle")] UnauthorizedOracle,
    #[msg("Oracle already voted")] AlreadyVoted,
    #[msg("Market not settled yet")] MarketNotSettled,
    #[msg("Already claimed")] AlreadyClaimed,
    #[msg("You did not win this bet")] DidNotWin,
    #[msg("Market already settled")] AlreadySettled,
    #[msg("Event has already occurred")] EventPassed,
    #[msg("Resolution timestamp must be in the future")] InvalidResolutionTimestamp,
    #[msg("Resolution window not open")] ResolutionWindowNotOpen,
    #[msg("Tally not requested")] TallyNotRequested,
    #[msg("Challenge window has closed")] ChallengeWindowClosed,
    #[msg("Settlement already challenged")] SettlementAlreadyChallenged,
    #[msg("Evidence hash matches settlement hash")] InvalidSettlementHash,
    #[msg("Position has not been revealed")] PositionNotRevealed,
    #[msg("Invalid stake amount")] InvalidStakeAmount,
    #[msg("Insufficient staked balance")] InsufficientStakeBalance,
    #[msg("Only authority can perform this action")] UnauthorizedAuthority,
    #[msg("Arithmetic overflow")] ArithmeticOverflow,
}

#[program]
pub mod prediction_market {
    use super::*;

    // One-time setup: registers the protocol authority and oracle set.
    pub fn initialize(ctx: Context<Initialize>, arcium_cluster: Pubkey) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        registry.authority = ctx.accounts.authority.key();
        registry.arcium_cluster = arcium_cluster;
        registry.oracle_keys = [ctx.accounts.authority.key(); 5];
        registry.oracle_min_stake = 0;
        registry.total_markets = 0;
        registry.bump = ctx.bumps.registry;
        Ok(())
    }

    // Updates the oracle set and minimum stake requirement.
    pub fn set_oracles(ctx: Context<SetOracles>, oracles: [Pubkey; 5], min_stake: u64) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        require!(
            ctx.accounts.authority.key() == registry.authority,
            PredictionMarketError::UnauthorizedAuthority
        );
        registry.oracle_keys = oracles;
        registry.oracle_min_stake = min_stake;
        Ok(())
    }

    // Creates a new prediction market and allocates its vault.
    pub fn create_market(
        ctx: Context<CreateMarket>,
        title: String,
        description: String,
        resolution_timestamp: i64,
    ) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;

        require!(
            resolution_timestamp > clock.unix_timestamp,
            PredictionMarketError::InvalidResolutionTimestamp
        );

        market.id = registry.total_markets;
        market.creator = ctx.accounts.creator.key();
        market.title = write_fixed_bytes::<128>(&title);
        market.description = write_fixed_bytes::<512>(&description);
        market.resolution_timestamp = resolution_timestamp;
        market.status = MarketStatus::Open;
        market.outcome = None;
        market.total_stake = 0;
        market.total_yes_stake = 0;
        market.total_no_stake = 0;
        market.yes_votes = 0;
        market.no_votes = 0;
        market.voters = [Pubkey::default(); 5];
        market.vote_records = [0u8; 5];
        market.tally_requested_at = 0;
        market.settled_by = Pubkey::default();
        market.artifacts = SettlementArtifacts::default();
        market.bump = ctx.bumps.market;
        market.vault_bump = ctx.bumps.vault;

        registry.total_markets = registry.total_markets.saturating_add(1);
        Ok(())
    }

    // User submits a position. Stake is transferred into the vault.
    pub fn submit_position(
        ctx: Context<SubmitPosition>,
        encrypted_stake: Ciphertext,
        encrypted_choice: Ciphertext,
        amount: u64,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;

        require!(clock.unix_timestamp < market.resolution_timestamp, PredictionMarketError::EventPassed);
        require!(market.status == MarketStatus::Open, PredictionMarketError::MarketNotOpen);
        require!(amount >= MIN_STAKE, PredictionMarketError::StakeTooLow);

        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, amount)?;

        market.total_stake = market.total_stake.saturating_add(amount);

        let position = &mut ctx.accounts.position;
        position.owner = ctx.accounts.user.key();
        position.market = market.key();
        position.deposited_stake = amount;
        position.encrypted_stake = encrypted_stake;
        position.encrypted_choice = encrypted_choice;
        position.revealed_choice = None;
        position.claimed = false;
        position.bump = ctx.bumps.position;
        Ok(())
    }

    // After resolution time, anyone can request a tally.
    pub fn request_tally(ctx: Context<RequestTally>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;
        require!(market.status == MarketStatus::Open, PredictionMarketError::MarketNotOpen);
        require!(
            clock.unix_timestamp >= market.resolution_timestamp,
            PredictionMarketError::ResolutionWindowNotOpen
        );
        market.status = MarketStatus::Resolving;
        market.tally_requested_at = clock.unix_timestamp;
        Ok(())
    }

    // Writes settlement totals and artifacts, then opens the challenge window.
    pub fn settle_market(
        ctx: Context<SettleMarket>,
        yes_total: u64,
        no_total: u64,
        outcome: bool,
        settlement_hash: [u8; 32],
        proof_hash: [u8; 32],
        proof_uri: String,
    ) -> Result<()> {
        let registry = &ctx.accounts.registry;
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;

        require!(market.status == MarketStatus::Resolving, PredictionMarketError::TallyNotRequested);
        require!(market.tally_requested_at > 0, PredictionMarketError::TallyNotRequested);
        require!(is_oracle(registry, ctx.accounts.authority.key()), PredictionMarketError::UnauthorizedOracle);

        market.total_yes_stake = yes_total;
        market.total_no_stake = no_total;
        market.outcome = Some(outcome);
        market.status = MarketStatus::SettledPending;
        market.settled_by = ctx.accounts.authority.key();
        market.artifacts = SettlementArtifacts {
            settlement_hash,
            proof_hash,
            proof_uri: write_fixed_bytes::<96>(&proof_uri),
            settled_at: clock.unix_timestamp,
            challenge_deadline: clock.unix_timestamp + DEFAULT_CHALLENGE_WINDOW_SECS,
            challenged: false,
            challenger: Pubkey::default(),
            challenge_reason_code: 0,
        };
        Ok(())
    }

    // Challenger submits evidence hash during the dispute window to invalidate settlement.
    pub fn challenge_settlement(
        ctx: Context<ChallengeSettlement>,
        evidence_hash: [u8; 32],
        reason_code: u8,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;
        require!(market.status == MarketStatus::SettledPending, PredictionMarketError::MarketNotSettled);
        require!(clock.unix_timestamp <= market.artifacts.challenge_deadline, PredictionMarketError::ChallengeWindowClosed);
        require!(!market.artifacts.challenged, PredictionMarketError::SettlementAlreadyChallenged);
        require!(evidence_hash != market.artifacts.settlement_hash, PredictionMarketError::InvalidSettlementHash);

        market.status = MarketStatus::Invalid;
        market.outcome = None;
        market.artifacts.challenged = true;
        market.artifacts.challenger = ctx.accounts.challenger.key();
        market.artifacts.challenge_reason_code = reason_code;
        Ok(())
    }

    // Finalizes settlement after the dispute window closes.
    pub fn finalize_settlement(ctx: Context<FinalizeSettlement>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;
        require!(market.status == MarketStatus::SettledPending, PredictionMarketError::MarketNotSettled);
        require!(clock.unix_timestamp > market.artifacts.challenge_deadline, PredictionMarketError::ChallengeWindowClosed);
        require!(!market.artifacts.challenged, PredictionMarketError::SettlementAlreadyChallenged);
        market.status = MarketStatus::Settled;
        Ok(())
    }

    // Reveals the decrypted position choice after settlement.
    pub fn reveal_position(ctx: Context<RevealPosition>, revealed_choice: bool) -> Result<()> {
        let market = &ctx.accounts.market;
        require!(market.status == MarketStatus::Settled, PredictionMarketError::MarketNotSettled);
        let position = &mut ctx.accounts.position;
        position.revealed_choice = Some(revealed_choice);
        Ok(())
    }

    // Winning users claim their payout from the vault.
    pub fn claim_winnings(ctx: Context<ClaimWinnings>) -> Result<()> {
        let market = &ctx.accounts.market;
        let position = &mut ctx.accounts.position;

        require!(market.status == MarketStatus::Settled, PredictionMarketError::MarketNotSettled);
        require!(!position.claimed, PredictionMarketError::AlreadyClaimed);

        let revealed_choice = position.revealed_choice.ok_or(PredictionMarketError::PositionNotRevealed)?;
        let market_outcome = market.outcome.unwrap_or(false);
        require!(revealed_choice == market_outcome, PredictionMarketError::DidNotWin);

        // Parimutuel payout logic: payout = (user_stake / winning_pool) * total_pool
        let total_pool = market.total_yes_stake as u128 + market.total_no_stake as u128;
        let winning_pool = if market_outcome {
            market.total_yes_stake as u128
        } else {
            market.total_no_stake as u128
        };
        require!(winning_pool > 0, PredictionMarketError::MarketNotSettled);

        let payout = (position.deposited_stake as u128)
            .checked_mul(total_pool)
            .ok_or(PredictionMarketError::ArithmeticOverflow)?
            .checked_div(winning_pool)
            .ok_or(PredictionMarketError::ArithmeticOverflow)?;
        require!(payout <= u64::MAX as u128, PredictionMarketError::ArithmeticOverflow);
        let payout = payout as u64;

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

    // Oracle stakes SOL to be eligible for slashing on invalid settlements.
    pub fn stake_oracle(ctx: Context<StakeOracle>, amount: u64) -> Result<()> {
        if amount == 0 {
            return Err(PredictionMarketError::InvalidStakeAmount.into());
        }
        let registry = &ctx.accounts.registry;
        require!(is_oracle(registry, ctx.accounts.oracle.key()), PredictionMarketError::UnauthorizedOracle);

        let stake = &mut ctx.accounts.oracle_stake;
        if stake.amount == 0 {
            stake.oracle = ctx.accounts.oracle.key();
            stake.bump = ctx.bumps.oracle_stake;
        }
        require!(stake.oracle == ctx.accounts.oracle.key(), PredictionMarketError::UnauthorizedOracle);

        invoke(
            &system_instruction::transfer(
                &ctx.accounts.oracle.key(),
                &ctx.accounts.oracle_stake.key(),
                amount,
            ),
            &[
                ctx.accounts.oracle.to_account_info(),
                ctx.accounts.oracle_stake.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        stake.amount = stake.amount.saturating_add(amount);
        Ok(())
    }

    // Oracle withdraws staked SOL (maintaining rent exemption).
    pub fn unstake_oracle(ctx: Context<UnstakeOracle>, amount: u64) -> Result<()> {
        if amount == 0 {
            return Err(PredictionMarketError::InvalidStakeAmount.into());
        }
        let stake = &mut ctx.accounts.oracle_stake;
        require!(stake.oracle == ctx.accounts.oracle.key(), PredictionMarketError::UnauthorizedOracle);
        require!(stake.amount >= amount, PredictionMarketError::InsufficientStakeBalance);

        let rent = Rent::get()?;
        let min_balance = rent.minimum_balance(ORACLE_STAKE_SPACE);
        let available = ctx
            .accounts
            .oracle_stake
            .to_account_info()
            .lamports()
            .saturating_sub(min_balance);
        require!(available >= amount, PredictionMarketError::InsufficientStakeBalance);

        let stake_seeds = &[ORACLE_STAKE_SEED, ctx.accounts.oracle.key().as_ref(), &[stake.bump]];
        invoke_signed(
            &system_instruction::transfer(
                &ctx.accounts.oracle_stake.key(),
                &ctx.accounts.oracle.key(),
                amount,
            ),
            &[
                ctx.accounts.oracle_stake.to_account_info(),
                ctx.accounts.oracle.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[stake_seeds],
        )?;

        stake.amount = stake.amount.saturating_sub(amount);
        Ok(())
    }

    // Authority applies slashing after an invalid settlement.
    pub fn slash_oracle(ctx: Context<SlashOracle>, slash_bps: u16) -> Result<()> {
        let registry = &ctx.accounts.registry;
        require!(
            ctx.accounts.authority.key() == registry.authority,
            PredictionMarketError::UnauthorizedAuthority
        );
        let stake = &mut ctx.accounts.oracle_stake;
        let clamped_bps = slash_bps.min(5_000).max(50) as u64;
        let slash_amount = (stake.amount as u128)
            .saturating_mul(clamped_bps as u128)
            .saturating_div(10_000u128);
        require!(slash_amount <= u64::MAX as u128, PredictionMarketError::ArithmeticOverflow);
        let slash_amount = slash_amount as u64;
        require!(slash_amount > 0, PredictionMarketError::InsufficientStakeBalance);

        let stake_seeds = &[ORACLE_STAKE_SEED, stake.oracle.as_ref(), &[stake.bump]];
        invoke_signed(
            &system_instruction::transfer(
                &ctx.accounts.oracle_stake.key(),
                &ctx.accounts.beneficiary.key(),
                slash_amount,
            ),
            &[
                ctx.accounts.oracle_stake.to_account_info(),
                ctx.accounts.beneficiary.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[stake_seeds],
        )?;

        stake.amount = stake.amount.saturating_sub(slash_amount);
        Ok(())
    }

    // Legacy oracle voting path (kept for compatibility).
    pub fn vote_on_outcome(ctx: Context<SettleMarket>, yes_won: bool) -> Result<()> {
        let registry = &ctx.accounts.registry;
        let market = &mut ctx.accounts.market;

        require!(market.status == MarketStatus::Open, PredictionMarketError::AlreadySettled);
        require!(is_oracle(registry, ctx.accounts.authority.key()), PredictionMarketError::UnauthorizedOracle);

        let oracle_key = ctx.accounts.authority.key();
        require!(!market.voters.iter().any(|&k| k == oracle_key), PredictionMarketError::AlreadyVoted);

        let mut inserted = false;
        for (idx, voter) in market.voters.iter_mut().enumerate() {
            if *voter == Pubkey::default() {
                *voter = oracle_key;
                market.vote_records[idx] = if yes_won { 1 } else { 2 };
                inserted = true;
                break;
            }
        }
        require!(inserted, PredictionMarketError::AlreadyVoted);

        let mut yes_votes = 0u8;
        let mut no_votes = 0u8;
        for vote in market.vote_records.iter() {
            if *vote == 1 {
                yes_votes = yes_votes.saturating_add(1);
            } else if *vote == 2 {
                no_votes = no_votes.saturating_add(1);
            }
        }
        market.yes_votes = yes_votes;
        market.no_votes = no_votes;

        if market.yes_votes >= 3 || market.no_votes >= 3 {
            market.status = MarketStatus::SettledPending;
            market.outcome = Some(market.yes_votes >= 3);
            market.artifacts.challenge_deadline = Clock::get()?.unix_timestamp + DEFAULT_CHALLENGE_WINDOW_SECS;
        }

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
pub struct SetOracles<'info> {
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut)]
    pub authority: Signer<'info>,
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
pub struct RequestTally<'info> {
    #[account(mut, seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut, seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ChallengeSettlement<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut, seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    pub challenger: Signer<'info>,
}

#[derive(Accounts)]
pub struct FinalizeSettlement<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut, seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RevealPosition<'info> {
    #[account(seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [POSITION_SEED, market.key().as_ref(), user.key().as_ref()], bump = position.bump)]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub user: Signer<'info>,
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
pub struct StakeOracle<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(
        init_if_needed,
        payer = oracle,
        space = ORACLE_STAKE_SPACE,
        seeds = [ORACLE_STAKE_SEED, oracle.key().as_ref()],
        bump
    )]
    pub oracle_stake: Account<'info, OracleStake>,
    #[account(mut)]
    pub oracle: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct UnstakeOracle<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut, seeds = [ORACLE_STAKE_SEED, oracle.key().as_ref()], bump = oracle_stake.bump)]
    pub oracle_stake: Account<'info, OracleStake>,
    #[account(mut)]
    pub oracle: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SlashOracle<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut, seeds = [ORACLE_STAKE_SEED, oracle_stake.oracle.as_ref()], bump = oracle_stake.bump)]
    pub oracle_stake: Account<'info, OracleStake>,
    #[account(mut)]
    pub beneficiary: SystemAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

fn is_oracle(registry: &MarketRegistry, oracle_key: Pubkey) -> bool {
    registry.oracle_keys.iter().any(|&k| k == oracle_key)
}

fn write_fixed_bytes<const N: usize>(value: &str) -> [u8; N] {
    let mut out = [0u8; N];
    let bytes = value.as_bytes();
    let take = bytes.len().min(N);
    out[..take].copy_from_slice(&bytes[..take]);
    out
}
