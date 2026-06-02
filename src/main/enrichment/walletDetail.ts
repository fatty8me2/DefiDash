import type { Chain, WalletDetail, WalletHolding, WalletRecentBuy } from '../../shared/types';

// A few well-known funding sources so we can label first inflows.
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
  '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf': 'Coinbase Hot 9',
  '0x722122df12d4e14e13ac3b6895a86e84145b6967': 'Tornado.Cash',
  '0xd90e2f925da726b50c4ed8d0fb90ad053324f31b': 'Tornado.Cash',
  '0xd96f2b1c14db8458374d9aca76e26c3d18364307': 'Tornado.Cash 1ETH',
  '0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936': 'Tornado.Cash 10ETH'
};

// Batch-fetch current USD prices for a list of token contracts via DexScreener.
// Returns a lowercase-keyed map (for ETH) / mint-keyed map (for Solana).
// DexScreener supports up to 30 comma-separated addresses per request.
async function getTokenPricesUsd(
  chain: Chain,
  contracts: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (contracts.length === 0) return out;

  const chainId = chain === 'ethereum' ? 'ethereum' : 'solana';
  const unique = Array.from(new Set(contracts.map((c) => (chain === 'ethereum' ? c.toLowerCase() : c))));

  // Chunk into batches of 30
  for (let i = 0; i < unique.length; i += 30) {
    const batch = unique.slice(i, i + 30);
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`);
      if (!res.ok) continue;
      const data = await res.json();
      const pairs = (data?.pairs ?? []) as {
        chainId: string;
        baseToken: { address: string };
        priceUsd?: string;
        liquidity?: { usd?: number };
      }[];

      // For each token, pick the highest-liquidity pair on the right chain
      const best = new Map<string, { liq: number; price: number }>();
      for (const p of pairs) {
        if (p.chainId !== chainId) continue;
        if (!p.priceUsd) continue;
        const addr = chain === 'ethereum' ? p.baseToken.address.toLowerCase() : p.baseToken.address;
        const liq = p.liquidity?.usd ?? 0;
        const cur = best.get(addr);
        if (!cur || liq > cur.liq) best.set(addr, { liq, price: Number(p.priceUsd) });
      }
      for (const [addr, { price }] of best) out.set(addr, price);
    } catch {
      // ignore — leave missing entries unset
    }
  }
  return out;
}

async function ethRpc(apiKey: string, method: string, params: unknown[]): Promise<unknown> {
  const url = `https://eth-mainnet.g.alchemy.com/v2/${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  if (!res.ok) throw new Error(`Alchemy ${method} HTTP ${res.status}`);
  return res.json();
}

async function ethDetail(wallet: string, alchemyKey: string): Promise<WalletDetail> {
  // Three parallel queries: token balances (with prices via metadata), recent buys,
  // and the first incoming external tx (funding source).
  const [balancesJson, recentJson, fundingJson] = await Promise.all([
    ethRpc(alchemyKey, 'alchemy_getTokenBalances', [wallet, 'erc20']),
    ethRpc(alchemyKey, 'alchemy_getAssetTransfers', [{
      toAddress: wallet,
      category: ['erc20'],
      order: 'desc',
      withMetadata: true,
      maxCount: '0x14',
      excludeZeroValue: true
    }]),
    ethRpc(alchemyKey, 'alchemy_getAssetTransfers', [{
      toAddress: wallet,
      category: ['external'],
      order: 'asc',
      withMetadata: true,
      maxCount: '0x1',
      excludeZeroValue: false
    }])
  ]) as any[];

  // Funding source
  const fundTx = fundingJson?.result?.transfers?.[0];
  let fundingSource: string | null = null;
  let fundingTime: number | null = null;
  if (fundTx) {
    const from = String(fundTx.from).toLowerCase();
    fundingSource = ETH_KNOWN[from] ?? `${from.slice(0, 6)}…${from.slice(-4)}`;
    fundingTime = Math.floor(new Date(fundTx.metadata.blockTimestamp).getTime() / 1000);
  }

  // Top holdings: take top 10 non-zero balances, look up metadata for symbols.
  const raw = (balancesJson?.result?.tokenBalances ?? []) as { contractAddress: string; tokenBalance: string }[];
  const nonZero = raw.filter((b) => b.tokenBalance && b.tokenBalance !== '0x' && BigInt(b.tokenBalance) > 0n);
  // Sort by raw balance desc as a cheap proxy (no per-token USD without a price API call per token)
  nonZero.sort((a, b) => (BigInt(b.tokenBalance) > BigInt(a.tokenBalance) ? 1 : -1));
  const top = nonZero.slice(0, 10);
  const metas = await Promise.all(
    top.map((t) => ethRpc(alchemyKey, 'alchemy_getTokenMetadata', [t.contractAddress]).catch(() => null))
  );
  const topHoldings: WalletHolding[] = top.map((t, i) => {
    const meta: any = metas[i];
    const decimals = meta?.result?.decimals ?? 18;
    const symbol = meta?.result?.symbol ?? '???';
    return {
      symbol,
      contract: t.contractAddress,
      amount: Number(BigInt(t.tokenBalance)) / 10 ** decimals,
      usdValue: null
    };
  });

  // Recent buys: take the most recent unique-token transfers received.
  const transfers = (recentJson?.result?.transfers ?? []) as any[];
  const seen = new Set<string>();
  const recentBuys: WalletRecentBuy[] = [];
  for (const t of transfers) {
    const contract = (t.rawContract?.address ?? '').toLowerCase();
    if (!contract || seen.has(contract)) continue;
    seen.add(contract);
    recentBuys.push({
      symbol: t.asset ?? '???',
      contract,
      amount: Number(t.value) || 0,
      blockTime: Math.floor(new Date(t.metadata.blockTimestamp).getTime() / 1000),
      txHash: t.hash,
      usdValue: null
    });
    if (recentBuys.length >= 10) break;
  }

  // Batch-price all unique contracts in one (or a few) DexScreener calls.
  const prices = await getTokenPricesUsd(
    'ethereum',
    [...topHoldings.map((h) => h.contract), ...recentBuys.map((b) => b.contract)]
  );
  for (const h of topHoldings) {
    const p = prices.get(h.contract.toLowerCase());
    if (p) h.usdValue = h.amount * p;
  }
  for (const b of recentBuys) {
    const p = prices.get(b.contract.toLowerCase());
    if (p) b.usdValue = b.amount * p;
  }

  return { wallet, chain: 'ethereum', fundingSource, fundingTime, topHoldings, recentBuys };
}

async function solDetail(wallet: string, heliusKey: string): Promise<WalletDetail> {
  const [balancesRes, txsRes] = await Promise.all([
    fetch(`https://api.helius.xyz/v0/addresses/${wallet}/balances?api-key=${heliusKey}`),
    fetch(`https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${heliusKey}&type=SWAP&limit=20`)
  ]);

  let topHoldings: WalletHolding[] = [];
  if (balancesRes.ok) {
    const data = await balancesRes.json();
    const tokens = (data?.tokens ?? []) as { mint: string; amount: number; decimals: number }[];
    topHoldings = tokens
      .filter((t) => t.amount > 0)
      .sort((a, b) => b.amount / 10 ** b.decimals - a.amount / 10 ** a.decimals)
      .slice(0, 10)
      .map((t) => ({
        symbol: t.mint.slice(0, 4) + '…',
        contract: t.mint,
        amount: t.amount / 10 ** t.decimals,
        usdValue: null
      }));
  }

  const recentBuys: WalletRecentBuy[] = [];
  if (txsRes.ok) {
    const txs = (await txsRes.json()) as any[];
    const seen = new Set<string>();
    for (const tx of txs) {
      const got = (tx.tokenTransfers ?? []).find((t: any) => t.toUserAccount === wallet);
      if (!got) continue;
      if (seen.has(got.mint)) continue;
      seen.add(got.mint);
      recentBuys.push({
        symbol: got.mint.slice(0, 4) + '…',
        contract: got.mint,
        amount: got.tokenAmount ?? 0,
        blockTime: tx.timestamp,
        txHash: tx.signature,
        usdValue: null
      });
      if (recentBuys.length >= 10) break;
    }
  }

  // Batch-price holdings + recent buys, then upgrade symbols using DexScreener data
  // (cheaper than per-token Helius metadata calls).
  const allMints = [...topHoldings.map((h) => h.contract), ...recentBuys.map((b) => b.contract)];
  const prices = await getTokenPricesUsd('solana', allMints);
  for (const h of topHoldings) {
    const p = prices.get(h.contract);
    if (p) h.usdValue = h.amount * p;
  }
  for (const b of recentBuys) {
    const p = prices.get(b.contract);
    if (p) b.usdValue = b.amount * p;
  }

  // Best-effort symbol lookup: re-query DexScreener metadata only for items we have prices for
  // and overwrite the placeholder symbol if we find one.
  if (prices.size > 0) {
    try {
      const ids = Array.from(prices.keys()).slice(0, 30);
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ids.join(',')}`);
      if (res.ok) {
        const data = await res.json();
        const symBy = new Map<string, string>();
        for (const p of (data?.pairs ?? []) as any[]) {
          if (p.chainId === 'solana' && p.baseToken?.symbol) symBy.set(p.baseToken.address, p.baseToken.symbol);
        }
        for (const h of topHoldings) {
          const s = symBy.get(h.contract);
          if (s) h.symbol = s;
        }
        for (const b of recentBuys) {
          const s = symBy.get(b.contract);
          if (s) b.symbol = s;
        }
      }
    } catch {
      // keep placeholder symbols
    }
  }

  return {
    wallet,
    chain: 'solana',
    fundingSource: null, // Solana funding-source tracing is more involved; skipping for v1
    fundingTime: null,
    topHoldings,
    recentBuys
  };
}

export async function getWalletDetail(
  chain: Chain,
  wallet: string,
  keys: { alchemyKey: string; heliusKey: string }
): Promise<WalletDetail> {
  if (chain === 'ethereum') return ethDetail(wallet, keys.alchemyKey);
  return solDetail(wallet, keys.heliusKey);
}
