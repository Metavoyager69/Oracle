use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("7krCLEf4n4QnLnaLgJQTkQB7bS72PRxbM2dGZLb3oQto");

pub const MARKET_SEED: &[u8]   = b"market";
pub const VAULT_SEED: &[u8]    = b"vault";
pub const POSITION_SEED: &[u8] = b"position";
pub const REGISTRY_SEED: &[u8] = b"registry";
pub const BOND_VAULT_SEED: &[u8] = b"bond-vault";

pub const MIN_STAKE: u64         = 1_000_000;
pub const MIN_CHALLENGE_BOND: u64 = 5_000_000;
pub const ORACLE_VOTE_THRESHOLD: u8 = 3;
pub const CHALLENGE_WINDOW_SECS: i64 = 24 * 60 * 60;
pub const LIVENESS_TIMEOUT_SECS: i64 = 7 * 24 * 60 * 60;

pub const REGISTRY_SPACE: usize = 8 + 32 + 32 + (32 * 5) + 8 + 1 + 1;
pub const MARKET_SPACE: usize = 1200;
pub const POSITION_SPACE: usize = 256;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq)]
pub struct Ciphertext {
    pub c1: [u8; 32],
    pub c2: [u8; 32],
}

#[account]
pub struct MarketRegistry {
    pub authority:      Pubkey,
    pub arcium_cluster: Pubkey,
    pub oracle_keys:    [Pubkey; 5],
    pub total_markets:  u64,
    pub version:        u8,
    pub bump:           u8,
}

#[account]
pub struct Market {
    pub id:                   u64,
    pub creator:              Pubkey,
    pub title:                [u8; 128],
    pub description:          [u8; 512],
    pub resolution_timestamp: i64,
    pub arcium_cluster:       Pubkey,
    pub status:               MarketStatus,
    pub outcome:              Option<bool>,
    pub vault:                Pubkey,
    pub bond_vault:           Pubkey,
    pub encrypted_yes_stake:  Ciphertext,
    pub encrypted_no_stake:   Ciphertext,
    pub revealed_yes_stake:   u64,
    pub revealed_no_stake:    u64,
    pub challenge_deadline:   i64,
    pub challenged:           bool,
    pub challenger:           Pubkey,
    pub challenge_bond:       u64,
    pub yes_votes:            u8,
    pub no_votes:             u8,
    pub voters:               [Pubkey; 5],
    pub vote_records:         [u8; 5],
    pub bump:                 u8,
    pub vault_bump:           u8,
    pub bond_vault_bump:      u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Default, Copy)]
pub enum MarketStatus {
    #[default] Open, SettledPending, Challenged, Settled, Invalid, Cancelled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum DisputeResolution {
    Uphold,
    OverrideYes,
    OverrideNo,
    Cancel,
    Invalid,
}

#[account]
pub struct Position {
    pub owner:            Pubkey,
    pub market:           Pubkey,
    pub encrypted_stake:  Ciphertext,
    pub encrypted_choice: Ciphertext,
    pub stake_commitment: [u8; 32],
    pub submitted_at:     i64,
    pub claimed:          bool,
    pub version:          u8,
    pub bump:             u8,
}

#[error_code]
pub enum PredictionMarketError {
    #[msg("Market not open")] NotOpen,
    #[msg("Mpc pending")] MpcPending,
    #[msg("Stake low")] StakeLow,
    #[msg("Invalid commitment")] BadCommit,
    #[msg("Unauthorized")] Unauthorized,
    #[msg("Overflow")] Overflow,
    #[msg("Timeout")] Timeout,
    #[msg("Invalid market state")] BadState,
    #[msg("Oracle already voted")] DuplicateVote,
}

#[program]
pub mod prediction_market {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, arcium_cluster: Pubkey, oracles: [Pubkey; 5]) -> Result<()> {
        let r = &mut ctx.accounts.registry;
        r.authority = ctx.accounts.authority.key();
        r.arcium_cluster = arcium_cluster;
        r.oracle_keys = oracles;
        r.total_markets = 0;
        r.version = 1;
        r.bump = ctx.bumps.registry;
        Ok(())
    }

    pub fn create_market(ctx: Context<CreateMarket>, title: String, description: String, resolution_timestamp: i64) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        let market = &mut ctx.accounts.market;
        market.id = registry.total_markets;
        market.creator = ctx.accounts.creator.key();
        market.title = write_fixed_bytes::<128>(&title);
        market.description = write_fixed_bytes::<512>(&description);
        market.resolution_timestamp = resolution_timestamp;
        market.status = MarketStatus::Open;
        market.arcium_cluster = registry.arcium_cluster;
        market.vault = ctx.accounts.vault.key();
        market.bond_vault = ctx.accounts.bond_vault.key();
        market.bump = ctx.bumps.market;
        market.vault_bump = ctx.bumps.vault;
        market.bond_vault_bump = ctx.bumps.bond_vault;
        market.encrypted_yes_stake = Ciphertext::default();
        market.encrypted_no_stake = Ciphertext::default();
        market.revealed_yes_stake = 0;
        market.revealed_no_stake = 0;
        market.challenge_deadline = 0;
        market.challenged = false;
        market.challenger = Pubkey::default();
        market.challenge_bond = 0;
        market.yes_votes = 0;
        market.no_votes = 0;
        market.voters = [Pubkey::default(); 5];
        market.vote_records = [0u8; 5];
        registry.total_markets = registry.total_markets.checked_add(1).ok_or(PredictionMarketError::Overflow)?;
        Ok(())
    }

    pub fn submit_position(ctx: Context<SubmitPosition>, encrypted_stake: Ciphertext, encrypted_choice: Ciphertext, amount: u64, commitment: [u8; 32]) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Open, PredictionMarketError::NotOpen);
        require!(amount >= MIN_STAKE, PredictionMarketError::StakeLow);
        token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer { from: ctx.accounts.user_token_account.to_account_info(), to: ctx.accounts.vault.to_account_info(), authority: ctx.accounts.user.to_account_info() }), amount)?;
        let pos = &mut ctx.accounts.position;
        pos.owner = ctx.accounts.user.key();
        pos.market = market.key();
        pos.encrypted_stake = encrypted_stake;
        pos.encrypted_choice = encrypted_choice;
        pos.stake_commitment = commitment;
        pos.submitted_at = Clock::get()?.unix_timestamp;
        pos.claimed = false;
        pos.version = 1;
        pos.bump = ctx.bumps.position;
        Ok(())
    }

    pub fn vote_on_outcome(ctx: Context<VoteOnOutcome>, yes_won: bool) -> Result<()> {
        let registry = &ctx.accounts.registry;
        let market = &mut ctx.accounts.market;
        let oracle_key = ctx.accounts.oracle.key();
        require!(market.status == MarketStatus::Open, PredictionMarketError::NotOpen);
        require!(registry.oracle_keys.iter().any(|&k| k == oracle_key), PredictionMarketError::Unauthorized);
        if market.voters.iter().any(|voter| *voter == oracle_key) {
            return err!(PredictionMarketError::DuplicateVote);
        }
        let mut inserted = false;
        for (idx, voter) in market.voters.iter_mut().enumerate() {
            if *voter == Pubkey::default() {
                *voter = oracle_key;
                market.vote_records[idx] = if yes_won { 1 } else { 2 };
                inserted = true;
                break;
            }
        }
        require!(inserted, PredictionMarketError::Unauthorized);
        let (mut y, mut n) = (0u8, 0u8);
        for v in market.vote_records.iter() {
            if *v == 1 { y += 1; } else if *v == 2 { n += 1; }
        }
        if y >= ORACLE_VOTE_THRESHOLD || n >= ORACLE_VOTE_THRESHOLD {
            market.outcome = Some(y >= ORACLE_VOTE_THRESHOLD);
            market.status = MarketStatus::SettledPending;
            market.challenge_deadline = Clock::get()?.unix_timestamp + CHALLENGE_WINDOW_SECS;
            market.challenged = false;
            market.challenger = Pubkey::default();
            market.challenge_bond = 0;
        }
        Ok(())
    }

    pub fn request_tally(ctx: Context<RequestTally>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(ctx.accounts.authority.key() == ctx.accounts.registry.authority, PredictionMarketError::Unauthorized);
        require!(market.outcome.is_some(), PredictionMarketError::MpcPending);
        require!(
            market.status == MarketStatus::Open || market.status == MarketStatus::SettledPending,
            PredictionMarketError::BadState
        );
        if market.status == MarketStatus::Open {
            market.status = MarketStatus::SettledPending;
        }
        if market.challenge_deadline == 0 {
            market.challenge_deadline = Clock::get()?.unix_timestamp + CHALLENGE_WINDOW_SECS;
        }
        Ok(())
    }

    pub fn reveal_stakes(ctx: Context<RevealStakes>, yes_total: u64, no_total: u64) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(ctx.accounts.authority.key() == ctx.accounts.registry.authority, PredictionMarketError::Unauthorized);
        require!(
            market.status == MarketStatus::SettledPending || market.status == MarketStatus::Challenged,
            PredictionMarketError::BadState
        );
        market.revealed_yes_stake = yes_total;
        market.revealed_no_stake = no_total;
        Ok(())
    }

    pub fn challenge_settlement(ctx: Context<ChallengeSettlement>, bond: u64) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::SettledPending, PredictionMarketError::BadState);
        require!(!market.challenged, PredictionMarketError::Unauthorized);
        require!(Clock::get()?.unix_timestamp < market.challenge_deadline, PredictionMarketError::Timeout);
        require!(bond >= MIN_CHALLENGE_BOND, PredictionMarketError::StakeLow);
        token::transfer(CpiContext::new(ctx.accounts.token_program.to_account_info(), Transfer { from: ctx.accounts.challenger_token_account.to_account_info(), to: ctx.accounts.bond_vault.to_account_info(), authority: ctx.accounts.challenger.to_account_info() }), bond)?;
        market.status = MarketStatus::Challenged;
        market.challenged = true;
        market.challenger = ctx.accounts.challenger.key();
        market.challenge_bond = bond;
        Ok(())
    }

    pub fn finalize_settlement(ctx: Context<FinalizeSettlement>) -> Result<()> {
        complete_settlement(&mut ctx.accounts.market)
    }

    pub fn settle_market(ctx: Context<SettleMarket>) -> Result<()> {
        complete_settlement(&mut ctx.accounts.market)
    }

    pub fn resolve_dispute(ctx: Context<ResolveDispute>, resolution: DisputeResolution) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(ctx.accounts.authority.key() == ctx.accounts.registry.authority, PredictionMarketError::Unauthorized);
        require!(market.status == MarketStatus::Challenged, PredictionMarketError::BadState);

        let bond_amount = market.challenge_bond;
        if bond_amount > 0 {
            let market_id_bytes = market.id.to_le_bytes();
            let seeds = &[BOND_VAULT_SEED, market_id_bytes.as_ref(), &[market.bond_vault_bump]];
            let destination = match resolution {
                DisputeResolution::Uphold => &ctx.accounts.authority_token_account,
                DisputeResolution::OverrideYes => &ctx.accounts.challenger_token_account,
                DisputeResolution::OverrideNo => &ctx.accounts.challenger_token_account,
                DisputeResolution::Cancel => &ctx.accounts.challenger_token_account,
                DisputeResolution::Invalid => &ctx.accounts.challenger_token_account,
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.bond_vault.to_account_info(),
                        to: destination.to_account_info(),
                        authority: ctx.accounts.bond_vault.to_account_info(),
                    },
                    &[&seeds[..]],
                ),
                bond_amount,
            )?;
        }

        match resolution {
            DisputeResolution::Uphold => {
                require!(market.outcome.is_some(), PredictionMarketError::MpcPending);
                market.status = MarketStatus::Settled;
            }
            DisputeResolution::OverrideYes => {
                market.outcome = Some(true);
                market.status = MarketStatus::Settled;
            }
            DisputeResolution::OverrideNo => {
                market.outcome = Some(false);
                market.status = MarketStatus::Settled;
            }
            DisputeResolution::Cancel => {
                market.outcome = None;
                market.status = MarketStatus::Cancelled;
            }
            DisputeResolution::Invalid => {
                market.outcome = None;
                market.status = MarketStatus::Invalid;
            }
        }

        market.challenged = false;
        market.challenge_bond = 0;
        market.challenger = Pubkey::default();
        Ok(())
    }

    pub fn claim_winnings(ctx: Context<ClaimWinnings>, stake: u64, choice: bool, nonce: [u8; 32]) -> Result<()> {
        let market = &ctx.accounts.market;
        let pos = &mut ctx.accounts.position;
        require!(market.status == MarketStatus::Settled, PredictionMarketError::MpcPending);
        require!(!pos.claimed, PredictionMarketError::Unauthorized);
        let mut preimage = [0u8; 40];
        preimage[..8].copy_from_slice(&stake.to_le_bytes());
        preimage[8..].copy_from_slice(&nonce);
        require!(hashv(&[&preimage]).to_bytes() == pos.stake_commitment, PredictionMarketError::BadCommit);
        let outcome = market.outcome.ok_or(PredictionMarketError::MpcPending)?;
        require!(choice == outcome, PredictionMarketError::Unauthorized);
        let total = market.revealed_yes_stake.checked_add(market.revealed_no_stake).ok_or(PredictionMarketError::Overflow)?;
        let win_pool = if outcome { market.revealed_yes_stake } else { market.revealed_no_stake };
        require!(win_pool > 0, PredictionMarketError::MpcPending);
        let payout = (stake as u128).checked_mul(total as u128).ok_or(PredictionMarketError::Overflow)?.checked_div(win_pool as u128).ok_or(PredictionMarketError::Overflow)? as u64;
        let market_id_bytes = market.id.to_le_bytes();
        let seeds = &[VAULT_SEED, market_id_bytes.as_ref(), &[market.vault_bump]];
        token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer { from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.user_token_account.to_account_info(), authority: ctx.accounts.vault.to_account_info() }, &[&seeds[..]]), payout)?;
        pos.claimed = true;
        Ok(())
    }

    pub fn refund_position(ctx: Context<RefundPosition>, stake: u64, nonce: [u8; 32]) -> Result<()> {
        let market = &ctx.accounts.market;
        let pos = &mut ctx.accounts.position;
        let clock = Clock::get()?;
        let timed_out = clock.unix_timestamp > market.resolution_timestamp + LIVENESS_TIMEOUT_SECS;
        let allowed_timeout = timed_out
            && (market.status == MarketStatus::Open
                || market.status == MarketStatus::SettledPending
                || market.status == MarketStatus::Challenged);
        require!(
            allowed_timeout || market.status == MarketStatus::Cancelled || market.status == MarketStatus::Invalid,
            PredictionMarketError::Timeout
        );
        let mut preimage = [0u8; 40];
        preimage[..8].copy_from_slice(&stake.to_le_bytes());
        preimage[8..].copy_from_slice(&nonce);
        require!(hashv(&[&preimage]).to_bytes() == pos.stake_commitment, PredictionMarketError::BadCommit);
        let market_id_bytes = market.id.to_le_bytes();
        let seeds = &[VAULT_SEED, market_id_bytes.as_ref(), &[market.vault_bump]];
        token::transfer(CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Transfer { from: ctx.accounts.vault.to_account_info(), to: ctx.accounts.user_token_account.to_account_info(), authority: ctx.accounts.vault.to_account_info() }, &[&seeds[..]]), stake)?;
        pos.claimed = true;
        Ok(())
    }
}

fn complete_settlement(market: &mut Market) -> Result<()> {
    require!(market.status == MarketStatus::SettledPending, PredictionMarketError::BadState);
    require!(market.outcome.is_some(), PredictionMarketError::MpcPending);
    require!(Clock::get()?.unix_timestamp > market.challenge_deadline, PredictionMarketError::Timeout);
    require!(!market.challenged, PredictionMarketError::Unauthorized);
    market.status = MarketStatus::Settled;
    Ok(())
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
pub struct RevealStakes<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut, seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RequestTally<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut, seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub authority: Signer<'info>,
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
pub struct SettleMarket<'info> {
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
    #[account(mut, constraint = challenger_token_account.owner == market.challenger)]
    pub challenger_token_account: Account<'info, TokenAccount>,
    #[account(mut, constraint = authority_token_account.owner == authority.key())]
    pub authority_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
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
