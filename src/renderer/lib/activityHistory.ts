import type { TrackedActivity } from '../../shared/types';

// Persistent history of tracked-wallet buy/sell notifications, kept in
// localStorage so the list survives navigation and app restarts. Fed by the
// always-mounted ActivityToasts subscriber; read by the Tracked Wallets page.
const KEY = 'tracked:history';
const MAX = 300;

export function loadHistory(): TrackedActivity[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function persist(list: TrackedActivity[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    window.dispatchEvent(new Event('tracked:history-changed'));
  } catch {
    /* ignore quota/serialization errors */
  }
}

/** Prepend a new activity (deduped by id, capped). */
export function appendActivity(a: TrackedActivity): void {
  const list = loadHistory();
  if (list.some((x) => x.id === a.id)) return;
  persist([a, ...list].slice(0, MAX));
}

export function clearHistory(): void {
  persist([]);
}
