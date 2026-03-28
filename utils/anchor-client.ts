import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { Ciphertext } from "./arcium";
import {
  MARKET_TOKEN_MINT,
  MARKET_TOKEN_SYMBOL,
  PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getBondVaultPDA,
  getMarketPDA,
  getPositionPDA,
  getRegistryPDA,
  getVaultPDA,
} from "./program";

// The Next.js app does not currently bundle an Anchor IDL, so these helpers
// encode the two client-facing instructions directly using Anchor's standard
// discriminator + Borsh layout. That keeps the UI able to send real program
// transactions without waiting on generated client code.
const CREATE_MARKET_DISCRIMINATOR = Uint8Array.from([103, 226, 97, 235, 200, 188, 251, 254]);
const SUBMIT_POSITION_DISCRIMINATOR = Uint8Array.from([164, 179, 77, 239, 217, 239, 158, 151]);
const REGISTRY_TOTAL_MARKETS_OFFSET = 232;
const REGISTRY_MIN_SIZE = REGISTRY_TOTAL_MARKETS_OFFSET + 8;

export interface CreateMarketTransactionResult {
  marketId: number;
  registry: PublicKey;
  market: PublicKey;
  vault: PublicKey;
  bondVault: PublicKey;
  tokenMint: PublicKey;
  transaction: Transaction;
}

export interface SubmitPositionTransactionResult {
  market: PublicKey;
  position: PublicKey;
  vault: PublicKey;
  userTokenAccount: PublicKey;
  tokenMint: PublicKey;
  transaction: Transaction;
}

function requireTokenMint(tokenMint?: PublicKey | null): PublicKey {
  const configuredMint = tokenMint ?? MARKET_TOKEN_MINT;
  if (!configuredMint) {
    throw new Error(
      "Set NEXT_PUBLIC_MARKET_TOKEN_MINT before using the chain-backed market flow."
    );
  }
  return configuredMint;
}

function encodeU32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
}

function encodeU64(value: number | bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value), 0);
  return out;
}

function encodeI64(value: number | bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigInt64LE(BigInt(value), 0);
  return out;
}

function encodeString(value: string): Buffer {
  const encoded = Buffer.from(new TextEncoder().encode(value));
  return Buffer.concat([encodeU32(encoded.length), encoded]);
}

function toFixedBytes(name: string, value: Uint8Array, size: number): Buffer {
  if (value.length !== size) {
    throw new Error(`${name} must be exactly ${size} bytes.`);
  }
  return Buffer.from(value);
}

function encodeCiphertext(value: Ciphertext): Buffer {
  return Buffer.concat([
    toFixedBytes("encryptedStake.c1", value.c1, 32),
    toFixedBytes("encryptedStake.c2", value.c2, 32),
  ]);
}

async function readRegistryMarketCount(connection: Connection): Promise<number> {
  const [registry] = getRegistryPDA();
  const info = await connection.getAccountInfo(registry);
  if (!info) {
    throw new Error(
      "Prediction market registry is not initialized on this cluster yet."
    );
  }

  const raw = Buffer.from(info.data);
  if (raw.length < REGISTRY_MIN_SIZE) {
    throw new Error("Registry account is smaller than expected.");
  }

  const totalMarkets = raw.readBigUInt64LE(REGISTRY_TOTAL_MARKETS_OFFSET);
  if (totalMarkets > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Registry market counter is too large for the web client.");
  }
  return Number(totalMarkets);
}

export async function marketExistsOnChain(
  connection: Connection,
  marketId: number
): Promise<boolean> {
  const [market] = getMarketPDA(marketId);
  const info = await connection.getAccountInfo(market);
  return Boolean(info);
}

export async function buildCreateMarketTransaction(args: {
  connection: Connection;
  title: string;
  description: string;
  resolutionTimestamp: Date;
  creator: PublicKey;
  tokenMint?: PublicKey | null;
}): Promise<CreateMarketTransactionResult> {
  const tokenMint = requireTokenMint(args.tokenMint);
  const marketId = await readRegistryMarketCount(args.connection);
  const [registry] = getRegistryPDA();
  const [market] = getMarketPDA(marketId);
  const [vault] = getVaultPDA(marketId);
  const [bondVault] = getBondVaultPDA(marketId);

  const instruction = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: registry, isSigner: false, isWritable: true },
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: bondVault, isSigner: false, isWritable: true },
      { pubkey: tokenMint, isSigner: false, isWritable: false },
      { pubkey: args.creator, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from(CREATE_MARKET_DISCRIMINATOR),
      encodeString(args.title),
      encodeString(args.description),
      encodeI64(Math.floor(args.resolutionTimestamp.getTime() / 1000)),
    ]),
  });

  return {
    marketId,
    registry,
    market,
    vault,
    bondVault,
    tokenMint,
    transaction: new Transaction().add(instruction),
  };
}

export async function buildSubmitPositionTransaction(args: {
  connection: Connection;
  marketId: number;
  user: PublicKey;
  encryptedStake: Ciphertext;
  encryptedChoice: Ciphertext;
  amount: bigint;
  commitment: Uint8Array;
  tokenMint?: PublicKey | null;
  userTokenAccount?: PublicKey;
}): Promise<SubmitPositionTransactionResult> {
  const tokenMint = requireTokenMint(args.tokenMint);
  const [market] = getMarketPDA(args.marketId);
  const [vault] = getVaultPDA(args.marketId);
  const [position] = getPositionPDA(market, args.user);
  const userTokenAccount =
    args.userTokenAccount ?? getAssociatedTokenAddress(tokenMint, args.user);

  const [marketInfo, positionInfo, userTokenInfo] = await Promise.all([
    args.connection.getAccountInfo(market),
    args.connection.getAccountInfo(position),
    args.connection.getAccountInfo(userTokenAccount),
  ]);

  if (!marketInfo) {
    throw new Error(
      "This market is not initialized on-chain yet. Use a chain-backed market or mirror one first."
    );
  }
  if (positionInfo) {
    throw new Error("This wallet already has an on-chain position for this market.");
  }
  if (!userTokenInfo) {
    throw new Error(
      `No ${MARKET_TOKEN_SYMBOL} token account was found for this wallet. Fund the configured token mint first.`
    );
  }

  const instruction = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: market, isSigner: false, isWritable: true },
      { pubkey: position, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: args.user, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      Buffer.from(SUBMIT_POSITION_DISCRIMINATOR),
      encodeCiphertext(args.encryptedStake),
      encodeCiphertext(args.encryptedChoice),
      encodeU64(args.amount),
      toFixedBytes("commitment", args.commitment, 32),
    ]),
  });

  return {
    market,
    position,
    vault,
    userTokenAccount,
    tokenMint,
    transaction: new Transaction().add(instruction),
  };
}
