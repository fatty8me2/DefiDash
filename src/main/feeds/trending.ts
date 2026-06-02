import type { TrendingList, TrendingToken } from '../../shared/types';

// GeckoTerminal public API — free, no key required, ~30 req/min.
// Docs: https://www.geckoterminal.com/dex-api
const BASE = 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'eth';

interface GtPoolAttributes {
  name?: string;
  address?: string;
  base_token_price_usd?: string;
  reserve_in_usd?: string;
  fdv_usd?: string;
  market_cap_usd?: string | null;
  pool_created_at?: string;
  volume_usd?: { h24?: string; h1?: string };
  price_change_percentage?: { h1?: string; h24?: string };
  transactions?: {
    h24?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
  };
}

interface GtPool {
  id: string;
  type: string;
  attributes: GtPoolAttributes;
  relationships?: {
    base_token?: { data?: { id?: string } };
  };
}

interface GtIncludedToken {
  id: string;
  type: string; // "token"
  attributes?: { address?: string; name?: string; symbol?: string };
}

interface GtResponse {
  data?: GtPool[];
  included?: GtIncludedToken[];
}

function endpointFor(list: TrendingList): string {
  switch (list) {
    case 'trending':
      return `${BASE}/networks/${NETWORK}/trending_pools?include=base_token&page=1`;
    case 'new':
      return `${BASE}/networks/${NETWORK}/new_pools?include=base_token&page=1`;
    case 'volume':
      return `${BASE}/networks/${NETWORK}/pools?include=base_token&page=1&sort=h24_volume_usd_desc`;
  }
}

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// base_token id looks like "eth_0xabc...". Strip the network prefix.
function addressFromTokenId(id: string | undefined): string | null {
  if (!id) return null;
  const idx = id.indexOf('_');
  const addr = idx >= 0 ? id.slice(idx + 1) : id;
  return addr.startsWith('0x') ? addr.toLowerCase() : null;
}

export async function fetchTrending(list: TrendingList): Promise<TrendingToken[]> {
  const res = await fetch(endpointFor(list), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GeckoTerminal ${list} HTTP ${res.status}`);
  const data: GtResponse = await res.json();

  // Map included base tokens by their id for symbol/name/address lookup.
  const tokenById = new Map<string, GtIncludedToken>();
  for (const inc of data.included ?? []) {
    if (inc.type === 'token') tokenById.set(inc.id, inc);
  }

  const out: TrendingToken[] = [];
  for (const pool of data.data ?? []) {
    const a = pool.attributes ?? {};
    const baseId = pool.relationships?.base_token?.data?.id;
    const token = baseId ? tokenById.get(baseId) : undefined;
    const contract = token?.attributes?.address?.toLowerCase() ?? addressFromTokenId(baseId);
    if (!contract) continue;

    const nameParts = (a.name ?? '').split(' / ');
    const symbol = token?.attributes?.symbol ?? (nameParts[0] || null);

    out.push({
      contract,
      pairAddress: (a.address ?? '').toLowerCase(),
      symbol,
      name: token?.attributes?.name ?? null,
      priceUsd: num(a.base_token_price_usd),
      priceChangeH1: num(a.price_change_percentage?.h1),
      priceChangeH24: num(a.price_change_percentage?.h24),
      volumeH24Usd: num(a.volume_usd?.h24),
      liquidityUsd: num(a.reserve_in_usd),
      fdvUsd: num(a.fdv_usd),
      marketCapUsd: num(a.market_cap_usd ?? null),
      buysH24: num(a.transactions?.h24?.buys ?? null),
      sellsH24: num(a.transactions?.h24?.sells ?? null),
      poolCreatedAt: a.pool_created_at
        ? Math.floor(new Date(a.pool_created_at).getTime() / 1000)
        : null,
      pairLabel: a.name ?? null
    });
  }
  return out;
}
