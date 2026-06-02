import type { Chain } from '../../shared/types';

export interface WalletStats {
  ageDays: number | null;
  txCount: number | null;
  nativeBalance: number | null; // ETH or SOL
  tokenCount: number | null;
  isContract: boolean | null;   // ETH only
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

async function ethWalletStats(wallet: string, alchemyKey: string): Promise<WalletStats> {
  const [countJson, firstJson, balJson, codeJson, balancesJson] = await Promise.all([
    ethRpc(alchemyKey, 'eth_getTransactionCount', [wallet, 'latest']),
    ethRpc(alchemyKey, 'alchemy_getAssetTransfers', [{
      fromAddress: wallet,
      category: ['external'],
      order: 'asc',
      withMetadata: true,
      maxCount: '0x1',
      excludeZeroValue: false
    }]),
    ethRpc(alchemyKey, 'eth_getBalance', [wallet, 'latest']),
    ethRpc(alchemyKey, 'eth_getCode', [wallet, 'latest']),
    ethRpc(alchemyKey, 'alchemy_getTokenBalances', [wallet, 'erc20'])
  ]) as any[];

  const txCount = countJson?.result ? parseInt(countJson.result, 16) : null;

  const first = firstJson?.result?.transfers?.[0];
  let ageDays: number | null = null;
  if (first?.metadata?.blockTimestamp) {
    const t = new Date(first.metadata.blockTimestamp).getTime();
    ageDays = Math.floor((Date.now() - t) / 86400_000);
  }

  const nativeBalance = balJson?.result ? Number(BigInt(balJson.result)) / 1e18 : null;

  const code = codeJson?.result as string | undefined;
  const isContract = code !== undefined ? code !== '0x' && code.length > 2 : null;

  // Count non-zero token balances
  const balances = balancesJson?.result?.tokenBalances as { tokenBalance: string }[] | undefined;
  const tokenCount = balances
    ? balances.filter((b) => b.tokenBalance && b.tokenBalance !== '0x' && BigInt(b.tokenBalance) > 0n).length
    : null;

  return { ageDays, txCount, nativeBalance, tokenCount, isContract };
}

interface HeliusBalances {
  nativeBalance: number;
  tokens: { mint: string; amount: number; decimals: number }[];
}

async function solWalletStats(wallet: string, heliusKey: string): Promise<WalletStats> {
  // Helius /balances gives us SOL + all SPL tokens in one call.
  const balancesPromise = fetch(
    `https://api.helius.xyz/v0/addresses/${wallet}/balances?api-key=${heliusKey}`
  ).then((r) => (r.ok ? (r.json() as Promise<HeliusBalances>) : null));

  // Paginate recent txs to estimate age + count (capped at 500).
  const txPromise = (async () => {
    let oldest: number | null = null;
    let count = 0;
    let before: string | undefined;
    const maxPages = 5;
    for (let i = 0; i < maxPages; i++) {
      const u = new URL(`https://api.helius.xyz/v0/addresses/${wallet}/transactions`);
      u.searchParams.set('api-key', heliusKey);
      u.searchParams.set('limit', '100');
      if (before) u.searchParams.set('before', before);
      const res = await fetch(u.toString());
      if (!res.ok) break;
      const txs = await res.json();
      if (!Array.isArray(txs) || txs.length === 0) break;
      count += txs.length;
      oldest = txs[txs.length - 1].timestamp ?? oldest;
      if (txs.length < 100) break;
      before = txs[txs.length - 1].signature;
    }
    return { oldest, count };
  })();

  const [balances, txInfo] = await Promise.all([balancesPromise, txPromise]);

  const ageDays = txInfo.oldest ? Math.floor((Date.now() / 1000 - txInfo.oldest) / 86400) : null;
  const nativeBalance = balances?.nativeBalance != null ? balances.nativeBalance / 1e9 : null;
  const tokenCount = balances?.tokens ? balances.tokens.filter((t) => t.amount > 0).length : null;

  return { ageDays, txCount: txInfo.count, nativeBalance, tokenCount, isContract: null };
}

export async function getWalletStats(
  chain: Chain,
  wallet: string,
  keys: { alchemyKey: string; heliusKey: string }
): Promise<WalletStats> {
  try {
    if (chain === 'ethereum') return await ethWalletStats(wallet, keys.alchemyKey);
    return await solWalletStats(wallet, keys.heliusKey);
  } catch {
    return { ageDays: null, txCount: null, nativeBalance: null, tokenCount: null, isContract: null };
  }
}

// Look up how much of the SPECIFIC token a wallet currently holds, as a fraction
// of the amount they bought (so we can show "still holding 87% of buy").
export async function getStillHoldingPct(
  chain: Chain,
  wallet: string,
  tokenContract: string,
  boughtAmount: number,
  keys: { alchemyKey: string; heliusKey: string }
): Promise<number | null> {
  if (boughtAmount <= 0) return null;
  try {
    if (chain === 'ethereum') {
      const [balJson, metaJson] = await Promise.all([
        ethRpc(keys.alchemyKey, 'alchemy_getTokenBalances', [wallet, [tokenContract]]),
        ethRpc(keys.alchemyKey, 'alchemy_getTokenMetadata', [tokenContract])
      ]) as any[];
      const raw = balJson?.result?.tokenBalances?.[0]?.tokenBalance;
      const decimals = metaJson?.result?.decimals ?? 18;
      if (!raw || raw === '0x') return 0;
      const current = Number(BigInt(raw)) / 10 ** decimals;
      return current / boughtAmount;
    } else {
      const res = await fetch(
        `https://api.helius.xyz/v0/addresses/${wallet}/balances?api-key=${keys.heliusKey}`
      );
      if (!res.ok) return null;
      const data = (await res.json()) as HeliusBalances;
      const t = data.tokens?.find((x) => x.mint === tokenContract);
      if (!t) return 0;
      const current = t.amount / 10 ** t.decimals;
      return current / boughtAmount;
    }
  } catch {
    return null;
  }
}

// Heuristic 0..100 smart score from purely-local signals.
// Tuned to feel right at a glance, not for scientific accuracy:
//   - old + active + holding native balance + diversified + still-holding = high
//   - contracts get penalized (likely MEV/sniper bots)
export function computeSmartScore(stats: {
  ageDays: number | null;
  txCount: number | null;
  nativeBalance: number | null;
  tokenCount: number | null;
  stillHoldingPct: number | null;
  isContract: boolean | null;
}): number | null {
  const { ageDays, txCount, nativeBalance, tokenCount, stillHoldingPct, isContract } = stats;
  if (ageDays === null && txCount === null && nativeBalance === null) return null;

  const ageScore = clamp01((ageDays ?? 0) / 180);
  const txScore = clamp01(Math.log10(1 + (txCount ?? 0)) / 3);
  const balScore = clamp01(Math.log10(1 + (nativeBalance ?? 0)) / 2);
  const divScore = clamp01(Math.log10(1 + (tokenCount ?? 0)) / 2);
  const holdScore = stillHoldingPct === null ? 0.5 : clamp01(stillHoldingPct);

  let score =
    (0.25 * ageScore +
      0.20 * txScore +
      0.20 * balScore +
      0.15 * divScore +
      0.20 * holdScore) *
    100;

  if (isContract === true) score -= 30;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
