// Mints the user has hidden from the Trade tab's "Your tokens" list. Persisted
// in localStorage so the choice survives closing and reopening the app.
export const HIDDEN_TOKENS_KEY = 'trade:hiddenTokens';

export function loadHidden(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_TOKENS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function saveHidden(mints: string[]): void {
  try {
    localStorage.setItem(HIDDEN_TOKENS_KEY, JSON.stringify(mints));
  } catch {
    /* ignore quota/serialization errors */
  }
}
