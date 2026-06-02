import type { BuyerRow, LookupResult } from '../../shared/types';

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const STABLES = new Set([
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
  '0x6b175474e89094c44da98b954eedeac495271d0f'  // DAI
]);

interface DexScreenerPair {
  chainId: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
}

interface DexScreenerResponse {
  pairs: DexScreenerPair[] | null;
}

interface AlchemyTransfer {
  blockNum: string; // hex
  hash: string;
  from: string;
  to: string;
  value: number; // already decoded by Alchemy
  asset: string;
  category: string;
  metadata: { blockTimestamp: string };
}

interface AlchemyTransferResponse {
  result?: { transfers: AlchemyTransfer[] };
  error?: { message: string };
}

interface PoolInfo {
  address: string;
  quoteSymbol: string;
  quoteIsStable: boolean;
  priceUsd: number | null;
  tokenSymbol: string;
  tokenName: string;
}

async function findEthereumPool(contract: string): Promise<PoolInfo | null> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${contract}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DexScreener error: ${res.status}`);
  const data: DexScreenerResponse = await res.json();
  if (!data.pairs || data.pairs.length === 0) return null;

  // Pick the highest-liquidity Ethereum pair where this token is the base
  const ethPairs = data.pairs.filter(
    (p) => p.chainId === 'ethereum' && p.baseToken.address.toLowerCase() === contract.toLowerCase()
  );
  if (ethPairs.length === 0) return null;

  ethPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const top = ethPairs[0];
  const quoteAddr = top.quoteToken.address.toLowerCase();
  return {
    address: top.pairAddress.toLowerCase(),
    quoteSymbol: top.quoteToken.symbol,
    quoteIsStable: STABLES.has(quoteAddr),
    priceUsd: top.priceUsd ? Number(top.priceUsd) : null,
    tokenSymbol: top.baseToken.symbol,
    tokenName: top.baseToken.name
  };
}

async function alchemyRpc(apiKey: string, method: string, params: unknown[]): Promise<unknown> {
  const url = `https://eth-mainnet.g.alchemy.com/v2/${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  if (!res.ok) throw new Error(`Alchemy ${method} HTTP ${res.status}`);
  return res.json();
}

// Get the most recent N transfers OF the token FROM the pool (= buys).
async function getBuyTransfers(
  apiKey: string,
  tokenContract: string,
  poolAddress: string,
  limit: number
): Promise<AlchemyTransfer[]> {
  const params = [
    {
      fromAddress: poolAddress,
      contractAddresses: [tokenContract],
      category: ['erc20'],
      order: 'desc',
      withMetadata: true,
      maxCount: `0x${limit.toString(16)}`,
      excludeZeroValue: true
    }
  ];
  const data = (await alchemyRpc(apiKey, 'alchemy_getAssetTransfers', params)) as AlchemyTransferResponse;
  if (data.error) throw new Error(`Alchemy error: ${data.error.message}`);
  return data.result?.transfers ?? [];
}

// For each buy, fetch the tx to find how much ETH/WETH/stable was paid.
async function getTxSpendValue(
  apiKey: string,
  txHash: string,
  buyer: string,
  pool: PoolInfo
): Promise<number> {
  // Pull all asset transfers in this tx that the buyer's wallet was involved in
  // by querying for transfers TO the pool from the buyer (the payment side).
  const params = [
    {
      fromAddress: buyer,
      toAddress: pool.address,
      category: ['external', 'erc20', 'internal'],
      order: 'desc',
      withMetadata: false,
      maxCount: '0xa',
      excludeZeroValue: true
    }
  ];
  // This is a heuristic — most swaps route through a router so this can miss.
  // For an MVP we instead fall back to estimating via token amount * priceUsd.
  // Keep this function as a placeholder; price-based USD estimate is used in caller.
  void params;
  void apiKey;
  void txHash;
  return 0;
}

export async function fetchEthereumBuyers(
  contract: string,
  alchemyKey: string,
  limit: number = 50
): Promise<LookupResult> {
  if (!alchemyKey) throw new Error('ALCHEMY_API_KEY is not set');

  const pool = await findEthereumPool(contract);
  if (!pool) throw new Error('No Ethereum DEX pool found for this token on DexScreener');

  const transfers = await getBuyTransfers(alchemyKey, contract, pool.address, limit);

  const buyers: BuyerRow[] = transfers.map((t) => {
    const tokenAmount = Number(t.value);
    const usdValue = pool.priceUsd ? tokenAmount * pool.priceUsd : null;
    const blockTime = Math.floor(new Date(t.metadata.blockTimestamp).getTime() / 1000);

    // Estimate spent amount: USD / current ETH or stable price.
    // For a true value we'd decode the swap event; this is a fast MVP estimate.
    const spentAmount = usdValue !== null ? usdValue / (pool.quoteIsStable ? 1 : 3500) : 0;

    return {
      chain: 'ethereum',
      wallet: t.to.toLowerCase(),
      txHash: t.hash,
      blockTime,
      tokenAmount,
      spentAmount,
      spentSymbol: pool.quoteIsStable ? pool.quoteSymbol : 'ETH',
      usdValue
    };
  });

  return {
    chain: 'ethereum',
    contract: contract.toLowerCase(),
    tokenSymbol: pool.tokenSymbol,
    tokenName: pool.tokenName,
    poolAddress: pool.address,
    buyers,
    fetchedAt: Date.now()
  };
}

// Re-export helper for use elsewhere if needed
export { getTxSpendValue };
