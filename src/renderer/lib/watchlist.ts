// Shared accessor for the Pump Flow watchlist — persisted in localStorage as an
// array of SPL mint addresses. Used by both PumpFlowPage (the watchlist UI) and
// TradePage (so tokens you buy are auto-pinned to the watchlist).
export const WATCHLIST_KEY = 'pumpflow:watchlist';

export function loadWatchlist(): string[] {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function saveWatchlist(mints: string[]): void {
  try {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(mints));
    // Let any open view re-sync (same-document storage events don't fire).
    window.dispatchEvent(new Event('watchlist:changed'));
  } catch {
    /* ignore quota/serialization errors */
  }
}

/** Append a mint if it isn't already pinned. Returns true if it was newly added. */
export function addToWatchlist(mint: string): boolean {
  const list = loadWatchlist();
  if (list.includes(mint)) return false;
  saveWatchlist([...list, mint]);
  return true;
}

/** Remove a mint from the watchlist. */
export function removeFromWatchlist(mint: string): void {
  saveWatchlist(loadWatchlist().filter((m) => m !== mint));
}
