use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("PredMkt1111111111111111111111111111111111111");

pub const MARKET_SEED: &[u8] = b"market";
pub const VAULT_SEED: &[u8] = b"vault";
pub const POSITION_SEED: &[u8] = b"position";
pub const REGISTRY_SEED: &[u8] = b"registry";

pub const PROTOCOL_FEE_BPS: u64 = 100;
pub const SLASH_BPS: u64 = 500;
pub const MIN_STAKE: u64 = 1_000_000;
pub const MAX_TITLE_LEN: usize = 128;
pub const MAX_DESC_LEN: usize = 512;
pub const MAX_PROOF_URI_LEN: usize = 128;
pub const CHALLENGE_WINDOW_SECONDS: i64 = 30 * 60;

pub const REGISTRY_SPACE: usize = 8 + 128;
pub const MARKET_SPACE: usize = 8 + 4096;
pub const POSITION_SPACE: usize = 8 + 256;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq)]
pub struct Ciphertext {
    pub c1: [u8; 32],
    pub c2: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct ArciumComputeTicket {
    pub nonce: [u8; 32],
    pub cluster_id: Pubkey,
    pub submitted_slot: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct SettlementArtifacts {
    pub mpc_job_id: [u8; 32],
    pub proof_hash: [u8; 32],
    pub proof_uri: [u8; 128],
    pub settlement_hash: [u8; 32],
    pub submitted_slot: u64,
    pub challenge_deadline: i64,
    pub challenged: bool,
    pub challenged_by: Pubkey,
    pub challenge_reason: u8,
    pub slash_amount: u64,
}

#[account]
pub struct MarketRegistry {
    pub authority: Pubkey,
    pub arcium_cluster: Pubkey,
    pub total_markets: u64,
    pub total_volume: u64,
    pub invalid_markets: u64,
    pub settlement_challenges: u64,
    pub slash_events: u64,
    pub bump: u8,
}

#[account]
pub struct Market {
    pub id: u64,
    pub creator: Pubkey,
    pub title: [u8; 128],
    pub description: [u8; 512],
    pub resolution_timestamp: i64,
    pub created_at: i64,
    pub arcium_cluster: Pubkey,
    pub encrypted_yes_stake: Ciphertext,
    pub encrypted_no_stake: Ciphertext,
    pub revealed_yes_stake: u64,
    pub revealed_no_stake: u64,
    pub tally_ticket: ArciumComputeTicket,
    pub total_participants: u32,
    pub status: MarketStatus,
    pub outcome: Option<bool>,
    pub encrypted_resolution: Ciphertext,
    pub vault: Pubkey,
    pub token_mint: Pubkey,
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
    Cancelled,
    Invalid,
}

#[account]
pub struct Position {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub encrypted_stake: Ciphertext,
    pub encrypted_choice: Ciphertext,
    pub deposited_stake: u64,
    pub revealed_stake: u64,
    pub revealed_choice: Option<bool>,
    pub submitted_at: i64,
    pub claimed: bool,
    pub bump: u8,
}

#[error_code]
pub enum PredictionMarketError {
    #[msg("Market is not currently open for positions")]
    MarketNotOpen,
    #[msg("Market resolution timestamp has not passed yet")]
    MarketNotExpired,
    #[msg("Arcium MPC computation still pending; market not yet settled")]
    MpcStillPending,
    #[msg("Position already claimed")]
    AlreadyClaimed,
    #[msg("Position did not win")]
    PositionDidNotWin,
    #[msg("Position has not been revealed by Arcium yet")]
    PositionNotRevealed,
    #[msg("Stake amount below minimum")]
    StakeTooLow,
    #[msg("Title exceeds 128 bytes")]
    TitleTooLong,
    #[msg("Description exceeds 512 bytes")]
    DescTooLong,
    #[msg("Caller is not the protocol authority")]
    Unauthorized,
    #[msg("Resolution timestamp must be in the future")]
    InvalidResolutionTime,
    #[msg("Winning pool is empty")]
    WinningPoolEmpty,
    #[msg("Invalid proof URI length")]
    InvalidProofUri,
    #[msg("Market is not in a challengeable settlement state")]
    MarketNotChallengeable,
    #[msg("Challenge window has closed")]
    ChallengeWindowClosed,
    #[msg("Settlement was already challenged")]
    SettlementAlreadyChallenged,
    #[msg("Challenge evidence does not prove invalid settlement")]
    InvalidChallengeEvidence,
    #[msg("Settlement is not finalizable yet")]
    SettlementNotFinalizable,
    #[msg("Market is not refundable")]
    MarketNotRefundable,
}

#[program]
pub mod prediction_market {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, arcium_cluster: Pubkey) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        registry.authority = ctx.accounts.authority.key();
        registry.arcium_cluster = arcium_cluster;
        registry.total_markets = 0;
        registry.total_volume = 0;
        registry.invalid_markets = 0;
        registry.settlement_challenges = 0;
        registry.slash_events = 0;
        registry.bump = ctx.bumps.registry;
        Ok(())
    }

    pub fn create_market(
        ctx: Context<CreateMarket>,
        title: String,
        description: String,
        resolution_timestamp: i64,
    ) -> Result<()> {
        require!(title.len() <= MAX_TITLE_LEN, PredictionMarketError::TitleTooLong);
        require!(description.len() <= MAX_DESC_LEN, PredictionMarketError::DescTooLong);

        let clock = Clock::get()?;
        require!(
            resolution_timestamp > clock.unix_timestamp,
            PredictionMarketError::InvalidResolutionTime
        );

        let registry = &mut ctx.accounts.registry;
        let market = &mut ctx.accounts.market;

        market.id = registry.total_markets;
        market.creator = ctx.accounts.creator.key();
        market.title = write_fixed_bytes::<128>(&title);
        market.description = write_fixed_bytes::<512>(&description);
        market.resolution_timestamp = resolution_timestamp;
        market.created_at = clock.unix_timestamp;
        market.arcium_cluster = registry.arcium_cluster;
        market.encrypted_yes_stake = Ciphertext::default();
        market.encrypted_no_stake = Ciphertext::default();
        market.revealed_yes_stake = 0;
        market.revealed_no_stake = 0;
        market.tally_ticket = ArciumComputeTicket::default();
        market.total_participants = 0;
        market.status = MarketStatus::Open;
        market.outcome = None;
        market.encrypted_resolution = Ciphertext::default();
        market.vault = ctx.accounts.vault.key();
        market.token_mint = ctx.accounts.token_mint.key();
        market.artifacts = SettlementArtifacts::default();
        market.bump = ctx.bumps.market;
        market.vault_bump = ctx.bumps.vault;

        registry.total_markets = registry.total_markets.saturating_add(1);

        Ok(())
    }

    pub fn submit_position(
        ctx: Context<SubmitPosition>,
        encrypted_stake: Ciphertext,
        encrypted_choice: Ciphertext,
        plaintext_stake_lamports: u64,
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Open, PredictionMarketError::MarketNotOpen);
        require!(plaintext_stake_lamports >= MIN_STAKE, PredictionMarketError::StakeTooLow);

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp < market.resolution_timestamp,
            PredictionMarketError::MarketNotOpen
        );

        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, plaintext_stake_lamports)?;

        let position = &mut ctx.accounts.position;
        position.owner = ctx.accounts.user.key();
        position.market = market.key();
        position.encrypted_stake = encrypted_stake;
        position.encrypted_choice = encrypted_choice;
        position.deposited_stake = plaintext_stake_lamports;
        position.revealed_stake = 0;
        position.revealed_choice = None;
        position.submitted_at = clock.unix_timestamp;
        position.claimed = false;
        position.bump = ctx.bumps.position;

        market.total_participants = market.total_participants.saturating_add(1);
        ctx.accounts.registry.total_volume = ctx
            .accounts
            .registry
            .total_volume
            .saturating_add(plaintext_stake_lamports);

        emit!(PositionSubmitted {
            market: market.key(),
            participant: ctx.accounts.user.key(),
            slot: clock.slot,
        });

        Ok(())
    }

    pub fn request_tally(ctx: Context<RequestTally>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Open, PredictionMarketError::MarketNotOpen);

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= market.resolution_timestamp,
            PredictionMarketError::MarketNotExpired
        );

        market.status = MarketStatus::Resolving;

        let mut nonce = [0u8; 32];
        nonce[..8].copy_from_slice(&market.id.to_le_bytes());
        nonce[8..16].copy_from_slice(&clock.slot.to_le_bytes());
        nonce[16..24].copy_from_slice(&clock.unix_timestamp.to_le_bytes());

        market.tally_ticket = ArciumComputeTicket {
            nonce,
            cluster_id: market.arcium_cluster,
            submitted_slot: clock.slot,
        };

        emit!(TallyRequested {
            market: market.key(),
            cluster: market.arcium_cluster,
            slot: clock.slot,
        });

        Ok(())
    }

    pub fn settle_market(
        ctx: Context<SettleMarket>,
        yes_stake: u64,
        no_stake: u64,
        yes_won: bool,
        mpc_job_id: [u8; 32],
        proof_hash: [u8; 32],
        proof_uri: String,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.registry.authority,
            PredictionMarketError::Unauthorized
        );
        require!(proof_uri.len() <= MAX_PROOF_URI_LEN, PredictionMarketError::InvalidProofUri);

        let clock = Clock::get()?;
        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Resolving, PredictionMarketError::MpcStillPending);

        let settlement_hash = settlement_hash_for(
            market.id,
            yes_stake,
            no_stake,
            yes_won,
            mpc_job_id,
            proof_hash,
            market.tally_ticket.nonce,
        );

        market.revealed_yes_stake = yes_stake;
        market.revealed_no_stake = no_stake;
        market.outcome = Some(yes_won);
        market.status = MarketStatus::SettledPending;
        market.artifacts = SettlementArtifacts {
            mpc_job_id,
            proof_hash,
            proof_uri: write_fixed_bytes::<128>(&proof_uri),
            settlement_hash,
            submitted_slot: clock.slot,
            challenge_deadline: clock.unix_timestamp + CHALLENGE_WINDOW_SECONDS,
            challenged: false,
            challenged_by: Pubkey::default(),
            challenge_reason: 0,
            slash_amount: 0,
        };

        emit!(SettlementSubmitted {
            market: market.key(),
            settlement_hash,
            proof_hash,
            mpc_job_id,
            challenge_deadline: market.artifacts.challenge_deadline,
        });

        Ok(())
    }

    pub fn challenge_settlement(
        ctx: Context<ChallengeSettlement>,
        expected_hash: [u8; 32],
        reason_code: u8,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let registry = &mut ctx.accounts.registry;
        let market = &mut ctx.accounts.market;

        require!(
            market.status == MarketStatus::SettledPending,
            PredictionMarketError::MarketNotChallengeable
        );
        require!(
            clock.unix_timestamp <= market.artifacts.challenge_deadline,
            PredictionMarketError::ChallengeWindowClosed
        );
        require!(
            !market.artifacts.challenged,
            PredictionMarketError::SettlementAlreadyChallenged
        );
        require!(
            expected_hash != market.artifacts.settlement_hash,
            PredictionMarketError::InvalidChallengeEvidence
        );

        let total_pool = market.revealed_yes_stake.saturating_add(market.revealed_no_stake);
        let slash_amount = total_pool.saturating_mul(SLASH_BPS) / 10_000;

        market.status = MarketStatus::Invalid;
        market.outcome = None;
        market.artifacts.challenged = true;
        market.artifacts.challenged_by = ctx.accounts.challenger.key();
        market.artifacts.challenge_reason = reason_code;
        market.artifacts.slash_amount = slash_amount;

        registry.settlement_challenges = registry.settlement_challenges.saturating_add(1);
        registry.invalid_markets = registry.invalid_markets.saturating_add(1);
        registry.slash_events = registry.slash_events.saturating_add(1);

        emit!(SettlementChallenged {
            market: market.key(),
            challenger: ctx.accounts.challenger.key(),
            provided_hash: expected_hash,
            stored_hash: market.artifacts.settlement_hash,
            slash_amount,
            reason_code,
        });

        Ok(())
    }

    pub fn finalize_settlement(ctx: Context<FinalizeSettlement>) -> Result<()> {
        let clock = Clock::get()?;
        let market = &mut ctx.accounts.market;

        require!(
            market.status == MarketStatus::SettledPending,
            PredictionMarketError::SettlementNotFinalizable
        );
        require!(
            !market.artifacts.challenged,
            PredictionMarketError::SettlementAlreadyChallenged
        );
        require!(
            clock.unix_timestamp > market.artifacts.challenge_deadline,
            PredictionMarketError::SettlementNotFinalizable
        );

        market.status = MarketStatus::Settled;

        emit!(SettlementFinalized {
            market: market.key(),
            settlement_hash: market.artifacts.settlement_hash,
            finalized_slot: clock.slot,
        });

        emit!(MarketSettled {
            market: market.key(),
            yes_stake: market.revealed_yes_stake,
            no_stake: market.revealed_no_stake,
            yes_won: market.outcome.unwrap_or(false),
        });

        Ok(())
    }

    pub fn reveal_position(ctx: Context<RevealPosition>, stake: u64, choice: bool) -> Result<()> {
        require!(
            ctx.accounts.market.status == MarketStatus::Settled,
            PredictionMarketError::MpcStillPending
        );
        require!(
            ctx.accounts.authority.key() == ctx.accounts.registry.authority,
            PredictionMarketError::Unauthorized
        );

        let position = &mut ctx.accounts.position;
        position.revealed_stake = stake;
        position.revealed_choice = Some(choice);
        Ok(())
    }

    pub fn claim_winnings(ctx: Context<ClaimWinnings>) -> Result<()> {
        let market = &ctx.accounts.market;
        let position = &mut ctx.accounts.position;

        require!(market.status == MarketStatus::Settled, PredictionMarketError::MpcStillPending);
        require!(!position.claimed, PredictionMarketError::AlreadyClaimed);

        let outcome = market.outcome.ok_or(PredictionMarketError::MpcStillPending)?;
        let user_choice = position
            .revealed_choice
            .ok_or(PredictionMarketError::PositionNotRevealed)?;
        require!(user_choice == outcome, PredictionMarketError::PositionDidNotWin);

        let winning_pool = if outcome {
            market.revealed_yes_stake
        } else {
            market.revealed_no_stake
        };
        require!(winning_pool > 0, PredictionMarketError::WinningPoolEmpty);

        let total_pool = market.revealed_yes_stake.saturating_add(market.revealed_no_stake);
        let gross_payout = payout_amount(position.revealed_stake, total_pool, winning_pool);
        let fee = gross_payout.saturating_mul(PROTOCOL_FEE_BPS) / 10_000;
        let net_payout = gross_payout.saturating_sub(fee);

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
        token::transfer(cpi_ctx, net_payout)?;

        position.claimed = true;
        Ok(())
    }

    pub fn cancel_market(ctx: Context<CancelMarket>) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.registry.authority,
            PredictionMarketError::Unauthorized
        );
        let market = &mut ctx.accounts.market;
        require!(
            market.status == MarketStatus::Open
                || market.status == MarketStatus::Resolving
                || market.status == MarketStatus::SettledPending,
            PredictionMarketError::MarketNotChallengeable
        );
        market.status = MarketStatus::Cancelled;
        Ok(())
    }

    pub fn resolve_invalid_market(
        ctx: Context<ResolveInvalidMarket>,
        reason_code: u8,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.registry.authority,
            PredictionMarketError::Unauthorized
        );

        let registry = &mut ctx.accounts.registry;
        let market = &mut ctx.accounts.market;
        require!(market.status != MarketStatus::Settled, PredictionMarketError::SettlementNotFinalizable);

        if market.status != MarketStatus::Invalid {
            registry.invalid_markets = registry.invalid_markets.saturating_add(1);
        }

        market.status = MarketStatus::Invalid;
        market.outcome = None;
        market.artifacts.challenged = true;
        market.artifacts.challenged_by = ctx.accounts.authority.key();
        market.artifacts.challenge_reason = reason_code;

        emit!(MarketInvalidated {
            market: market.key(),
            by: ctx.accounts.authority.key(),
            reason_code,
        });

        Ok(())
    }

    pub fn refund_position(ctx: Context<RefundPosition>) -> Result<()> {
        let market = &ctx.accounts.market;
        let position = &mut ctx.accounts.position;
        require!(
            market.status == MarketStatus::Cancelled || market.status == MarketStatus::Invalid,
            PredictionMarketError::MarketNotRefundable
        );
        require!(!position.claimed, PredictionMarketError::AlreadyClaimed);

        let refund_amount = position.deposited_stake;
        require!(refund_amount > 0, PredictionMarketError::StakeTooLow);

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
        token::transfer(cpi_ctx, refund_amount)?;

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
    #[account(
        init,
        payer = creator,
        space = MARKET_SPACE,
        seeds = [MARKET_SEED, registry.total_markets.to_le_bytes().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = creator,
        token::mint = token_mint,
        token::authority = vault,
        seeds = [VAULT_SEED, registry.total_markets.to_le_bytes().as_ref()],
        bump
    )]
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
    #[account(
        init,
        payer = user,
        space = POSITION_SPACE,
        seeds = [POSITION_SEED, market.key().as_ref(), user.key().as_ref()],
        bump
    )]
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
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut, seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    pub challenger: Signer<'info>,
}

#[derive(Accounts)]
pub struct FinalizeSettlement<'info> {
    #[account(mut, seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    pub caller: Signer<'info>,
}

#[derive(Accounts)]
pub struct RevealPosition<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), position.owner.as_ref()],
        bump = position.bump
    )]
    pub position: Account<'info, Position>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimWinnings<'info> {
    #[account(seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key()
    )]
    pub position: Account<'info, Position>,
    #[account(mut, seeds = [VAULT_SEED, market.id.to_le_bytes().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelMarket<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut, seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResolveInvalidMarket<'info> {
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut, seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RefundPosition<'info> {
    #[account(seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key()
    )]
    pub position: Account<'info, Position>,
    #[account(mut, seeds = [VAULT_SEED, market.id.to_le_bytes().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[event]
pub struct PositionSubmitted {
    pub market: Pubkey,
    pub participant: Pubkey,
    pub slot: u64,
}

#[event]
pub struct TallyRequested {
    pub market: Pubkey,
    pub cluster: Pubkey,
    pub slot: u64,
}

#[event]
pub struct SettlementSubmitted {
    pub market: Pubkey,
    pub settlement_hash: [u8; 32],
    pub proof_hash: [u8; 32],
    pub mpc_job_id: [u8; 32],
    pub challenge_deadline: i64,
}

#[event]
pub struct SettlementChallenged {
    pub market: Pubkey,
    pub challenger: Pubkey,
    pub provided_hash: [u8; 32],
    pub stored_hash: [u8; 32],
    pub slash_amount: u64,
    pub reason_code: u8,
}

#[event]
pub struct SettlementFinalized {
    pub market: Pubkey,
    pub settlement_hash: [u8; 32],
    pub finalized_slot: u64,
}

#[event]
pub struct MarketInvalidated {
    pub market: Pubkey,
    pub by: Pubkey,
    pub reason_code: u8,
}

#[event]
pub struct MarketSettled {
    pub market: Pubkey,
    pub yes_stake: u64,
    pub no_stake: u64,
    pub yes_won: bool,
}

fn write_fixed_bytes<const N: usize>(value: &str) -> [u8; N] {
    let mut out = [0u8; N];
    let bytes = value.as_bytes();
    let take = bytes.len().min(N);
    out[..take].copy_from_slice(&bytes[..take]);
    out
}

fn settlement_hash_for(
    market_id: u64,
    yes_stake: u64,
    no_stake: u64,
    yes_won: bool,
    mpc_job_id: [u8; 32],
    proof_hash: [u8; 32],
    nonce: [u8; 32],
) -> [u8; 32] {
    hashv(&[
        &market_id.to_le_bytes(),
        &yes_stake.to_le_bytes(),
        &no_stake.to_le_bytes(),
        &[yes_won as u8],
        &mpc_job_id,
        &proof_hash,
        &nonce,
    ])
    .to_bytes()
}

fn payout_amount(position_stake: u64, total_pool: u64, winning_pool: u64) -> u64 {
    (position_stake as u128)
        .checked_mul(total_pool as u128)
        .and_then(|value| value.checked_div(winning_pool as u128))
        .unwrap_or(0) as u64
}

fn challenge_window_open(now: i64, deadline: i64) -> bool {
    now <= deadline
}

fn settlement_replay_detected(challenged: bool) -> bool {
    challenged
}

fn settlement_finalizable(now: i64, deadline: i64, challenged: bool) -> bool {
    now > deadline && !challenged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settlement_hash_is_deterministic() {
        let job = [3u8; 32];
        let proof = [4u8; 32];
        let nonce = [5u8; 32];
        let left = settlement_hash_for(7, 11, 13, true, job, proof, nonce);
        let right = settlement_hash_for(7, 11, 13, true, job, proof, nonce);
        assert_eq!(left, right);
    }

    #[test]
    fn settlement_hash_changes_with_inputs() {
        let nonce = [5u8; 32];
        let proof = [4u8; 32];
        let first = settlement_hash_for(7, 11, 13, true, [3u8; 32], proof, nonce);
        let second = settlement_hash_for(7, 11, 13, true, [9u8; 32], proof, nonce);
        assert_ne!(first, second);
    }

    #[test]
    fn payout_math_is_stable() {
        let payout = payout_amount(200, 1_000, 400);
        assert_eq!(payout, 500);
    }

    #[test]
    fn challenge_window_and_finalize_logic() {
        assert!(challenge_window_open(99, 100));
        assert!(!challenge_window_open(101, 100));
        assert!(settlement_finalizable(200, 100, false));
        assert!(!settlement_finalizable(90, 100, false));
        assert!(!settlement_finalizable(200, 100, true));
    }

    #[test]
    fn replay_guard_detects_second_challenge() {
        assert!(!settlement_replay_detected(false));
        assert!(settlement_replay_detected(true));
    }
}
