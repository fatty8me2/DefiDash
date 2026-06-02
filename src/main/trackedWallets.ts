import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import type { Chain, TrackedWallet } from '../shared/types';

// Tracked wallets live in a plain JSON file in userData. Unlike settings.bin we
// don't encrypt these — they're public chain addresses plus a user nickname,
// nothing secret.
function trackedFile(): string {
  return path.join(app.getPath('userData'), 'tracked-wallets.json');
}

// Canonical key for de-duping. ETH addresses are case-insensitive (we lowercase),
// Solana base58 is case-sensitive (left as-is).
function keyOf(chain: Chain, address: string): string {
  return chain === 'ethereum' ? `ethereum:${address.toLowerCase()}` : `solana:${address}`;
}

export function loadTracked(): TrackedWallet[] {
  try {
    const raw = fs.readFileSync(trackedFile(), 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (w: unknown): w is Record<string, unknown> =>
          !!w &&
          typeof (w as Record<string, unknown>).address === 'string' &&
          ((w as Record<string, unknown>).chain === 'ethereum' ||
            (w as Record<string, unknown>).chain === 'solana')
      )
      .map((w) => ({
        address: String(w.address),
        chain: w.chain as Chain,
        label: typeof w.label === 'string' ? w.label : '',
        addedAt: typeof w.addedAt === 'number' && Number.isFinite(w.addedAt)
          ? (w.addedAt as number)
          : Math.floor(Date.now() / 1000)
      }));
  } catch {
    // Missing file / bad JSON → empty list.
    return [];
  }
}

function persist(list: TrackedWallet[]): void {
  try {
    fs.writeFileSync(trackedFile(), JSON.stringify(list, null, 2), { mode: 0o600 });
  } catch {
    // Best-effort; a failed write just means the change isn't saved.
  }
}

// Add a wallet (newest first). If it already exists, only update the label when
// a non-empty one is supplied. Returns the updated list.
export function addTracked(chain: Chain, address: string, label: string): TrackedWallet[] {
  const list = loadTracked();
  const k = keyOf(chain, address);
  const existing = list.find((w) => keyOf(w.chain, w.address) === k);
  if (existing) {
    if (label.trim()) existing.label = label.trim();
  } else {
    list.unshift({
      address: address.trim(),
      chain,
      label: label.trim(),
      addedAt: Math.floor(Date.now() / 1000)
    });
  }
  persist(list);
  return list;
}

export function removeTracked(chain: Chain, address: string): TrackedWallet[] {
  const k = keyOf(chain, address);
  const list = loadTracked().filter((w) => keyOf(w.chain, w.address) !== k);
  persist(list);
  return list;
}

export function renameTracked(chain: Chain, address: string, label: string): TrackedWallet[] {
  const k = keyOf(chain, address);
  const list = loadTracked();
  for (const w of list) {
    if (keyOf(w.chain, w.address) === k) w.label = label.trim();
  }
  persist(list);
  return list;
}
