import { useEffect, useState } from 'react';

// Indicative price for tokens Jupiter can't route (they trade via the pump.fun
// bonding curve / PumpPortal, which has no quote endpoint). We pull the token's
// price in SOL from its highest-liquidity SOL-quoted DexScreener pair so the
// Trade tab can show an estimated "You receive" before the PumpPortal swap.
// DexScreener is CORS-friendly with no key (same as useWatchlistDex).
const WSOL = 'So11111111111111111111111111111111111111112';
const REFRESH_MS = 15_000;

export interface DexPriceSol {
  symbol: string | null;
  priceSol: number;          // token price denominated in SOL (from a SOL-quoted pair)
  priceUsd: number | null;   // token price in USD (for the indicative $ value)
}

interface DexPair {
  chainId?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceNative?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
}

// Polls DexScreener for a single Solana mint while `enabled`, returning the
// token's price in SOL (or null if no usable SOL-quoted pair exists).
export function useDexPriceSol(mint: string, enabled: boolean): DexPriceSol | null {
  const [data, setData] = useState<DexPriceSol | null>(null);

  useEffect(() => {
    if (!enabled || mint.length < 32) {
      setData(null);
      return;
    }
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
        if (!res.ok) return;
        const json = (await res.json()) as { pairs?: DexPair[] };
        const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
        // Highest-liquidity SOL-quoted Solana pair for this mint — that pair's
        // priceNative is the token's price in SOL directly.
        let best: DexPair | null = null;
        for (const p of pairs) {
          if (p.chainId && p.chainId !== 'solana') continue;
          if (p.baseToken?.address?.toLowerCase() !== mint.toLowerCase()) continue;
          if (p.quoteToken?.address !== WSOL) continue;
          const priceSol = Number(p.priceNative);
          if (!Number.isFinite(priceSol) || priceSol <= 0) continue;
          if (!best || (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0)) best = p;
        }
        if (cancelled) return;
        if (!best) { setData(null); return; }
        setData({
          symbol: best.baseToken?.symbol ?? null,
          priceSol: Number(best.priceNative),
          priceUsd: best.priceUsd ? Number(best.priceUsd) : null
        });
      } catch {
        // keep last good data on a transient error
      }
    }

    load();
    const iv = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [mint, enabled]);

  return data;
}
