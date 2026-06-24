// Address/chain detection for watchlist + charts (Solana mints and ETH contracts).
export type WatchChain = 'ethereum' | 'solana';

const ETH_RE = /^0x[0-9a-fA-F]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function detectWatchChain(addr: string): WatchChain | null {
  const t = addr.trim();
  if (ETH_RE.test(t)) return 'ethereum';
  if (SOL_RE.test(t)) return 'solana';
  return null;
}

export function isEthAddr(a: string): boolean {
  return ETH_RE.test(a.trim());
}
