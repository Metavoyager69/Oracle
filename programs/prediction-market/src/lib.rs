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
pub const ORACLE_STAKE_SEED: &[u8] = b"oracle-stake";

// Safety limits and protocol settings.
pub const MIN_STAKE: u64 = 1_000_000;  // Minimum bet amount (1 million lamports).
pub const MIN_CHALLENGE_BOND: u64 = 1_000_000; // Minimum bond to challenge a settlement.
pub const MAX_TITLE_LEN: usize = 128;
pub const MAX_DESC_LEN: usize = 512;
pub const ORACLE_VOTE_THRESHOLD: u8 = 3; // Number of oracles needed to settle.
pub const DEFAULT_CHALLENGE_WINDOW_SECS: i64 = 24 * 60 * 60;
pub const BOND_VAULT_SEED: &[u8] = b"bond-vault";

// [ARCHITECT UPGRADE] - Escape Hatch Timeout (7 days)
pub const LIVENESS_TIMEOUT_SECS: i64 = 7 * 24 * 60 * 60;

// [DATABASE WIZARD OPTIMIZATION] - Optimized account spaces to save Rent SOL.
pub const REGISTRY_SPACE: usize = 8 + 32 + 32 + (32 * 5) + 8 + 8 + 1 + 1; // +1 for version
pub const MARKET_SPACE: usize = 8 + 1200; 
pub const POSITION_SPACE: usize = 8 + 32 + 32 + 64 + 8 + 1 + 1 + 1 + 1; // +1 for version
pub const ORACLE_STAKE_SPACE: usize = 8 + 32 + 8 + 8 + 1 + 1; // +1 for version

/// This structure represents an encrypted message.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq)]
pub struct Ciphertext {
    pub c1: [u8; 32],
    pub c2: [u8; 32],
}

/// [SECURITY UPGRADE P1] - ZK-Stake Proof
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct ZkStakeProof {
    pub commitment: [u8; 32],
    pub blinding_factor: [u8; 32],
    pub amount: u64,
}

/// The Main Registry: Stores global settings.
#[account]
pub struct MarketRegistry {
    pub authority: Pubkey,
    pub arcium_cluster: Pubkey,
    pub oracle_keys: [Pubkey; 5],
    pub required_oracle_stake: u64,
    pub total_markets: u64,
    pub version: u8, // [ARCHITECT UPGRADE] - Account versioning
    pub bump: u8,
}

/// Oracle collateral account used for slashing and lock tracking.
#[account]
pub struct OracleStake {
    pub oracle: Pubkey,
    pub amount: u64,
    pub locked_votes: u64,
    pub version: u8, // [ARCHITECT UPGRADE] - Account versioning
    pub bump: u8,
}

/// A specific Prediction Market.
#[account]
pub struct Market {
    pub id: u64,
    pub creator: Pubkey,
    pub vault: Pubkey,
    pub bond_vault: Pubkey,
    pub arcium_cluster: Pubkey,
    pub resolution_timestamp: i64,
    pub total_yes_stake: u64,
    pub total_no_stake: u64,
    pub title: [u8; 128],
    pub description: [u8; 512],
    pub status: MarketStatus,
    pub outcome: Option<bool>,
    pub challenge_deadline: i64,
    pub challenged: bool,
    pub challenger: Pubkey,
    pub challenge_bond: u64,
    pub challenge_evidence_hash: [u8; 32],
    pub yes_votes: u8,
    pub no_votes: u8,
    pub voters: [Pubkey; 5],
    pub vote_records: [u8; 5],
    pub slashing_executed: bool,
    pub version: u8, // [ARCHITECT UPGRADE] - Account versioning
    pub bump: u8,
    pub vault_bump: u8,
    pub bond_vault_bump: u8,
}

/// The different stages a market can be in.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Default)]
pub enum MarketStatus {
    #[default] Open, SettledPending, Settled, Invalid, Cancelled,
}

/// Authority decision after reviewing a challenged settlement.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum DisputeResolution {
    SettlementUpheld,
    MarketCancelled,
}

/// A user's individual bet (position).
#[account]
pub struct Position {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub encrypted_stake: Ciphertext,
    pub deposited_stake: u64,
    pub claimed: bool,
    pub choice: bool,
    pub version: u8, // [ARCHITECT UPGRADE] - Account versioning
    pub bump: u8,
}

#[error_code]
pub enum PredictionMarketError {
    #[msg("Market is not open")] MarketNotOpen,
    #[msg("ZK Proof invalid")] InvalidZkProof,
    #[msg("Stake too low")] StakeTooLow,
    #[msg("Invalid stake amount")] InvalidStakeAmount,
    #[msg("Unauthorized Oracle")] UnauthorizedOracle,
    #[msg("Oracle already voted")] AlreadyVoted,
    #[msg("Market not settled yet")] MarketNotSettled,
    #[msg("Already claimed")] AlreadyClaimed,
    #[msg("You did not win this bet")] DidNotWin,
    #[msg("Event has already occurred")] EventPassed,
    #[msg("Oracle reported invalid pool totals")] InvalidPoolTotals,
    #[msg("Insufficient staked balance")] InsufficientStakeBalance,
    #[msg("Resolution timestamp must be in the future")] InvalidResolutionTimestamp,
    #[msg("Oracle stake below required threshold")] OracleStakeTooLow,
    #[msg("Oracle stake is locked by unresolved votes")] OracleStakeLocked,
    #[msg("Arithmetic overflow")] ArithmeticOverflow,
    #[msg("Slashing already executed for this market")] SlashingAlreadyExecuted,
    #[msg("Missing oracle stake account")] MissingOracleStakeAccount,
    #[msg("Invalid oracle vote record")] InvalidOracleVoteRecord,
    #[msg("Market outcome not available")] MarketOutcomeMissing,
    #[msg("Only authority can perform this action")] UnauthorizedAuthority,
    #[msg("Challenge window has closed")] ChallengeWindowClosed,
    #[msg("Challenge window still open")] ChallengeWindowOpen,
    #[msg("Settlement already challenged")] SettlementAlreadyChallenged,
    #[msg("Market is not pending settlement")] MarketNotSettledPending,
    #[msg("Market is not invalid")] MarketNotInvalid,
    #[msg("Challenge bond too low")] ChallengeBondTooLow,
    #[msg("Invalid bond token mint")] InvalidBondMint,
    #[msg("Invalid challenger token account")] InvalidChallengerAccount,
}

#[program]
pub mod prediction_market {
    use super::*;

    /// Sets up the protocol.
    pub fn initialize(ctx: Context<Initialize>, arcium_cluster: Pubkey, oracles: [Pubkey; 5]) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        registry.authority = ctx.accounts.authority.key();
        registry.arcium_cluster = arcium_cluster;
        registry.oracle_keys = oracles;
        registry.required_oracle_stake = 0;
        registry.total_markets = 0;
        registry.version = 1; // Current schema version
        registry.bump = ctx.bumps.registry;
        Ok(())
    }

    /// Updates oracle set and required stake threshold.
    pub fn set_oracle_config(
        ctx: Context<SetOracleConfig>,
        oracles: [Pubkey; 5],
        required_oracle_stake: u64,
    ) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        require!(ctx.accounts.authority.key() == registry.authority, PredictionMarketError::UnauthorizedAuthority);
        registry.oracle_keys = oracles;
        registry.required_oracle_stake = required_oracle_stake;
        Ok(())
    }

    /// Creates a new betting market.
    pub fn create_market(ctx: Context<CreateMarket>, title: String, description: String, resolution_timestamp: i64) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;

        require!(resolution_timestamp > clock.unix_timestamp, PredictionMarketError::InvalidResolutionTimestamp);
        
        market.id = registry.total_markets;
        market.creator = ctx.accounts.creator.key();
        market.vault = ctx.accounts.vault.key();
        market.bond_vault = ctx.accounts.bond_vault.key();
        market.arcium_cluster = registry.arcium_cluster;
        market.title = write_fixed_bytes::<128>(&title);
        market.description = write_fixed_bytes::<512>(&description);
        market.resolution_timestamp = resolution_timestamp;
        market.status = MarketStatus::Open;
        market.total_yes_stake = 0;
        market.total_no_stake = 0;
        market.challenge_deadline = 0;
        market.challenged = false;
        market.challenger = Pubkey::default();
        market.challenge_bond = 0;
        market.challenge_evidence_hash = [0u8; 32];
        market.yes_votes = 0;
        market.no_votes = 0;
        market.voters = [Pubkey::default(); 5];
        market.vote_records = [0u8; 5];
        market.slashing_executed = false;
        market.version = 1; // Current schema version
        market.bump = ctx.bumps.market;
        market.vault_bump = ctx.bumps.vault;
        market.bond_vault_bump = ctx.bumps.bond_vault;

        registry.total_markets += 1;
        Ok(())
    }

    /// Users place bets privately using a ZK-Proof.
    pub fn submit_position(ctx: Context<SubmitPosition>, encrypted_stake: Ciphertext, zk_proof: ZkStakeProof, choice: bool) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;

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

        if choice {
            market.total_yes_stake = market.total_yes_stake.checked_add(zk_proof.amount).unwrap();
        } else {
            market.total_no_stake = market.total_no_stake.checked_add(zk_proof.amount).unwrap();
        }

        let position = &mut ctx.accounts.position;
        position.owner = ctx.accounts.user.key();
        position.market = market.key();
        position.encrypted_stake = encrypted_stake;
        position.deposited_stake = zk_proof.amount;
        position.choice = choice;
        position.claimed = false;
        position.version = 1; // Current schema version
        position.bump = ctx.bumps.position;
        Ok(())
    }

    pub fn vote_on_outcome(ctx: Context<VoteOnOutcome>, yes_won: bool, reported_yes_total: u64, reported_no_total: u64) -> Result<()> {
        let registry = &ctx.accounts.registry;
        let market = &mut ctx.accounts.market;
        let stake = &mut ctx.accounts.oracle_stake;
        let clock = Clock::get()?;
        let oracle_key = ctx.accounts.oracle.key();

        require!(reported_yes_total == market.total_yes_stake, PredictionMarketError::InvalidPoolTotals);
        require!(reported_no_total == market.total_no_stake, PredictionMarketError::InvalidPoolTotals);

        let is_valid_oracle = registry.oracle_keys.iter().any(|&k| k == oracle_key);
        require!(is_valid_oracle, PredictionMarketError::UnauthorizedOracle);
        require!(stake.oracle == oracle_key, PredictionMarketError::UnauthorizedOracle);
        require!(stake.amount >= registry.required_oracle_stake, PredictionMarketError::OracleStakeTooLow);
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

        stake.locked_votes = stake.locked_votes.saturating_add(1);

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

        if market.yes_votes >= ORACLE_VOTE_THRESHOLD {
            market.outcome = Some(true);
            market.status = MarketStatus::SettledPending;
        } else if market.no_votes >= ORACLE_VOTE_THRESHOLD {
            market.outcome = Some(false);
            market.status = MarketStatus::SettledPending;
        }
        if market.status == MarketStatus::SettledPending {
            market.challenge_deadline = clock.unix_timestamp + DEFAULT_CHALLENGE_WINDOW_SECS;
            market.challenged = false;
            market.challenger = Pubkey::default();
            market.challenge_bond = 0;
            market.challenge_evidence_hash = [0u8; 32];
        }
        Ok(())
    }

    pub fn challenge_settlement(
        ctx: Context<ChallengeSettlement>,
        evidence_hash: [u8; 32],
        bond_amount: u64,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;

        require!(market.status == MarketStatus::SettledPending, PredictionMarketError::MarketNotSettledPending);
        require!(clock.unix_timestamp <= market.challenge_deadline, PredictionMarketError::ChallengeWindowClosed);
        require!(!market.challenged, PredictionMarketError::SettlementAlreadyChallenged);
        require!(bond_amount >= MIN_CHALLENGE_BOND, PredictionMarketError::ChallengeBondTooLow);
        require!(ctx.accounts.bond_vault.mint == ctx.accounts.challenger_token_account.mint, PredictionMarketError::InvalidBondMint);

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
        market.challenge_bond = bond_amount;
        market.challenge_evidence_hash = evidence_hash;
        Ok(())
    }

    pub fn finalize_settlement(ctx: Context<FinalizeSettlement>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let clock = Clock::get()?;
        require!(market.status == MarketStatus::SettledPending, PredictionMarketError::MarketNotSettledPending);
        require!(!market.challenged, PredictionMarketError::SettlementAlreadyChallenged);
        require!(clock.unix_timestamp > market.challenge_deadline, PredictionMarketError::ChallengeWindowOpen);
        market.status = MarketStatus::Settled;
        Ok(())
    }

    pub fn resolve_dispute(
        ctx: Context<ResolveDispute>,
        resolution: DisputeResolution,
        corrected_outcome: Option<bool>,
    ) -> Result<()> {
        let registry = &ctx.accounts.registry;
        let market = &mut ctx.accounts.market;

        require!(ctx.accounts.authority.key() == registry.authority, PredictionMarketError::UnauthorizedAuthority);
        require!(market.status == MarketStatus::Invalid, PredictionMarketError::MarketNotInvalid);
        require!(market.challenged, PredictionMarketError::SettlementAlreadyChallenged);

        if market.challenge_bond > 0 {
            require!(ctx.accounts.bond_vault.mint == ctx.accounts.treasury.mint, PredictionMarketError::InvalidBondMint);
            require!(ctx.accounts.bond_vault.mint == ctx.accounts.challenger_token_account.mint, PredictionMarketError::InvalidBondMint);
        }

        match resolution {
            DisputeResolution::SettlementUpheld => {
                let outcome = corrected_outcome.ok_or(PredictionMarketError::MarketOutcomeMissing)?;
                market.outcome = Some(outcome);
                market.status = MarketStatus::Settled;
                if market.challenge_bond > 0 {
                    let stake_seeds = &[BOND_VAULT_SEED, market.id.to_le_bytes().as_ref(), &[market.bond_vault_bump]];
                    let signer_seeds = &[&stake_seeds[..]];
                    let cpi_ctx = CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.bond_vault.to_account_info(),
                            to: ctx.accounts.treasury.to_account_info(),
                            authority: ctx.accounts.bond_vault.to_account_info(),
                        },
                        signer_seeds,
                    );
                    token::transfer(cpi_ctx, market.challenge_bond)?;
                }
            }
            DisputeResolution::MarketCancelled => {
                market.outcome = None;
                market.status = MarketStatus::Cancelled;
                if market.challenge_bond > 0 {
                    require!(
                        ctx.accounts.challenger_token_account.owner == market.challenger,
                        PredictionMarketError::InvalidChallengerAccount
                    );
                    let stake_seeds = &[BOND_VAULT_SEED, market.id.to_le_bytes().as_ref(), &[market.bond_vault_bump]];
                    let signer_seeds = &[&stake_seeds[..]];
                    let cpi_ctx = CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.bond_vault.to_account_info(),
                            to: ctx.accounts.challenger_token_account.to_account_info(),
                            authority: ctx.accounts.bond_vault.to_account_info(),
                        },
                        signer_seeds,
                    );
                    token::transfer(cpi_ctx, market.challenge_bond)?;
                }
            }
        }

        market.challenged = false;
        market.challenge_bond = 0;
        market.challenge_deadline = 0;
        market.challenge_evidence_hash = [0u8; 32];
        market.challenger = Pubkey::default();
        Ok(())
    }

    pub fn deposit_oracle_stake(ctx: Context<StakeOracle>, amount: u64) -> Result<()> {
        deposit_oracle_stake_impl(&ctx, amount)
    }

    pub fn withdraw_oracle_stake(ctx: Context<UnstakeOracle>, amount: u64) -> Result<()> {
        withdraw_oracle_stake_impl(&ctx, amount)
    }

    pub fn slash_minority_oracles(ctx: Context<SlashMinorityOracles>, slash_bps: u16) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Settled, PredictionMarketError::MarketNotSettled);
        require!(!market.slashing_executed, PredictionMarketError::SlashingAlreadyExecuted);

        let outcome = market.outcome.ok_or(PredictionMarketError::MarketOutcomeMissing)?;
        let clamped_bps = (slash_bps as u64).min(5_000);

        for (voter, vote_record) in market.voters.iter().zip(market.vote_records.iter()) {
            if *voter == Pubkey::default() {
                continue;
            }
            let vote = match *vote_record {
                1 => true,
                2 => false,
                _ => return Err(PredictionMarketError::InvalidOracleVoteRecord.into()),
            };
            let is_minority = vote != outcome;
            let stake_info = find_oracle_stake_account(ctx.remaining_accounts, *voter)?;
            let mut stake = Account::<OracleStake>::try_from(&stake_info)?;

            if is_minority && clamped_bps > 0 {
                let slash_amount = (stake.amount as u128)
                    .saturating_mul(clamped_bps as u128)
                    .saturating_div(10_000u128);
                if slash_amount > 0 {
                    require!(slash_amount <= u64::MAX as u128, PredictionMarketError::ArithmeticOverflow);
                    let slash_amount = slash_amount as u64;
                    let stake_seeds = &[ORACLE_STAKE_SEED, stake.oracle.as_ref(), &[stake.bump]];
                    invoke_signed(
                        &system_instruction::transfer(
                            &stake_info.key(),
                            &ctx.accounts.treasury.key(),
                            slash_amount,
                        ),
                        &[
                            stake_info.to_account_info(),
                            ctx.accounts.treasury.to_account_info(),
                            ctx.accounts.system_program.to_account_info(),
                        ],
                        &[stake_seeds],
                    )?;
                    stake.amount = stake.amount.saturating_sub(slash_amount);
                }
            }

            if stake.locked_votes > 0 {
                stake.locked_votes = stake.locked_votes.saturating_sub(1);
            }
        }

        market.slashing_executed = true;
        Ok(())
    }

    pub fn claim_winnings(ctx: Context<ClaimWinnings>) -> Result<()> {
        let market = &ctx.accounts.market;
        let position = &mut ctx.accounts.position;

        require!(market.status == MarketStatus::Settled, PredictionMarketError::MarketNotSettled);
        require!(!position.claimed, PredictionMarketError::AlreadyClaimed);

        let market_outcome = market.outcome.unwrap();
        require!(position.choice == market_outcome, PredictionMarketError::DidNotWin);

        let total_pool = market.total_yes_stake as u128 + market.total_no_stake as u128;
        let winning_pool = if market_outcome {
            market.total_yes_stake as u128
        } else {
            market.total_no_stake as u128
        };
        require!(winning_pool > 0, PredictionMarketError::InvalidPoolTotals);

        let payout = (position.deposited_stake as u128)
            .checked_mul(total_pool)
            .ok_or(PredictionMarketError::ArithmeticOverflow)?
            .checked_div(winning_pool)
            .ok_or(PredictionMarketError::ArithmeticOverflow)?;
        require!(payout <= u64::MAX as u128, PredictionMarketError::ArithmeticOverflow);
        let payout = payout as u64;

        position.claimed = true;

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

        Ok(())
    }

    pub fn refund_position(ctx: Context<RefundPosition>) -> Result<()> {
        let market = &ctx.accounts.market;
        let position = &mut ctx.accounts.position;
        let clock = Clock::get()?;

        let is_timed_out = clock.unix_timestamp > market.resolution_timestamp.saturating_add(LIVENESS_TIMEOUT_SECS);
        let is_cancelled = market.status == MarketStatus::Cancelled || market.status == MarketStatus::Invalid;

        require!(
            (is_cancelled || is_timed_out) && !market.challenged,
            PredictionMarketError::MarketNotSettled
        );
        require!(!position.claimed, PredictionMarketError::AlreadyClaimed);

        position.claimed = true;

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
pub struct VoteOnOutcome<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut, seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [ORACLE_STAKE_SEED, oracle.key().as_ref()], bump = oracle_stake.bump)]
    pub oracle_stake: Account<'info, OracleStake>,
    pub oracle: Signer<'info>,
}

#[derive(Accounts)]
pub struct ChallengeSettlement<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
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
pub struct ResolveDispute<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut, seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [BOND_VAULT_SEED, market.id.to_le_bytes().as_ref()], bump = market.bond_vault_bump)]
    pub bond_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub treasury: Account<'info, TokenAccount>,
    #[account(mut)]
    pub challenger_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetOracleConfig<'info> {
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut)]
    pub authority: Signer<'info>,
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
pub struct SlashMinorityOracles<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut, seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub treasury: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
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

fn find_oracle_stake_account<'info>(
    accounts: &'info [AccountInfo<'info>],
    oracle: Pubkey,
) -> Result<AccountInfo<'info>> {
    for account in accounts {
        if account.owner != &crate::ID || !account.is_writable {
            continue;
        }
        if let Ok(stake) = Account::<OracleStake>::try_from(account) {
            if stake.oracle == oracle {
                return Ok(account.clone());
            }
        }
    }
    Err(PredictionMarketError::MissingOracleStakeAccount.into())
}

fn deposit_oracle_stake_impl(ctx: &Context<StakeOracle>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Err(PredictionMarketError::InvalidStakeAmount.into());
    }
    let registry = &ctx.accounts.registry;
    require!(registry.oracle_keys.iter().any(|&k| k == ctx.accounts.oracle.key()), PredictionMarketError::UnauthorizedOracle);

    let stake = &mut ctx.accounts.oracle_stake;
    if stake.amount == 0 {
        stake.oracle = ctx.accounts.oracle.key();
        stake.version = 1;
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

fn withdraw_oracle_stake_impl(ctx: &Context<UnstakeOracle>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Err(PredictionMarketError::InvalidStakeAmount.into());
    }
    let stake = &mut ctx.accounts.oracle_stake;
    require!(stake.oracle == ctx.accounts.oracle.key(), PredictionMarketError::UnauthorizedOracle);
    require!(stake.amount >= amount, PredictionMarketError::InsufficientStakeBalance);
    require!(stake.locked_votes == 0, PredictionMarketError::OracleStakeLocked);

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

fn write_fixed_bytes<const N: usize>(value: &str) -> [u8; N] {
    let mut out = [0u8; N];
    let bytes = value.as_bytes();
    let take = bytes.len().min(N);
    out[..take].copy_from_slice(&bytes[..take]);
    out
}
