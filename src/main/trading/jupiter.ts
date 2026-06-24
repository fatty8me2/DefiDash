import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { loadWallet, getPublicKey } from './wallet';
import type { TokenTrade, TradeHolding, TradeQuote, TradeResult, TradeSide, TradeSpeed, TradeTokenBalance, TradeWalletInfo } from '../../shared/types';

// Jupiter's keyless API. Quote then build a swap transaction; we sign locally
// with the trading keypair and broadcast through the user's own Helius RPC.
// Two keyless bases — the "lite" tier rate-limits aggressively, so on 429/5xx we
// retry and fall back to the main host (fixes intermittent "Quote failed").
const JUP_BASES = ['https://lite-api.jup.ag/swap/v1', 'https://api.jup.ag/swap/v1'];
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS_PER_SOL = 1_000_000_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Fetch a Jupiter endpoint, retrying across both bases on rate-limit / 5xx.
async function jupFetch(path: string, init?: RequestInit): Promise<Response> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const base = JUP_BASES[attempt % JUP_BASES.length];
    try {
      const res = await fetch(`${base}${path}`, init);
      if (res.ok) return res;
      lastStatus = res.status;
      if (res.status === 429 || res.status >= 500) {
        await sleep(250 * (attempt + 1));
        continue; // retry / try the other host
      }
      return res; // other 4xx: let the caller read the body
    } catch {
      await sleep(250 * (attempt + 1));
    }
  }
  throw new Error(`Jupiter unavailable (last HTTP ${lastStatus || 'network error'}). Retry in a moment.`);
}

// Priority-fee tiers for the speed selector. maxLamports caps what the priority
// fee can cost; priorityLevel tells Jupiter how aggressively to bid.
const SPEED_FEE: Record<TradeSpeed, { level: 'medium' | 'high' | 'veryHigh'; maxLamports: number }> = {
  normal: { level: 'medium', maxLamports: 500_000 },
  fast: { level: 'high', maxLamports: 1_000_000 },
  turbo: { level: 'veryHigh', maxLamports: 4_000_000 }
};

function rpcUrl(heliusKey: string): string {
  return heliusKey
    ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
    : 'https://api.mainnet-beta.solana.com';
}

const decimalsCache = new Map<string, number>();
async function getMintDecimals(mint: string, conn: Connection): Promise<number> {
  if (mint === SOL_MINT) return 9;
  const hit = decimalsCache.get(mint);
  if (hit !== undefined) return hit;
  const supply = await conn.getTokenSupply(new PublicKey(mint));
  const d = supply.value.decimals;
  decimalsCache.set(mint, d);
  return d;
}

interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  slippageBps?: number;
  priceImpactPct?: string | number;
  swapUsdValue?: string | number;
  routePlan?: Array<{ swapInfo?: { label?: string } }>;
  error?: string;
}

function legs(side: TradeSide, mint: string): { inputMint: string; outputMint: string } {
  return side === 'buy'
    ? { inputMint: SOL_MINT, outputMint: mint }
    : { inputMint: mint, outputMint: SOL_MINT };
}

async function fetchQuote(
  side: TradeSide,
  mint: string,
  amount: number,
  slippageBps: number,
  conn: Connection,
  rawInOverride?: bigint
): Promise<{ raw: JupQuote; inDecimals: number; outDecimals: number }> {
  const { inputMint, outputMint } = legs(side, mint);
  const inDecimals = await getMintDecimals(inputMint, conn);
  const outDecimals = await getMintDecimals(outputMint, conn);
  const rawIn = (rawInOverride !== undefined ? rawInOverride : BigInt(Math.floor(amount * 10 ** inDecimals))).toString();
  const res = await jupFetch(`/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${rawIn}&slippageBps=${slippageBps}`);
  if (!res.ok) {
    // Surface Jupiter's real reason instead of a bare HTTP code.
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string; errorCode?: string; message?: string };
      if (j.errorCode === 'NO_ROUTES_FOUND') {
        msg = 'No swap route for this token (too new / illiquid, or not yet on Jupiter).';
      } else if (j.error || j.message) {
        msg = String(j.error || j.message);
      }
    } catch {
      /* keep the HTTP status */
    }
    throw new Error(`Quote failed: ${msg}`);
  }
  const raw = (await res.json()) as JupQuote;
  if (raw.error) throw new Error(raw.error);
  if (!raw.outAmount) throw new Error('No route found for this trade.');
  return { raw, inDecimals, outDecimals };
}

/** Indicative quote for the UI (the actual swap re-quotes fresh just before signing). */
export async function getQuote(
  side: TradeSide,
  mint: string,
  amount: number,
  slippageBps: number,
  heliusKey: string
): Promise<TradeQuote> {
  if (!(amount > 0)) throw new Error('Enter an amount greater than zero.');
  const conn = new Connection(rpcUrl(heliusKey), 'confirmed');
  const { raw, inDecimals, outDecimals } = await fetchQuote(side, mint, amount, slippageBps, conn);
  return {
    side,
    mint,
    inputMint: raw.inputMint,
    outputMint: raw.outputMint,
    inUiAmount: Number(raw.inAmount) / 10 ** inDecimals,
    outUiAmount: Number(raw.outAmount) / 10 ** outDecimals,
    priceImpactPct: raw.priceImpactPct != null ? Number(raw.priceImpactPct) : null,
    slippageBps: raw.slippageBps ?? slippageBps,
    routeLabels: (raw.routePlan ?? []).map((r) => r.swapInfo?.label).filter((l): l is string => !!l),
    usdValue: raw.swapUsdValue != null ? Number(raw.swapUsdValue) : null
  };
}

/** Quote → build → sign → broadcast → confirm. The key never leaves the main process. */
export async function executeSwap(
  side: TradeSide,
  mint: string,
  amount: number,
  slippageBps: number,
  heliusKey: string,
  speed: TradeSpeed = 'fast',
  sellAll = false,
  dynamicSlippage = false
): Promise<TradeResult> {
  const kp = loadWallet();
  if (!kp) return { ok: false, signature: null, error: 'No trading wallet configured.' };
  if (!sellAll && !(amount > 0)) return { ok: false, signature: null, error: 'Enter an amount greater than zero.' };
  const feeCfg = SPEED_FEE[speed] ?? SPEED_FEE.fast;
  try {
    const conn = new Connection(rpcUrl(heliusKey), 'confirmed');

    // For sells, clamp the input to the wallet's *exact* on-chain raw balance so
    // float rounding (especially "Max"/%) can never try to sell more than we
    // hold, and make sure there's enough SOL left for fees + the temporary
    // wrapped-SOL account rent (a common reason sells fail after a buy spends
    // most of the SOL).
    let rawInOverride: bigint | undefined;
    if (side === 'sell') {
      const rawBal = await getRawTokenBalance(kp.publicKey, mint, conn);
      if (rawBal <= 0n) {
        return { ok: false, signature: null, error: "You don't hold this token, so there's nothing to sell." };
      }
      const inDecimals = await getMintDecimals(mint, conn);
      // "Sell all" uses the exact raw balance so the position closes fully (no
      // dust left from float rounding); otherwise clamp the requested amount.
      let want = sellAll ? rawBal : BigInt(Math.floor(amount * 10 ** inDecimals));
      if (want > rawBal) want = rawBal; // never exceed the actual balance
      if (want <= 0n) {
        return { ok: false, signature: null, error: 'Sell amount is too small.' };
      }
      rawInOverride = want;

      // Need enough SOL for the priority fee + base fee + the temporary
      // wrapped-SOL account rent (~0.00204 SOL). Scales with the chosen speed.
      const needed = feeCfg.maxLamports + 2_500_000;
      const solLamports = await conn.getBalance(kp.publicKey);
      if (solLamports < needed) {
        return {
          ok: false,
          signature: null,
          error: `Not enough SOL for fees: ${(solLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL. A "${speed}" sell needs ~${(needed / LAMPORTS_PER_SOL).toFixed(3)} SOL for the priority + network fee and the temporary wrapped-SOL account. Send a little SOL to this wallet (or pick a slower speed) and retry.`
        };
      }
    }

    // Build the signed swap tx — Jupiter first; fall back to PumpPortal for
    // pump.fun tokens Jupiter can't route (new bonding-curve coins).
    let built: { rawTx: Uint8Array; lastValidBlockHeight: number };
    try {
      built = await buildJupiterTx(side, mint, amount, slippageBps, conn, rawInOverride, kp, feeCfg, dynamicSlippage);
    } catch (e) {
      const msg = (e as Error).message || '';
      if (/no.*route|no_routes/i.test(msg)) {
        console.log('[trade] Jupiter has no route — routing via PumpPortal');
        built = await buildPumpPortalTx(side, mint, amount, slippageBps, conn, sellAll, kp, feeCfg);
      } else {
        throw e;
      }
    }
    const rawTx = built.rawTx;
    const lastValidBlockHeight = built.lastValidBlockHeight;

    // Send and keep re-broadcasting the same signed tx while polling its status,
    // until it confirms or its blockhash expires. This lands far more reliably
    // under congestion than a single send + websocket confirmTransaction (which
    // is flaky on Helius free tier and was the cause of inconsistent fills).
    const sig = await conn.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 });
    const startedAt = Date.now();
    let lastResend = Date.now();
    while (Date.now() - startedAt < 75_000) {
      if (Date.now() - lastResend > 2_000) {
        conn.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
        lastResend = Date.now();
      }
      const info = (await conn.getSignatureStatuses([sig])).value[0];
      if (info) {
        if (info.err) return { ok: false, signature: sig, error: translateOnChainError(info.err) };
        if (info.confirmationStatus === 'confirmed' || info.confirmationStatus === 'finalized') {
          return { ok: true, signature: sig, error: null };
        }
      }
      // Stop once the tx's blockhash can no longer be used.
      const height = await conn.getBlockHeight('confirmed').catch(() => 0);
      if (height > lastValidBlockHeight) {
        const final = (await conn.getSignatureStatuses([sig])).value[0];
        if (final && !final.err && (final.confirmationStatus === 'confirmed' || final.confirmationStatus === 'finalized')) {
          return { ok: true, signature: sig, error: null };
        }
        return {
          ok: false,
          signature: sig,
          error: 'Transaction expired before landing (network congestion). Retry, and bump Speed to Turbo.'
        };
      }
      await new Promise((r) => setTimeout(r, 1_500));
    }
    return {
      ok: false,
      signature: sig,
      error: 'Timed out waiting for confirmation — it may still land. Check the signature on Solscan before retrying.'
    };
  } catch (e) {
    return { ok: false, signature: null, error: (e as Error).message };
  }
}

// Map common on-chain swap errors to something actionable.
function translateOnChainError(err: unknown): string {
  const s = JSON.stringify(err);
  if (s.includes('6001') || s.includes('0x1771')) return 'Slippage exceeded — price moved too much. Raise the slippage % and retry.';
  if (s.includes('6000') || s.includes('0x1770')) return 'Slippage / route error — raise the slippage % (or reduce size) and retry.';
  if (s.toLowerCase().includes('insufficient')) return 'Insufficient funds (token balance, or SOL for fees + rent).';
  return `Swap failed on-chain (${s}). Usually slippage — raise the slippage % or reduce size.`;
}

interface HxTokenTransfer { fromUserAccount?: string; toUserAccount?: string; mint?: string; tokenAmount?: number }
interface HxNativeTransfer { fromUserAccount?: string; toUserAccount?: string; amount?: number }
interface HxTx { signature?: string; timestamp?: number; feePayer?: string; tokenTransfers?: HxTokenTransfer[]; nativeTransfers?: HxNativeTransfer[] }

/** Recent swaps for a token mint, classified buy/sell from the trader's (fee payer's) view. */
export async function getTokenTrades(mint: string, heliusKey: string, limit = 30): Promise<TokenTrade[]> {
  if (!heliusKey || !mint) return [];
  try {
    const url = `https://api.helius.xyz/v0/addresses/${mint}/transactions/?api-key=${heliusKey}&type=SWAP&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const txs = (await res.json()) as HxTx[];
    if (!Array.isArray(txs)) return [];
    const out: TokenTrade[] = [];
    for (const tx of txs) {
      const trader = tx.feePayer;
      if (!trader || !tx.signature) continue;
      const tts = tx.tokenTransfers ?? [];
      const nts = tx.nativeTransfers ?? [];
      let tok = 0;
      for (const t of tts) {
        if (t.mint !== mint) continue;
        const a = Number(t.tokenAmount) || 0;
        if (t.toUserAccount === trader) tok += a;
        if (t.fromUserAccount === trader) tok -= a;
      }
      if (tok === 0) continue;
      let lam = 0;
      let wsol = 0;
      for (const n of nts) {
        const a = Number(n.amount) || 0;
        if (n.toUserAccount === trader) lam += a;
        if (n.fromUserAccount === trader) lam -= a;
      }
      for (const t of tts) {
        if (t.mint !== SOL_MINT) continue;
        const a = Number(t.tokenAmount) || 0;
        if (t.toUserAccount === trader) wsol += a;
        if (t.fromUserAccount === trader) wsol -= a;
      }
      const sol = Math.abs(lam !== 0 ? lam / 1e9 : wsol);
      out.push({
        signature: tx.signature,
        timestamp: tx.timestamp ?? Math.floor(Date.now() / 1000),
        action: tok > 0 ? 'buy' : 'sell',
        tokenAmount: Math.abs(tok),
        solAmount: sol > 0 ? sol : null,
        trader
      });
    }
    return out;
  } catch {
    return [];
  }
}

type FeeCfg = { level: 'medium' | 'high' | 'veryHigh'; maxLamports: number };

/** Build + sign a Jupiter swap transaction. Throws (with a no-route message) when Jupiter can't route. */
async function buildJupiterTx(
  side: TradeSide,
  mint: string,
  amount: number,
  slippageBps: number,
  conn: Connection,
  rawInOverride: bigint | undefined,
  kp: Keypair,
  feeCfg: FeeCfg,
  dynamicSlippage: boolean
): Promise<{ rawTx: Uint8Array; lastValidBlockHeight: number }> {
  // Re-quote fresh right before swapping so we don't sign a stale route.
  const { raw } = await fetchQuote(side, mint, amount, slippageBps, conn, rawInOverride);
  const swapRes = await jupFetch('/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: raw,
      userPublicKey: kp.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      ...(dynamicSlippage ? { dynamicSlippage: true } : {}),
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: feeCfg.maxLamports, priorityLevel: feeCfg.level }
      }
    })
  });
  if (!swapRes.ok) throw new Error(`Swap build failed (HTTP ${swapRes.status})`);
  const swapJson = (await swapRes.json()) as { swapTransaction?: string; lastValidBlockHeight?: number; error?: string };
  if (!swapJson.swapTransaction) throw new Error(swapJson.error || 'No swap transaction returned.');
  const tx = VersionedTransaction.deserialize(Buffer.from(swapJson.swapTransaction, 'base64'));
  tx.sign([kp]);
  const lastValidBlockHeight =
    swapJson.lastValidBlockHeight ?? (await conn.getLatestBlockhash('confirmed')).lastValidBlockHeight;
  return { rawTx: tx.serialize(), lastValidBlockHeight };
}

/**
 * Fallback for pump.fun tokens Jupiter can't route: PumpPortal's keyless
 * trade-local API builds the trade (bonding curve / pump-amm / Raydium via
 * pool:auto) and we sign it locally — the key never leaves the main process.
 */
async function buildPumpPortalTx(
  side: TradeSide,
  mint: string,
  amount: number,
  slippageBps: number,
  conn: Connection,
  sellAll: boolean,
  kp: Keypair,
  feeCfg: FeeCfg
): Promise<{ rawTx: Uint8Array; lastValidBlockHeight: number }> {
  const body = {
    publicKey: kp.publicKey.toBase58(),
    action: side,
    mint,
    denominatedInSol: side === 'buy' ? 'true' : 'false', // buy: amount is SOL; sell: amount is tokens
    amount: side === 'sell' && sellAll ? '100%' : amount,
    slippage: Math.max(1, Math.round(slippageBps / 100)),
    priorityFee: feeCfg.maxLamports / LAMPORTS_PER_SOL,
    pool: 'auto'
  };
  const res = await fetch('https://pumpportal.fun/api/trade-local', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const t = await res.text();
      if (t) detail = t.slice(0, 200);
    } catch {
      /* keep status */
    }
    throw new Error(`pump.fun route failed: ${detail}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const tx = VersionedTransaction.deserialize(buf);
  tx.sign([kp]);
  const bh = await conn.getLatestBlockhash('confirmed');
  return { rawTx: tx.serialize(), lastValidBlockHeight: bh.lastValidBlockHeight };
}

/** Exact raw (atomic) balance of `mint` held by `owner`, summed across token accounts. */
async function getRawTokenBalance(owner: PublicKey, mint: string, conn: Connection): Promise<bigint> {
  try {
    const res = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
    let total = 0n;
    for (const acc of res.value) {
      const amount = (acc.account.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount;
      if (typeof amount === 'string') total += BigInt(amount);
    }
    return total;
  } catch {
    return 0n;
  }
}

/** Wallet address + SOL balance for the terminal header. */
export async function getWalletInfo(heliusKey: string): Promise<TradeWalletInfo> {
  const address = getPublicKey();
  if (!address) return { exists: false, address: null, solBalance: null };
  try {
    const conn = new Connection(rpcUrl(heliusKey), 'confirmed');
    const lamports = await conn.getBalance(new PublicKey(address));
    return { exists: true, address, solBalance: lamports / LAMPORTS_PER_SOL };
  } catch {
    return { exists: true, address, solBalance: null };
  }
}

interface DasAsset {
  interface?: string;
  id?: string;
  content?: { metadata?: { symbol?: string; name?: string } };
  token_info?: {
    balance?: number;
    decimals?: number;
    symbol?: string;
    price_info?: { price_per_token?: number; total_price?: number };
  };
}

/** All fungible SPL tokens the trading wallet holds, via Helius DAS (balances + metadata + prices in one call). */
export async function getWalletTokens(heliusKey: string): Promise<TradeHolding[]> {
  const owner = getPublicKey();
  if (!owner) return [];
  try {
    const res = await fetch(rpcUrl(heliusKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'holdings',
        method: 'getAssetsByOwner',
        params: { ownerAddress: owner, page: 1, limit: 1000, displayOptions: { showFungible: true, showZeroBalance: false } }
      })
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { result?: { items?: DasAsset[] } };
    const items = json.result?.items ?? [];
    const out: TradeHolding[] = [];
    for (const it of items) {
      if (it.interface !== 'FungibleToken' || !it.id) continue;
      if (it.id === SOL_MINT) continue; // native SOL is shown via the wallet's SOL balance
      const ti = it.token_info;
      const rawBal = typeof ti?.balance === 'number' ? ti.balance : 0;
      if (rawBal <= 0) continue;
      const decimals = ti?.decimals ?? 0;
      out.push({
        mint: it.id,
        symbol: it.content?.metadata?.symbol ?? ti?.symbol ?? null,
        name: it.content?.metadata?.name ?? null,
        uiAmount: rawBal / 10 ** decimals,
        decimals,
        usdValue: typeof ti?.price_info?.total_price === 'number' ? ti.price_info.total_price : null
      });
    }
    out.sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0) || b.uiAmount - a.uiAmount);
    return out;
  } catch {
    return [];
  }
}

/** How much of `mint` the trading wallet holds (for Sell + Max). */
export async function getTokenBalance(mint: string, heliusKey: string): Promise<TradeTokenBalance> {
  const address = getPublicKey();
  if (!address) return { mint, uiAmount: 0, decimals: 0 };
  try {
    const conn = new Connection(rpcUrl(heliusKey), 'confirmed');
    const res = await conn.getParsedTokenAccountsByOwner(new PublicKey(address), { mint: new PublicKey(mint) });
    let uiAmount = 0;
    let decimals = 0;
    for (const acc of res.value) {
      const info = (acc.account.data as { parsed?: { info?: { tokenAmount?: { uiAmount?: number; decimals?: number } } } }).parsed?.info?.tokenAmount;
      if (info) {
        uiAmount += info.uiAmount ?? 0;
        decimals = info.decimals ?? decimals;
      }
    }
    return { mint, uiAmount, decimals };
  } catch {
    return { mint, uiAmount: 0, decimals: 0 };
  }
}
