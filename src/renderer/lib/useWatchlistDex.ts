import { useEffect, useState } from 'react';

// Lightweight price/market-cap updater for watchlist coins via DexScreener, so a
// pinned coin always shows current info even when it's outside the live pump.fun
// window (or the firehose is paused). Runs continuously, batched, no API key.
export interface DexLite {
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
}

const REFRESH_MS = 20_000;

interface DexPair {
  baseToken?: { address?: string; symbol?: string; name?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
}

export function useWatchlistDex(pinned: string[]): Map<string, DexLite> {
  const [data, setData] = useState<Map<string, DexLite>>(new Map());
  const key = pinned.join(',');

  useEffect(() => {
    if (pinned.length === 0) {
      setData(new Map());
      return;
    }
    let cancelled = false;

    async function load() {
      try {
        const next = new Map<string, DexLite>();
        // DexScreener accepts up to 30 comma-separated addresses per request.
        for (let i = 0; i < pinned.length; i += 30) {
          const chunk = pinned.slice(i, i + 30);
          const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`);
          if (!res.ok) continue;
          const json = (await res.json()) as { pairs?: DexPair[] };
          const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
          // Highest-liquidity pair per base token.
          const best = new Map<string, DexPair>();
          for (const p of pairs) {
            const addr = p.baseToken?.address?.toLowerCase();
            if (!addr) continue;
            const liq = p.liquidity?.usd ?? 0;
            const cur = best.get(addr);
            if (!cur || liq > (cur.liquidity?.usd ?? 0)) best.set(addr, p);
          }
          for (const mint of chunk) {
            const p = best.get(mint.toLowerCase());
            if (!p) continue;
            next.set(mint, {
              symbol: p.baseToken?.symbol ?? null,
              name: p.baseToken?.name ?? null,
              priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
              marketCapUsd: typeof p.marketCap === 'number' ? p.marketCap : typeof p.fdv === 'number' ? p.fdv : null
            });
          }
        }
        if (!cancelled) setData(next);
      } catch {
        // keep the last good data on a transient error
      }
    }

    load();
    const iv = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return data;
}
