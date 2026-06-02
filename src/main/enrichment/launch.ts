import type { BundleAnalysis, Chain, FunderCluster, SniperAnalysis } from '../../shared/types';

// Known CEX / mixer funding sources. CEX-funded buyers are normal noise; we only
// want to flag clusters funded by the SAME private wallet (an insider/bundle tell).
// Tornado is kept (not excluded) because shared-mixer funding is itself suspicious.
const ETH_KNOWN: Record<string, string> = {
  '0x28c6c06298d514db089934071355e5743bf21d60': 'Binance 14',
  '0xdfd5293d8e347dfe59e90efd55b2956a1343963d': 'Binance 16',
  '0x21a31ee1afc51d94c2efccaa2092ad1028285549': 'Binance 15',
  '0x9696f59e4d72e237be84ffd425dcad154bf96976': 'Binance 4',
  '0x46340b20830761efd32832a74d7169b29feb9758': 'Crypto.com',
  '0x77696bb39917c91a0c3908d577d5e322095425ca': 'Crypto.com 2',
  '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43': 'Coinbase 10',
  '0x71660c4005ba85c37ccec55d0c4493e66fe775d3': 'Coinbase 1',
  '0xa910f92acdaf488fa6ef02174fb86208ad7722ba': 'Coinbase Prime',
  '0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740': 'Coinbase 3',
  '0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503': 'Binance 7',
  '0xf977814e90da44bfa03b6295a0616a897441acec': 'Binance 8',
  '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf': 'Coinbase Hot 9'
};
const TORNADO: Record<string, string> = {
  '0x722122df12d4e14e13ac3b6895a86e84145b6967': 'Tornado.Cash',
  '0xd90e2f925da726b50c4ed8d0fb90ad053324f31b': 'Tornado.Cash',
  '0xd96f2b1c14db8458374d9aca76e26c3d18364307': 'Tornado.Cash 1ETH',
  '0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936': 'Tornado.Cash 10ETH'
};

const SNIPER_WINDOW_SECONDS = 120;   // first ~2 minutes of trading = the launch wave
const EARLY_SAMPLE = 100;            // how many of the very first buys to pull
const FUNDER_CAP = 30;               // cap funder lookups to protect rate limits
const CONCURRENCY = 5;

async function ethRpc(apiKey: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(`https://eth-mainnet.g.alchemy.com/v2/${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  if (!res.ok) throw new Error(`Alchemy ${method} HTTP ${res.status}`);
  return res.json();
}

interface PoolInfo {
  pairAddress: string;
  pairCreatedAt: number | null; // unix seconds
}

async function findPool(contract: string): Promise<PoolInfo | null> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${contract}`);
  if (!res.ok) return null;
  const data = await res.json();
  const pairs = ((data?.pairs ?? []) as any[]).filter(
    (p) => p.chainId === 'ethereum' && p.baseToken?.address?.toLowerCase() === contract.toLowerCase()
  );
  if (pairs.length === 0) return null;
  pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const top = pairs[0];
  return {
    pairAddress: String(top.pairAddress).toLowerCase(),
    pairCreatedAt: top.pairCreatedAt ? Math.floor(Number(top.pairCreatedAt) / 1000) : null
  };
}

// Earliest N token-out transfers from the pool = first buyers.
async function getEarliestBuys(
  apiKey: string,
  contract: string,
  pool: string
): Promise<{ wallet: string; blockTime: number; amount: number }[]> {
  const data = await ethRpc(apiKey, 'alchemy_getAssetTransfers', [{
    fromAddress: pool,
    contractAddresses: [contract],
    category: ['erc20'],
    order: 'asc',
    withMetadata: true,
    maxCount: `0x${EARLY_SAMPLE.toString(16)}`,
    excludeZeroValue: true
  }]);
  const transfers = (data?.result?.transfers ?? []) as any[];
  return transfers.map((t) => ({
    wallet: String(t.to).toLowerCase(),
    blockTime: Math.floor(new Date(t.metadata.blockTimestamp).getTime() / 1000),
    amount: Number(t.value) || 0
  }));
}

// First inbound ETH transfer to a wallet → its funding source.
async function getFunder(
  apiKey: string,
  wallet: string
): Promise<{ address: string; time: number | null } | null> {
  try {
    const data = await ethRpc(apiKey, 'alchemy_getAssetTransfers', [{
      toAddress: wallet,
      category: ['external'],
      order: 'asc',
      withMetadata: true,
      maxCount: '0x1',
      excludeZeroValue: false
    }]);
    const tx = data?.result?.transfers?.[0];
    if (!tx) return null;
    return {
      address: String(tx.from).toLowerCase(),
      time: tx.metadata?.blockTimestamp
        ? Math.floor(new Date(tx.metadata.blockTimestamp).getTime() / 1000)
        : null
    };
  } catch {
    return null;
  }
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await fn(items[cur]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const EMPTY_SNIPER: SniperAnalysis = {
  pairCreatedAt: null,
  windowSeconds: SNIPER_WINDOW_SECONDS,
  totalEarly: 0,
  sniperCount: 0,
  sniperSupplyPct: null,
  freshSniperCount: 0,
  note: null
};
const EMPTY_BUNDLE: BundleAnalysis = { checked: 0, clusters: [], note: null };

export async function analyzeLaunch(
  chain: Chain,
  contract: string,
  keys: { alchemyKey: string }
): Promise<{ sniper: SniperAnalysis; bundle: BundleAnalysis }> {
  if (chain !== 'ethereum') {
    return {
      sniper: { ...EMPTY_SNIPER, note: 'Launch analysis is Ethereum-only for now.' },
      bundle: { ...EMPTY_BUNDLE, note: 'Launch analysis is Ethereum-only for now.' }
    };
  }
  if (!keys.alchemyKey) throw new Error('Alchemy key required');

  const pool = await findPool(contract);
  if (!pool) {
    return {
      sniper: { ...EMPTY_SNIPER, note: 'No Ethereum pool found.' },
      bundle: { ...EMPTY_BUNDLE, note: 'No Ethereum pool found.' }
    };
  }

  const early = await getEarliestBuys(keys.alchemyKey, contract, pool.pairAddress);
  if (early.length === 0) {
    return {
      sniper: { ...EMPTY_SNIPER, pairCreatedAt: pool.pairCreatedAt, note: 'No early buys found.' },
      bundle: EMPTY_BUNDLE
    };
  }

  // t0 = pool creation if known, else the very first buy we saw.
  const t0 = pool.pairCreatedAt ?? early[0].blockTime;
  const totalAmount = early.reduce((s, b) => s + b.amount, 0);

  // Snipers: bought within the window of t0.
  const sniperBuys = early.filter((b) => b.blockTime <= t0 + SNIPER_WINDOW_SECONDS);
  const sniperWallets = new Set(sniperBuys.map((b) => b.wallet));
  const sniperAmount = sniperBuys.reduce((s, b) => s + b.amount, 0);
  const sniperSupplyPct = totalAmount > 0 ? (sniperAmount / totalAmount) * 100 : null;

  // Resolve funders for the unique early wallets (capped).
  const uniqueWallets = Array.from(new Set(early.map((b) => b.wallet))).slice(0, FUNDER_CAP);
  const funders = await mapLimited(uniqueWallets, CONCURRENCY, (w) => getFunder(keys.alchemyKey, w));

  // Fresh snipers: funded shortly before (or after) launch — classic burner pattern.
  let freshSniperCount = 0;
  const byFunder = new Map<string, string[]>();
  uniqueWallets.forEach((w, i) => {
    const f = funders[i];
    if (!f) return;
    if (sniperWallets.has(w) && f.time !== null && f.time >= t0 - 3 * 86400) freshSniperCount++;
    // Skip CEX funders for clustering — only private-wallet sharing is a bundle tell.
    if (ETH_KNOWN[f.address]) return;
    const arr = byFunder.get(f.address) ?? [];
    arr.push(w);
    byFunder.set(f.address, arr);
  });

  const clusters: FunderCluster[] = [];
  for (const [funder, wallets] of byFunder) {
    if (wallets.length < 2) continue;
    clusters.push({
      funder,
      funderLabel: TORNADO[funder] ?? null,
      wallets
    });
  }
  clusters.sort((a, b) => b.wallets.length - a.wallets.length);

  const sniper: SniperAnalysis = {
    pairCreatedAt: pool.pairCreatedAt,
    windowSeconds: SNIPER_WINDOW_SECONDS,
    totalEarly: early.length,
    sniperCount: sniperWallets.size,
    sniperSupplyPct,
    freshSniperCount,
    note:
      sniperWallets.size > 0 && sniperSupplyPct !== null
        ? `${sniperWallets.size} wallets sniped the first ${SNIPER_WINDOW_SECONDS}s, taking ${sniperSupplyPct.toFixed(0)}% of the opening volume.`
        : 'No concentrated sniping detected in the opening window.'
  };

  const bundledWallets = clusters.reduce((s, c) => s + c.wallets.length, 0);
  const bundle: BundleAnalysis = {
    checked: uniqueWallets.length,
    clusters,
    note:
      clusters.length > 0
        ? `${bundledWallets} early buyers across ${clusters.length} cluster(s) share a private funding wallet — possible coordinated/insider launch.`
        : 'No shared private funders among the early buyers checked.'
  };

  return { sniper, bundle };
}
