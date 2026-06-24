import { app, safeStorage } from 'electron';
import path from 'path';
import fs from 'fs';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// The trading wallets' secret keys are the most sensitive thing this app touches,
// so they live ONLY in the main process and are encrypted at rest with the OS
// keychain (safeStorage), exactly like the API keys in settings.bin. The
// renderer never receives a secret except via an explicit, user-initiated
// "reveal" action (so a generated burner can be backed up).
//
// Multiple wallets are supported: the store holds an array of keypairs plus the
// index of the active one (the wallet trades execute from).

interface StoredWallet {
  secret: number[];
}
interface WalletStore {
  wallets: StoredWallet[];
  activeIndex: number;
}

let cache: { keys: Keypair[]; activeIndex: number } | null = null;

function walletFile(): string {
  return path.join(app.getPath('userData'), 'trade-wallet.bin');
}

function load(): { keys: Keypair[]; activeIndex: number } {
  if (cache) return cache;
  const file = walletFile();
  if (!fs.existsSync(file)) {
    cache = { keys: [], activeIndex: 0 };
    return cache;
  }
  try {
    const buf = fs.readFileSync(file);
    const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
    const parsed = JSON.parse(json) as Partial<WalletStore> & { secretKey?: number[] };
    let keys: Keypair[] = [];
    let activeIndex = 0;
    if (Array.isArray(parsed.wallets)) {
      keys = parsed.wallets
        .filter((w) => Array.isArray(w?.secret))
        .map((w) => Keypair.fromSecretKey(Uint8Array.from(w.secret)));
      activeIndex = typeof parsed.activeIndex === 'number' ? parsed.activeIndex : 0;
    } else if (Array.isArray(parsed.secretKey)) {
      // Legacy single-wallet format — migrate to the array store.
      keys = [Keypair.fromSecretKey(Uint8Array.from(parsed.secretKey))];
      activeIndex = 0;
    }
    if (activeIndex < 0 || activeIndex >= keys.length) activeIndex = 0;
    cache = { keys, activeIndex };
    return cache;
  } catch {
    cache = { keys: [], activeIndex: 0 };
    return cache;
  }
}

function persist(): void {
  if (!cache) return;
  const store: WalletStore = {
    wallets: cache.keys.map((k) => ({ secret: Array.from(k.secretKey) })),
    activeIndex: cache.activeIndex
  };
  const json = JSON.stringify(store);
  const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8');
  fs.writeFileSync(walletFile(), buf, { mode: 0o600 });
}

function parseSecret(secret: string): Keypair {
  const trimmed = secret.trim();
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

/** The active keypair (cached), or null if no wallet is configured. */
export function loadWallet(): Keypair | null {
  const s = load();
  return s.keys[s.activeIndex] ?? null;
}

/** Public address (base58) of the active wallet, or null. */
export function getPublicKey(): string | null {
  const kp = loadWallet();
  return kp ? kp.publicKey.toBase58() : null;
}

/** Every wallet's public address plus which one is active. */
export function listWallets(): { address: string; active: boolean }[] {
  const s = load();
  return s.keys.map((k, i) => ({ address: k.publicKey.toBase58(), active: i === s.activeIndex }));
}

/** Generate a fresh burner, append it, make it active, return it. */
export function generateWallet(): Keypair {
  const s = load();
  const kp = Keypair.generate();
  s.keys.push(kp);
  s.activeIndex = s.keys.length - 1;
  persist();
  return kp;
}

/**
 * Import a wallet from a base58 secret key or a JSON byte array. If it's already
 * in the store, just make it active. Appends + activates + returns it.
 */
export function importWallet(secret: string): Keypair {
  const s = load();
  const kp = parseSecret(secret);
  const addr = kp.publicKey.toBase58();
  const existing = s.keys.findIndex((k) => k.publicKey.toBase58() === addr);
  if (existing >= 0) {
    s.activeIndex = existing;
  } else {
    s.keys.push(kp);
    s.activeIndex = s.keys.length - 1;
  }
  persist();
  return kp;
}

/** Make the wallet with this address the active one. */
export function selectWallet(address: string): void {
  const s = load();
  const idx = s.keys.findIndex((k) => k.publicKey.toBase58() === address);
  if (idx >= 0) {
    s.activeIndex = idx;
    persist();
  }
}

/** Remove a wallet (by address, or the active one if omitted). */
export function removeWallet(address?: string): void {
  const s = load();
  const idx = address ? s.keys.findIndex((k) => k.publicKey.toBase58() === address) : s.activeIndex;
  if (idx < 0 || idx >= s.keys.length) return;
  s.keys.splice(idx, 1);
  if (s.activeIndex >= s.keys.length) s.activeIndex = Math.max(0, s.keys.length - 1);
  persist();
}

/** Reveal the active wallet's secret key as base58 — user-initiated backup only. */
export function exportSecret(): string | null {
  const kp = loadWallet();
  return kp ? bs58.encode(kp.secretKey) : null;
}
