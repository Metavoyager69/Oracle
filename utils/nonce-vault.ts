import type { WalletContextState } from "@solana/wallet-adapter-react";

// The nonce vault keeps the stake blinding nonce only in the browser, encrypted
// with a key derived from the wallet's signature. Mainnet ops should document
// backup/recovery expectations because this value is intentionally not stored
// on the backend.
const encoder = new TextEncoder();
const VAULT_MESSAGE = "Oracle nonce vault v1";

type WalletSigner = Pick<WalletContextState, "publicKey" | "signMessage" | "connected">;

type StoredNoncePayload = {
  v: number;
  iv: string;
  ct: string;
};

const keyCache = new Map<string, CryptoKey>();

function toBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  if (typeof Buffer !== "undefined") {
    const source = Buffer.from(value, "base64");
    const bytes = new Uint8Array(source.byteLength);
    bytes.set(source);
    return bytes;
  }
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function toCryptoBytes(
  value: ArrayBufferLike | ArrayBufferView<ArrayBufferLike>
): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.byteLength);
    bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return bytes;
  }

  const bytes = new Uint8Array(value.byteLength);
  bytes.set(new Uint8Array(value));
  return bytes;
}

function storageKey(wallet: string, marketId: number, commitment: Uint8Array): string {
  const commitHex = toHex(commitment);
  return `oracle:nonce:${wallet}:${marketId}:${commitHex}`;
}

async function deriveVaultKey(wallet: WalletSigner): Promise<CryptoKey> {
  if (!wallet.connected || !wallet.publicKey || !wallet.signMessage) {
    throw new Error("Wallet must be connected and able to sign to store nonce.");
  }
  const walletKey = wallet.publicKey.toBase58();
  const cached = keyCache.get(walletKey);
  if (cached) return cached;

  // The signing wallet derives the local encryption key, which means the vault
  // contents are tied to that wallet/session and are not globally recoverable.
  const signature = toCryptoBytes(await wallet.signMessage(encoder.encode(VAULT_MESSAGE)));
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    "raw",
    signature,
    "HKDF",
    false,
    ["deriveKey"]
  );
  const salt = await globalThis.crypto.subtle.digest(
    "SHA-256",
    encoder.encode(walletKey)
  );
  const key = await globalThis.crypto.subtle.deriveKey(
    {
      name: "HKDF",
      salt,
      info: encoder.encode("oracle-nonce-vault"),
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );

  keyCache.set(walletKey, key);
  return key;
}

export async function storeStakeNonce(
  wallet: WalletSigner,
  marketId: number,
  commitment: Uint8Array,
  stakeNonce: Uint8Array
): Promise<void> {
  const key = await deriveVaultKey(wallet);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    toCryptoBytes(stakeNonce)
  );

  const payload: StoredNoncePayload = {
    v: 1,
    iv: toBase64(iv),
    ct: toBase64(ciphertext),
  };

  const walletKey = wallet.publicKey?.toBase58() ?? "unknown";
  localStorage.setItem(storageKey(walletKey, marketId, commitment), JSON.stringify(payload));
}

export async function loadStakeNonce(
  wallet: WalletSigner,
  marketId: number,
  commitment: Uint8Array
): Promise<Uint8Array | null> {
  const walletKey = wallet.publicKey?.toBase58();
  if (!walletKey) return null;
  const stored = localStorage.getItem(storageKey(walletKey, marketId, commitment));
  if (!stored) return null;

  const payload = JSON.parse(stored) as StoredNoncePayload;
  if (!payload?.iv || !payload?.ct) return null;

  const key = await deriveVaultKey(wallet);
  const iv = fromBase64(payload.iv);
  const ciphertext = fromBase64(payload.ct);
  const plaintext = await globalThis.crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    toCryptoBytes(ciphertext)
  );

  return new Uint8Array(plaintext);
}

function toHex(value: Uint8Array): string {
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
