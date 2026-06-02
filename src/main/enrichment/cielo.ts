import type { Chain } from '../../shared/types';

export interface CieloStats {
  realizedPnlUsd: number | null;
  winRatePct: number | null;
  smartScore: number | null;
}

const EMPTY: CieloStats = { realizedPnlUsd: null, winRatePct: null, smartScore: null };

// Cielo's public PnL endpoint. They expose:
//   GET https://feed-api.cielo.finance/api/v1/{wallet}/pnl/total-stats?timeframe=30d
// The response includes realized_pnl_usd, winrate, etc. We compute a tiny
// "smart score" locally from those numbers so the UI has one column to sort by.
//
// If CIELO_API_KEY is unset OR the request fails, return nulls — the UI
// is built to render gracefully when these are missing.
export async function getCieloStats(
  chain: Chain,
  wallet: string,
  cieloKey: string | undefined
): Promise<CieloStats> {
  if (!cieloKey) return EMPTY;

  try {
    const url = `https://feed-api.cielo.finance/api/v1/${wallet}/pnl/total-stats?timeframe=30d&chains=${chain}`;
    const res = await fetch(url, {
      headers: { 'X-API-KEY': cieloKey, accept: 'application/json' }
    });
    if (!res.ok) return EMPTY;
    const json = await res.json();
    const data = json?.data ?? json;

    const realizedPnlUsd = numberOrNull(data?.realized_pnl_usd);
    const winRatePct = numberOrNull(data?.winrate);

    let smartScore: number | null = null;
    if (realizedPnlUsd !== null && winRatePct !== null) {
      // Cheap heuristic 0–100. Tuned to feel right at a glance, not for science:
      //   - 50% win rate baseline
      //   - +1 point per $1k realized P&L over the window, capped
      const pnlPoints = Math.max(-25, Math.min(25, realizedPnlUsd / 1000));
      const wrPoints = (winRatePct - 50) * 0.8;
      smartScore = Math.max(0, Math.min(100, Math.round(50 + pnlPoints + wrPoints)));
    }

    return { realizedPnlUsd, winRatePct, smartScore };
  } catch {
    return EMPTY;
  }
}

function numberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
