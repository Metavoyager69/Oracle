import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

const MARKET_SEED = Buffer.from("market");
const VAULT_SEED = Buffer.from("vault");
const POS_SEED = Buffer.from("position");
const REG_SEED = Buffer.from("registry");
const FAKE_CLUSTER = Keypair.generate().publicKey;

function shortArray(value: number): number[] {
  return Array.from(new Uint8Array(32).fill(value));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("prediction-market matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.PredictionMarket as Program<any>;
  const authority = provider.wallet as anchor.Wallet;
  const challenger = Keypair.generate();

  let mint: PublicKey;
  let registryPDA: PublicKey;
  let marketFastPDA: PublicKey;
  let marketFrontRunPDA: PublicKey;
  let marketGriefPDA: PublicKey;

  before(async () => {
    [registryPDA] = PublicKey.findProgramAddressSync([REG_SEED], program.programId);
    [marketFastPDA] = PublicKey.findProgramAddressSync(
      [MARKET_SEED, Buffer.from(new Uint8Array(8))],
      program.programId
    );
    [marketFrontRunPDA] = PublicKey.findProgramAddressSync(
      [MARKET_SEED, new BN(1).toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    [marketGriefPDA] = PublicKey.findProgramAddressSync(
      [MARKET_SEED, new BN(2).toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    mint = await createMint(
      provider.connection,
      authority.payer,
      authority.publicKey,
      null,
      6
    );
  });

  describe("integration", () => {
    it("initializes registry", async () => {
      await program.methods
        .initialize(FAKE_CLUSTER)
        .accounts({
          registry: registryPDA,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const registry = await program.account.marketRegistry.fetch(registryPDA);
      assert.equal(registry.arciumCluster.toBase58(), FAKE_CLUSTER.toBase58());
      assert.equal(registry.totalMarkets.toNumber(), 0);
    });

    it("creates, settles with artifacts, and enters challenge window", async () => {
      const [vaultFastPDA] = PublicKey.findProgramAddressSync(
        [VAULT_SEED, Buffer.from(new Uint8Array(8))],
        program.programId
      );

      const resolutionTs = Math.floor(Date.now() / 1000) + 2;
      await program.methods
        .createMarket(
          "Fast market for settlement artifacts",
          "Used for integration tests around settlement metadata.",
          new BN(resolutionTs)
        )
        .accounts({
          registry: registryPDA,
          market: marketFastPDA,
          vault: vaultFastPDA,
          tokenMint: mint,
          creator: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      await sleep(3_000);

      await program.methods
        .requestTally()
        .accounts({
          market: marketFastPDA,
          caller: authority.publicKey,
        })
        .rpc();

      await program.methods
        .settleMarket(
          new BN(12_000_000),
          new BN(8_000_000),
          true,
          shortArray(0x41),
          shortArray(0x42),
          "ipfs://cipherbet/proof-settlement-fast"
        )
        .accounts({
          registry: registryPDA,
          market: marketFastPDA,
          authority: authority.publicKey,
        })
        .rpc();

      const market = await program.account.market.fetch(marketFastPDA);
      assert.deepEqual(market.status, { settledPending: {} });
      assert.equal(market.outcome, true);
      assert.equal(market.artifacts.challengeDeadline.gt(new BN(0)), true);
    });
  });

  describe("adversarial", () => {
    it("blocks front-run settlement before tally request", async () => {
      const [vaultFrontPDA] = PublicKey.findProgramAddressSync(
        [VAULT_SEED, new BN(1).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      const resolutionTs = Math.floor(Date.now() / 1000) + 3600;
      await program.methods
        .createMarket(
          "Front-run resistance market",
          "Attempts direct settlement before tally request should fail.",
          new BN(resolutionTs)
        )
        .accounts({
          registry: registryPDA,
          market: marketFrontRunPDA,
          vault: vaultFrontPDA,
          tokenMint: mint,
          creator: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      let failed = false;
      try {
        await program.methods
          .settleMarket(
            new BN(1_000_000),
            new BN(1_000_000),
            true,
            shortArray(0x11),
            shortArray(0x12),
            "ipfs://cipherbet/invalid-front-run"
          )
          .accounts({
            registry: registryPDA,
            market: marketFrontRunPDA,
            authority: authority.publicKey,
          })
          .rpc();
      } catch {
        failed = true;
      }
      assert.equal(failed, true);
    });

    it("accepts one valid challenge, rejects replay challenge", async () => {
      await program.methods
        .challengeSettlement(shortArray(0x00), 7)
        .accounts({
          registry: registryPDA,
          market: marketFastPDA,
          challenger: challenger.publicKey,
        })
        .signers([challenger])
        .rpc();

      const invalidated = await program.account.market.fetch(marketFastPDA);
      assert.deepEqual(invalidated.status, { invalid: {} });

      let replayFailed = false;
      try {
        await program.methods
          .challengeSettlement(shortArray(0x01), 8)
          .accounts({
            registry: registryPDA,
            market: marketFastPDA,
            challenger: challenger.publicKey,
          })
          .signers([challenger])
          .rpc();
      } catch {
        replayFailed = true;
      }
      assert.equal(replayFailed, true);
    });

    it("blocks griefing challenge that replays the same settlement hash", async () => {
      const [vaultGriefPDA] = PublicKey.findProgramAddressSync(
        [VAULT_SEED, new BN(2).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      const resolutionTs = Math.floor(Date.now() / 1000) + 2;
      await program.methods
        .createMarket(
          "Griefing guard market",
          "Challenge with same hash should not invalidate settlement.",
          new BN(resolutionTs)
        )
        .accounts({
          registry: registryPDA,
          market: marketGriefPDA,
          vault: vaultGriefPDA,
          tokenMint: mint,
          creator: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      await sleep(3_000);
      await program.methods
        .requestTally()
        .accounts({
          market: marketGriefPDA,
          caller: authority.publicKey,
        })
        .rpc();
      await program.methods
        .settleMarket(
          new BN(3_000_000),
          new BN(2_000_000),
          false,
          shortArray(0x21),
          shortArray(0x22),
          "ipfs://cipherbet/proof-grief-test"
        )
        .accounts({
          registry: registryPDA,
          market: marketGriefPDA,
          authority: authority.publicKey,
        })
        .rpc();

      const marketBeforeChallenge = await program.account.market.fetch(marketGriefPDA);
      const storedHash = Array.from(marketBeforeChallenge.artifacts.settlementHash as number[]);

      let failed = false;
      try {
        await program.methods
          .challengeSettlement(storedHash, 9)
          .accounts({
            registry: registryPDA,
            market: marketGriefPDA,
            challenger: challenger.publicKey,
          })
          .signers([challenger])
          .rpc();
      } catch {
        failed = true;
      }
      assert.equal(failed, true);

      const marketAfterChallenge = await program.account.market.fetch(marketGriefPDA);
      assert.deepEqual(marketAfterChallenge.status, { settledPending: {} });
    });

    it("tracks deposited stake for invalid/cancelled refunds", async () => {
      const [vaultFastPDA] = PublicKey.findProgramAddressSync(
        [VAULT_SEED, Buffer.from(new Uint8Array(8))],
        program.programId
      );
      const [positionPDA] = PublicKey.findProgramAddressSync(
        [POS_SEED, marketFastPDA.toBuffer(), authority.publicKey.toBuffer()],
        program.programId
      );

      const ata = await getOrCreateAssociatedTokenAccount(
        provider.connection,
        authority.payer,
        mint,
        authority.publicKey
      );
      await mintTo(
        provider.connection,
        authority.payer,
        mint,
        ata.address,
        authority.publicKey,
        10_000_000
      );

      const fakeEncStake = { c1: shortArray(0xaa), c2: shortArray(0xbb) };
      const fakeEncChoice = { c1: shortArray(0xcc), c2: shortArray(0xdd) };

      // This call may fail if position already exists from previous run; tolerate it.
      try {
        await program.methods
          .submitPosition(fakeEncStake, fakeEncChoice, new BN(1_000_000))
          .accounts({
            registry: registryPDA,
            market: marketFastPDA,
            position: positionPDA,
            vault: vaultFastPDA,
            userTokenAccount: ata.address,
            user: authority.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      } catch {}

      const position = await program.account.position.fetch(positionPDA);
      assert.equal(position.depositedStake.toNumber() > 0, true);
    });
  });
});
