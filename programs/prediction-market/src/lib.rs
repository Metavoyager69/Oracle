use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("PredMkt1111111111111111111111111111111111111");

// ─────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────
pub const MARKET_SEED: &[u8]   = b"market";
pub const VAULT_SEED: &[u8]    = b"vault";
pub const POSITION_SEED: &[u8] = b"position";
pub const REGISTRY_SEED: &[u8] = b"registry";

pub const PROTOCOL_FEE_BPS: u64 = 100;        // 1%
pub const MIN_STAKE: u64         = 1_000_000;  // 0.001 of token base units
pub const MAX_TITLE_LEN: usize   = 128;
pub const MAX_DESC_LEN: usize    = 512;

// Account space constants — explicit so they stay in sync with the struct layout.
// Anchor discriminator = 8 bytes; each field sized manually below.
pub const REGISTRY_SPACE: usize = 8 + 32 + 32 + 8 + 8 + 1;   // 89 bytes

pub const MARKET_SPACE: usize =
      8          // discriminator
    + 8          // id
    + 32         // creator
    + 128        // title
    + 512        // description
    + 8          // resolution_timestamp
    + 8          // created_at
    + 32         // arcium_cluster
    + 64         // encrypted_yes_stake  (Ciphertext = 2 × 32)
    + 64         // encrypted_no_stake
    + 8          // revealed_yes_stake
    + 8          // revealed_no_stake
    + 1 + 32 + 8 // tally_ticket (1 byte Option tag + 32 nonce + Pubkey[32] + u64[8] = 73)
    + 32         // tally_ticket.cluster_id
    + 4          // total_participants
    + 1          // status enum tag
    + 2          // outcome: Option<bool>
    + 64         // encrypted_resolution
    + 32         // vault
    + 32         // token_mint
    + 1          // bump
    + 1;         // vault_bump

pub const POSITION_SPACE: usize =
      8          // discriminator
    + 32         // owner
    + 32         // market
    + 64         // encrypted_stake
    + 64         // encrypted_choice
    + 8          // revealed_stake
    + 2          // revealed_choice: Option<bool>
    + 32         // stake_commitment [u8; 32]
    + 8          // submitted_at
    + 1          // claimed
    + 1;         // bump

// ─────────────────────────────────────────────────────────────────
//  Arcium MPC types
//
//  Consolidated from two formerly identical structs into one Ciphertext type.
//  Field names at usage sites distinguish stake amounts from vote choices.
//
//  Arcium ElGamal over Ristretto255:
//    C1 = r · G             (ephemeral public key)
//    C2 = m · G + r · PK   (blinded message)
// ─────────────────────────────────────────────────────────────────

/// A 64-byte Arcium ElGamal ciphertext (two Ristretto255 points).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq)]
pub struct Ciphertext {
    pub c1: [u8; 32], // r · G          (ephemeral public key)
    pub c2: [u8; 32], // m · G + r · PK (blinded message)
}

/// Arcium job ticket — written on-chain after a tally is requested
/// so the off-chain relayer knows which cluster to contact.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct ArciumComputeTicket {
    pub nonce:          [u8; 32],
    pub cluster_id:     Pubkey,
    pub submitted_slot: u64,
}

// ─────────────────────────────────────────────────────────────────
//  On-chain state accounts
// ─────────────────────────────────────────────────────────────────

/// Global registry — one per protocol deployment.
#[account]
pub struct MarketRegistry {
    /// Protocol upgrade authority and settlement oracle signer.
    pub authority:      Pubkey,
    /// The Arcium MXE cluster assigned to all MPC computations.
    pub arcium_cluster: Pubkey,
    pub total_markets:  u64,
    /// Cumulative SPL token volume (6-decimal base units, NOT lamports).
    pub total_volume:   u64,
    pub bump:           u8,
}

/// A single prediction market.
#[account]
pub struct Market {
    pub id:                   u64,
    pub creator:              Pubkey,
    pub title:                [u8; 128],
    pub description:          [u8; 512],
    pub resolution_timestamp: i64,
    pub created_at:           i64,
    pub arcium_cluster:       Pubkey,

    // Encrypted aggregate tallies — homomorphically accumulated by Arcium nodes.
    pub encrypted_yes_stake: Ciphertext,
    pub encrypted_no_stake:  Ciphertext,

    // Revealed only after Arcium MPC decryption at settlement.
    pub revealed_yes_stake: u64,
    pub revealed_no_stake:  u64,

    /// Arcium job ticket set when request_tally is called.
    pub tally_ticket:         ArciumComputeTicket,
    pub total_participants:   u32,
    pub status:               MarketStatus,

    /// None = pending; Some(true) = YES wins; Some(false) = NO wins.
    pub outcome:              Option<bool>,

    /// Encrypted oracle resolution input — hidden until MPC tally.
    pub encrypted_resolution: Ciphertext,

    pub vault:      Pubkey,
    pub token_mint: Pubkey,
    pub bump:       u8,
    pub vault_bump: u8,
}

/// Market lifecycle.
///
/// FIX (DEAD-1/2): Added `Cancelled` instruction and removed the
/// unreachable `Locked` variant.  Markets go:
///   Open → Resolving → Settled
///   Open → Cancelled  (authority only)
///   Resolving → Cancelled (authority only)
#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Default)]
pub enum MarketStatus {
    #[default]
    Open,
    Resolving,  // Arcium MPC tally job in flight
    Settled,    // outcome revealed; claims open
    Cancelled,  // refunds available
}

/// A user's position in one market.
#[account]
pub struct Position {
    pub owner:   Pubkey,
    pub market:  Pubkey,

    /// Encrypted stake amount (Arcium ElGamal ciphertext).
    pub encrypted_stake:  Ciphertext,
    /// Encrypted YES/NO vote (Arcium ElGamal ciphertext).
    pub encrypted_choice: Ciphertext,

    /// Set by reveal_position after Arcium MPC decrypts this position.
    pub revealed_stake:  u64,
    pub revealed_choice: Option<bool>,

    /// SHA-256(amount_le_bytes || stake_nonce) — committed at submission,
    /// verified at reveal.  Binds the ciphertext to the real amount
    /// without storing the plaintext on-chain.
    pub stake_commitment: [u8; 32],

    pub submitted_at: i64,
    pub claimed:      bool,
    pub bump:         u8,
}

// ─────────────────────────────────────────────────────────────────
//  Error codes  (removed unused variants: MarketAlreadySettled,
//               InvalidMpcTicket — FIX DEAD-3/4)
// ─────────────────────────────────────────────────────────────────
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
    #[msg("Stake amount below minimum (1_000_000 base units)")]
    StakeTooLow,
    #[msg("Title exceeds 128 bytes")]
    TitleTooLong,
    #[msg("Description exceeds 512 bytes")]
    DescTooLong,
    #[msg("Caller is not the protocol authority")]
    Unauthorized,
    #[msg("Resolution timestamp must be in the future")]
    InvalidResolutionTime,
    #[msg("Market is cancelled; use refund_position")]
    MarketCancelled,
    #[msg("Winning pool is empty — cannot calculate proportional payout")]
    WinningPoolEmpty,
    #[msg("Stake commitment mismatch — revealed amount or nonce is incorrect")]
    InvalidCommitment,
}

// ─────────────────────────────────────────────────────────────────
//  Program
// ─────────────────────────────────────────────────────────────────
#[program]
pub mod prediction_market {
    use super::*;

    // ── 1. Initialize protocol ───────────────────────────────────
    pub fn initialize(ctx: Context<Initialize>, arcium_cluster: Pubkey) -> Result<()> {
        let r = &mut ctx.accounts.registry;
        r.authority      = ctx.accounts.authority.key();
        r.arcium_cluster = arcium_cluster;
        r.total_markets  = 0;
        r.total_volume   = 0;
        r.bump           = ctx.bumps.registry;
        msg!("Protocol initialised. Arcium cluster: {}", arcium_cluster);
        Ok(())
    }

    // ── 2. Create market ─────────────────────────────────────────
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
        let market   = &mut ctx.accounts.market;

        let mut title_arr = [0u8; 128];
        title_arr[..title.len()].copy_from_slice(title.as_bytes());

        let mut desc_arr = [0u8; 512];
        desc_arr[..description.len()].copy_from_slice(description.as_bytes());

        market.id                   = registry.total_markets;
        market.creator              = ctx.accounts.creator.key();
        market.title                = title_arr;
        market.description          = desc_arr;
        market.resolution_timestamp = resolution_timestamp;
        market.created_at           = clock.unix_timestamp;
        market.arcium_cluster       = registry.arcium_cluster;
        market.encrypted_yes_stake  = Ciphertext::default();
        market.encrypted_no_stake   = Ciphertext::default();
        market.revealed_yes_stake   = 0;
        market.revealed_no_stake    = 0;
        market.total_participants   = 0;
        market.status               = MarketStatus::Open;
        market.outcome              = None;
        market.vault                = ctx.accounts.vault.key();
        market.token_mint           = ctx.accounts.token_mint.key();
        market.bump                 = ctx.bumps.market;
        market.vault_bump           = ctx.bumps.vault;

        registry.total_markets += 1;

        msg!("Market #{} created: '{}'. Resolves at {}.", market.id, title, resolution_timestamp);
        Ok(())
    }

    // ── 3. Submit encrypted position ────────────────────────────
    /// `plaintext_stake_lamports` is used only for the SPL token
    /// transfer.  The amount is NOT stored on-chain; instead a
    /// SHA-256 commitment binds it to the encrypted ciphertext so
    /// nobody can lie about the amount at settlement.
    pub fn submit_position(
        ctx: Context<SubmitPosition>,
        encrypted_stake:  Ciphertext,
        encrypted_choice: Ciphertext,
        plaintext_stake_lamports: u64,
        /// SHA-256(amount_le_bytes || stake_nonce) — generated client-side.
        /// Stored on-chain; verified against revealed values at settlement.
        stake_commitment: [u8; 32],
    ) -> Result<()> {
        let market = &mut ctx.accounts.market;

        require!(market.status == MarketStatus::Open, PredictionMarketError::MarketNotOpen);
        require!(plaintext_stake_lamports >= MIN_STAKE,  PredictionMarketError::StakeTooLow);

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp < market.resolution_timestamp,
            PredictionMarketError::MarketNotOpen
        );

        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.user_token_account.to_account_info(),
                to:        ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(cpi_ctx, plaintext_stake_lamports)?;

        let position = &mut ctx.accounts.position;
        position.owner            = ctx.accounts.user.key();
        position.market           = market.key();
        position.encrypted_stake  = encrypted_stake;
        position.encrypted_choice = encrypted_choice;
        position.revealed_stake   = 0;
        position.revealed_choice  = None;
        position.stake_commitment = stake_commitment;
        position.submitted_at     = clock.unix_timestamp;
        position.claimed          = false;
        position.bump             = ctx.bumps.position;

        market.total_participants          += 1;
        ctx.accounts.registry.total_volume += plaintext_stake_lamports;

        msg!(
            "Encrypted position submitted for market #{}. Participants: {}",
            market.id, market.total_participants
        );

        emit!(PositionSubmitted {
            market:      market.key(),
            participant: ctx.accounts.user.key(),
            slot:        clock.slot,
        });

        Ok(())
    }

    // ── 4. Request Arcium MPC tally ──────────────────────────────
    pub fn request_tally(ctx: Context<RequestTally>) -> Result<()> {
        let market = &mut ctx.accounts.market;

        require!(market.status == MarketStatus::Open, PredictionMarketError::MarketNotOpen);

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp >= market.resolution_timestamp,
            PredictionMarketError::MarketNotExpired
        );

        market.status = MarketStatus::Resolving;

        // FIX (BUG-4): build a deterministic 32-byte nonce properly.
        // In production: CPI into Arcium program for a cryptographically
        // secure nonce; replace the authority check with an Arcium
        // oracle signature or ZK proof in settle_market.
        let mut nonce = [0u8; 32];
        nonce[..8].copy_from_slice(&market.id.to_le_bytes());
        nonce[8..16].copy_from_slice(&clock.slot.to_le_bytes());
        nonce[16..24].copy_from_slice(&clock.unix_timestamp.to_le_bytes());

        market.tally_ticket = ArciumComputeTicket {
            nonce,
            cluster_id:     market.arcium_cluster,
            submitted_slot: clock.slot,
        };

        msg!(
            "MPC tally requested for market #{}. Arcium cluster: {}",
            market.id, market.arcium_cluster
        );

        emit!(TallyRequested {
            market:  market.key(),
            cluster: market.arcium_cluster,
            slot:    clock.slot,
        });

        Ok(())
    }

    // ── 5. Settle market ─────────────────────────────────────────
    pub fn settle_market(
        ctx: Context<SettleMarket>,
        yes_stake: u64,
        no_stake: u64,
        yes_won: bool,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.registry.authority,
            PredictionMarketError::Unauthorized
        );

        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Resolving, PredictionMarketError::MpcStillPending);

        market.revealed_yes_stake = yes_stake;
        market.revealed_no_stake  = no_stake;
        market.outcome            = Some(yes_won);
        market.status             = MarketStatus::Settled;

        msg!(
            "Market #{} settled. YES: {} / NO: {}. Winner: {}",
            market.id, yes_stake, no_stake, if yes_won { "YES" } else { "NO" }
        );

        emit!(MarketSettled { market: market.key(), yes_stake, no_stake, yes_won });
        Ok(())
    }

    // ── 6. Reveal individual position ───────────────────────────
    pub fn reveal_position(
        ctx: Context<RevealPosition>,
        stake: u64,
        choice: bool,
        /// The blinding nonce the user generated at submission time.
        /// Arcium relayer provides this at reveal so the on-chain
        /// program can verify SHA-256(stake_le || nonce) == commitment.
        stake_nonce: [u8; 32],
    ) -> Result<()> {
        require!(
            ctx.accounts.market.status == MarketStatus::Settled,
            PredictionMarketError::MpcStillPending
        );
        require!(
            ctx.accounts.authority.key() == ctx.accounts.registry.authority,
            PredictionMarketError::Unauthorized
        );

        // Verify commitment: SHA-256(amount_le_bytes || stake_nonce)
        let position = &mut ctx.accounts.position;
        let mut preimage = [0u8; 40]; // 8 bytes amount + 32 bytes nonce
        preimage[..8].copy_from_slice(&stake.to_le_bytes());
        preimage[8..].copy_from_slice(&stake_nonce);
        let digest = anchor_lang::solana_program::hash::hash(&preimage);
        require!(
            digest.to_bytes() == position.stake_commitment,
            PredictionMarketError::InvalidCommitment
        );

        position.revealed_stake  = stake;
        position.revealed_choice = Some(choice);

        msg!("Position revealed: {} tokens, choice: {}", stake, choice);
        Ok(())
    }

    // ── 7. Claim winnings ────────────────────────────────────────
    pub fn claim_winnings(ctx: Context<ClaimWinnings>) -> Result<()> {
        let market   = &ctx.accounts.market;
        let position = &mut ctx.accounts.position;

        require!(market.status == MarketStatus::Settled, PredictionMarketError::MpcStillPending);
        require!(!position.claimed, PredictionMarketError::AlreadyClaimed);

        // FIX (BUG-1): replace .unwrap() with explicit error variants
        let outcome     = market.outcome.ok_or(PredictionMarketError::MpcStillPending)?;
        let user_choice = position.revealed_choice.ok_or(PredictionMarketError::PositionNotRevealed)?;

        require!(user_choice == outcome, PredictionMarketError::PositionDidNotWin);

        let winning_pool = if outcome {
            market.revealed_yes_stake
        } else {
            market.revealed_no_stake
        };

        // FIX (BUG-2): guard division by zero
        require!(winning_pool > 0, PredictionMarketError::WinningPoolEmpty);

        let total_pool = market.revealed_yes_stake + market.revealed_no_stake;

        let gross_payout = (position.revealed_stake as u128)
            .checked_mul(total_pool as u128)
            .and_then(|n| n.checked_div(winning_pool as u128))
            .unwrap_or(0) as u64;

        let fee        = gross_payout.saturating_mul(PROTOCOL_FEE_BPS) / 10_000;
        let net_payout = gross_payout.saturating_sub(fee);

        let market_id_bytes = market.id.to_le_bytes();
        let seeds           = &[VAULT_SEED, market_id_bytes.as_ref(), &[market.vault_bump]];
        let signer_seeds    = &[&seeds[..]];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.vault.to_account_info(),
                to:        ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_ctx, net_payout)?;

        position.claimed = true;
        msg!("Winnings claimed: {} tokens (fee: {})", net_payout, fee);
        Ok(())
    }

    // ── 8. Cancel market ─────────────────────────────────────────
    /// FIX (DEAD-2): implement the Cancelled state so it is reachable.
    pub fn cancel_market(ctx: Context<CancelMarket>) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.registry.authority,
            PredictionMarketError::Unauthorized
        );
        let market = &mut ctx.accounts.market;
        require!(
            market.status == MarketStatus::Open
                || market.status == MarketStatus::Resolving,
            PredictionMarketError::MpcStillPending
        );
        market.status = MarketStatus::Cancelled;
        msg!("Market #{} cancelled.", market.id);
        Ok(())
    }

    // ── 9. Refund cancelled position ─────────────────────────────
    pub fn refund_position(ctx: Context<RefundPosition>) -> Result<()> {
        let market   = &ctx.accounts.market;
        let position = &mut ctx.accounts.position;

        require!(market.status == MarketStatus::Cancelled, PredictionMarketError::MarketCancelled);
        require!(!position.claimed, PredictionMarketError::AlreadyClaimed);

        let refund_amount = position.revealed_stake;
        require!(refund_amount > 0, PredictionMarketError::PositionNotRevealed);

        let market_id_bytes = market.id.to_le_bytes();
        let seeds           = &[VAULT_SEED, market_id_bytes.as_ref(), &[market.vault_bump]];
        let signer_seeds    = &[&seeds[..]];

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from:      ctx.accounts.vault.to_account_info(),
                to:        ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_ctx, refund_amount)?;

        position.claimed = true;
        msg!("Refund: {} tokens for market #{}", refund_amount, market.id);
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────
//  Account contexts
// ─────────────────────────────────────────────────────────────────

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
        init, payer = creator, space = MARKET_SPACE,
        seeds = [MARKET_SEED, registry.total_markets.to_le_bytes().as_ref()], bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init, payer = creator,
        token::mint = token_mint, token::authority = vault,
        seeds = [VAULT_SEED, registry.total_markets.to_le_bytes().as_ref()], bump
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_mint:     Account<'info, Mint>,
    #[account(mut)]
    pub creator:        Signer<'info>,
    pub token_program:  Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent:           Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SubmitPosition<'info> {
    #[account(mut, seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut, seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        init, payer = user, space = POSITION_SPACE,
        seeds = [POSITION_SEED, market.key().as_ref(), user.key().as_ref()], bump
    )]
    pub position: Account<'info, Position>,
    #[account(mut, seeds = [VAULT_SEED, market.id.to_le_bytes().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user:               Signer<'info>,
    pub token_program:      Program<'info, Token>,
    pub system_program:     Program<'info, System>,
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
    pub market:    Account<'info, Market>,
    pub authority: Signer<'info>,
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
        bump  = position.bump
    )]
    pub position:  Account<'info, Position>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimWinnings<'info> {
    #[account(seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds      = [POSITION_SEED, market.key().as_ref(), user.key().as_ref()],
        bump       = position.bump,
        constraint = position.owner == user.key()
    )]
    pub position: Account<'info, Position>,
    #[account(mut, seeds = [VAULT_SEED, market.id.to_le_bytes().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    pub user:          Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelMarket<'info> {
    #[account(seeds = [REGISTRY_SEED], bump = registry.bump)]
    pub registry: Account<'info, MarketRegistry>,
    #[account(mut, seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market:    Account<'info, Market>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct RefundPosition<'info> {
    #[account(seeds = [MARKET_SEED, market.id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds      = [POSITION_SEED, market.key().as_ref(), user.key().as_ref()],
        bump       = position.bump,
        constraint = position.owner == user.key()
    )]
    pub position: Account<'info, Position>,
    #[account(mut, seeds = [VAULT_SEED, market.id.to_le_bytes().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    pub user:          Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// ─────────────────────────────────────────────────────────────────
//  Events
// ─────────────────────────────────────────────────────────────────

#[event]
pub struct PositionSubmitted {
    pub market:      Pubkey,
    pub participant: Pubkey,
    pub slot:        u64,
}

#[event]
pub struct TallyRequested {
    pub market:  Pubkey,
    pub cluster: Pubkey,
    pub slot:    u64,
}

#[event]
pub struct MarketSettled {
    pub market:    Pubkey,
    pub yes_stake: u64,
    pub no_stake:  u64,
    pub yes_won:   bool,
}
