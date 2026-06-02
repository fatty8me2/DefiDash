import type { BuyerRow, LookupResult } from '../../shared/types';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const STABLES = new Set([USDC_MINT, USDT_MINT]);

interface HeliusTokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  mint: string;
  tokenAmount: number;
}

interface HeliusNativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number; // lamports
}

interface HeliusTransaction {
  signature: string;
  timestamp: number;
  type: string;
  feePayer: string;
  source?: string;
  tokenTransfers: HeliusTokenTransfer[];
  nativeTransfers: HeliusNativeTransfer[];
  events?: {
    swap?: {
      nativeInput?: { account: string; amount: string };
      nativeOutput?: { account: string; amount: string };
      tokenInputs?: { userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }[];
      tokenOutputs?: { userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }[];
    };
  };
}

interface DexScreenerPair {
  chainId: string;
  priceUsd?: string;
  baseToken: { address: string; symbol: string; name: string };
  liquidity?: { usd?: number };
}

interface DexScreenerResponse {
  pairs: DexScreenerPair[] | null;
}

async function getSolanaTokenMeta(mint: string): Promise<{ symbol?: string; name?: string; priceUsd: number | null }> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!res.ok) return { priceUsd: null };
    const data: DexScreenerResponse = await res.json();
    const solPairs = (data.pairs ?? []).filter(
      (p) => p.chainId === 'solana' && p.baseToken.address === mint
    );
    if (solPairs.length === 0) return { priceUsd: null };
    solPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const top = solPairs[0];
    return {
      symbol: top.baseToken.symbol,
      name: top.baseToken.name,
      priceUsd: top.priceUsd ? Number(top.priceUsd) : null
    };
  } catch {
    return { priceUsd: null };
  }
}

// Decode one parsed swap. Returns null if this isn't a buy of `mint`.
function decodeSwap(tx: HeliusTransaction, mint: string): BuyerRow | null {
  // Prefer the structured swap event when present.
  const swap = tx.events?.swap;
  let buyer: string | null = null;
  let tokenAmount = 0;
  let spentAmount = 0;
  let spentSymbol = 'SOL';

  if (swap?.tokenOutputs && swap.tokenOutputs.length > 0) {
    const out = swap.tokenOutputs.find((o) => o.mint === mint);
    if (!out) return null;
    buyer = out.userAccount;
    const decimals = out.rawTokenAmount.decimals;
    tokenAmount = Number(out.rawTokenAmount.tokenAmount) / 10 ** decimals;

    if (swap.nativeInput?.amount) {
      spentAmount = Number(swap.nativeInput.amount) / 1e9;
      spentSymbol = 'SOL';
    } else if (swap.tokenInputs && swap.tokenInputs.length > 0) {
      const inp = swap.tokenInputs[0];
      const d = inp.rawTokenAmount.decimals;
      spentAmount = Number(inp.rawTokenAmount.tokenAmount) / 10 ** d;
      spentSymbol = STABLES.has(inp.mint) ? 'USDC' : inp.mint.slice(0, 4);
    }
  } else {
    // Fall back to inspecting tokenTransfers — pick the incoming side of `mint`.
    const incoming = tx.tokenTransfers.find((t) => t.mint === mint);
    if (!incoming) return null;
    buyer = incoming.toUserAccount;
    tokenAmount = incoming.tokenAmount;

    // Sum native (SOL) transfers out from the buyer
    const sol = tx.nativeTransfers
      .filter((n) => n.fromUserAccount === buyer)
      .reduce((s, n) => s + n.amount, 0);
    if (sol > 0) {
      spentAmount = sol / 1e9;
      spentSymbol = 'SOL';
    } else {
      // Check for stable outgoing
      const stableOut = tx.tokenTransfers.find(
        (t) => STABLES.has(t.mint) && t.fromUserAccount === buyer
      );
      if (stableOut) {
        spentAmount = stableOut.tokenAmount;
        spentSymbol = stableOut.mint === USDC_MINT ? 'USDC' : 'USDT';
      }
    }
  }

  if (!buyer || tokenAmount <= 0) return null;

  return {
    chain: 'solana',
    wallet: buyer,
    txHash: tx.signature,
    blockTime: tx.timestamp,
    tokenAmount,
    spentAmount,
    spentSymbol,
    usdValue: null // filled in below using token price
  };
}

export async function fetchSolanaBuyers(
  mint: string,
  heliusKey: string,
  limit: number = 50
): Promise<LookupResult> {
  if (!heliusKey) throw new Error('HELIUS_API_KEY is not set');

  const meta = await getSolanaTokenMeta(mint);

  // Helius parsed transactions for the token mint, filtered to SWAP type.
  // We may need to page through more than `limit` to collect enough buys.
  const buyers: BuyerRow[] = [];
  let before: string | undefined;
  const maxPages = 4;

  for (let page = 0; page < maxPages && buyers.length < limit; page++) {
    const url = new URL(`https://api.helius.xyz/v0/addresses/${mint}/transactions`);
    url.searchParams.set('api-key', heliusKey);
    url.searchParams.set('type', 'SWAP');
    url.searchParams.set('limit', '100');
    if (before) url.searchParams.set('before', before);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Helius HTTP ${res.status}`);
    const txs: HeliusTransaction[] = await res.json();
    if (!Array.isArray(txs) || txs.length === 0) break;

    for (const tx of txs) {
      const row = decodeSwap(tx, mint);
      if (row) {
        if (meta.priceUsd) row.usdValue = row.tokenAmount * meta.priceUsd;
        buyers.push(row);
        if (buyers.length >= limit) break;
      }
    }
    before = txs[txs.length - 1].signature;
  }

  return {
    chain: 'solana',
    contract: mint,
    tokenSymbol: meta.symbol,
    tokenName: meta.name,
    buyers,
    fetchedAt: Date.now()
  };
}
