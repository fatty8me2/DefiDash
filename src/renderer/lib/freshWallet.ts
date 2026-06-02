// Heuristic: a wallet is "fresh" if it's brand new or barely used.
// Returns null if we don't have the data yet (so we don't flash a stale flag).
export function isFreshWallet(
  ageDays: number | null | undefined,
  txCount: number | null | undefined
): boolean | null {
  if (ageDays === undefined || txCount === undefined) return null;
  if (ageDays === null && txCount === null) return null;
  if (ageDays !== null && ageDays <= 3) return true;
  if (ageDays !== null && ageDays <= 14 && txCount !== null && txCount <= 10) return true;
  return false;
}
