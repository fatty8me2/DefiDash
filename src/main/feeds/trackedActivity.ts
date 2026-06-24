import { EventEmitter } from 'events';
import type { TrackedActivity, TrackedWallet } from '../../shared/types';
import { loadTracked } from '../trackedWallets';

// Polls each tracked wallet for new token buys/sells and emits an 'activity'
// event per newly-seen trade. On the first poll for a wallet we only baseline
// the current history (emit nothing) so the app doesn't spam old trades on
// launch — only activity that happens while the app is running notifies.

const POLL_INTERVAL_MS = 20_000;
const SEEN_CAP = 500;
const WSOL = 'So11111111111111111111111111111111111111112';

// Base/quote tokens that shouldn't count as the "traded coin" on Ethereum, so a
// sell's incoming USDC/WETH doesn't get misreported as a buy.
const ETH_BASE = new Set(
  [
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    '0x6b175474e89094c44da98b954eedeac495271d0f' // DAI
  ].map((s) => s.toLowerCase())
);

interface KeyBag {
  heliusKey: string;
  alchemyKey: string;
}

interface HeliusTokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  mint?: string;
  tokenAmount?: number;
}
interface HeliusNativeTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount?: number;
}
interface HeliusTx {
  signature?: string;
  timestamp?: number;
  tokenTransfers?: HeliusTokenTransfer[];
  nativeTransfers?: HeliusNativeTransfer[];
}
interface AlchemyTransfer {
  hash?: string;
  asset?: string;
  value?: number;
  rawContract?: { address?: string };
}

function shortAddr(a: string): string {
  return a.length <= 10 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}

export class TrackedActivityFeed extends EventEmitter {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private keys: KeyBag = { heliusKey: '', alchemyKey: '' };
  private seen = new Map<string, Set<string>>(); // walletKey -> seen ids
  private initialized = new Set<string>(); // walletKeys we've baselined
  private symbolCache = new Map<string, string | null>();

  start(keys: KeyBag): void {
    if (this.running) return;
    this.keys = keys;
    this.running = true;
    console.log('[tracked] activity monitor started');
    this.poll().catch(() => undefined);
    this.timer = setInterval(() => this.poll().catch(() => undefined), POLL_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private walletKey(w: TrackedWallet): string {
    return `${w.chain}:${w.chain === 'ethereum' ? w.address.toLowerCase() : w.address}`;
  }
  private seenSet(k: string): Set<string> {
    let s = this.seen.get(k);
    if (!s) {
      s = new Set();
      this.seen.set(k, s);
    }
    return s;
  }
  private markSeen(k: string, id: string): void {
    const s = this.seenSet(k);
    s.add(id);
    if (s.size > SEEN_CAP) {
      const arr = Array.from(s);
      this.seen.set(k, new Set(arr.slice(arr.length - SEEN_CAP)));
    }
  }
  private label(w: TrackedWallet): string {
    return w.label?.trim() || shortAddr(w.address);
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    const wallets = loadTracked();
    // Drop bookkeeping for wallets no longer tracked.
    const activeKeys = new Set(wallets.map((w) => this.walletKey(w)));
    for (const k of Array.from(this.seen.keys())) {
      if (!activeKeys.has(k)) {
        this.seen.delete(k);
        this.initialized.delete(k);
      }
    }
    for (const w of wallets) {
      if (!this.running) return;
      try {
        if (w.chain === 'solana') await this.pollSolana(w);
        else await this.pollEthereum(w);
      } catch {
        // ignore per-wallet errors; try again next interval
      }
    }
  }

  private async pollSolana(w: TrackedWallet): Promise<void> {
    if (!this.keys.heliusKey) return;
    const k = this.walletKey(w);
    const url = `https://api.helius.xyz/v0/addresses/${w.address}/transactions/?api-key=${this.keys.heliusKey}&limit=20`;
    const res = await fetch(url);
    if (!res.ok) return;
    const txs = (await res.json()) as HeliusTx[];
    if (!Array.isArray(txs)) return;
    const firstTime = !this.initialized.has(k);
    const out: TrackedActivity[] = [];
    for (const tx of txs) {
      const sig = tx.signature;
      if (!sig || this.seenSet(k).has(sig)) continue;
      this.markSeen(k, sig);
      if (firstTime) continue; // baseline only
      const parsed = this.classifySolana(tx, w.address);
      if (parsed) {
        out.push({
          id: sig,
          chain: 'solana',
          wallet: w.address,
          label: this.label(w),
          action: parsed.action,
          tokenSymbol: null,
          tokenMint: parsed.mint,
          tokenAmount: parsed.tokenAmount,
          nativeAmount: parsed.solAmount,
          nativeSymbol: 'SOL',
          timestamp: tx.timestamp || Math.floor(Date.now() / 1000)
        });
      }
    }
    this.initialized.add(k);
    // Oldest-first so toasts stack in chronological order.
    for (const a of out.reverse()) {
      a.tokenSymbol = await this.resolveSymbol(a.tokenMint);
      this.emit('activity', a);
    }
  }

  private classifySolana(
    tx: HeliusTx,
    wallet: string
  ): { action: 'buy' | 'sell'; mint: string; tokenAmount: number | null; solAmount: number | null } | null {
    const tts = Array.isArray(tx.tokenTransfers) ? tx.tokenTransfers : [];
    const nts = Array.isArray(tx.nativeTransfers) ? tx.nativeTransfers : [];
    // Net token change for the wallet, per mint.
    const net = new Map<string, number>();
    for (const t of tts) {
      if (!t.mint) continue;
      const amt = Number(t.tokenAmount) || 0;
      if (t.toUserAccount === wallet) net.set(t.mint, (net.get(t.mint) || 0) + amt);
      if (t.fromUserAccount === wallet) net.set(t.mint, (net.get(t.mint) || 0) - amt);
    }
    let bestMint = '';
    let bestNet = 0;
    for (const [m, v] of net) {
      if (m === WSOL) continue;
      if (Math.abs(v) > Math.abs(bestNet)) {
        bestNet = v;
        bestMint = m;
      }
    }
    if (!bestMint || bestNet === 0) return null;
    // Native SOL change (lamports).
    let lam = 0;
    for (const n of nts) {
      const a = Number(n.amount) || 0;
      if (n.toUserAccount === wallet) lam += a;
      if (n.fromUserAccount === wallet) lam -= a;
    }
    const wsolNet = net.get(WSOL) || 0;
    const solOut = lam < 0 || wsolNet < 0;
    const solIn = lam > 0 || wsolNet > 0;
    const solAmt = Math.abs(lam !== 0 ? lam / 1e9 : wsolNet);
    if (bestNet > 0 && solOut) return { action: 'buy', mint: bestMint, tokenAmount: bestNet, solAmount: solAmt || null };
    if (bestNet < 0 && solIn) return { action: 'sell', mint: bestMint, tokenAmount: Math.abs(bestNet), solAmount: solAmt || null };
    return null;
  }

  private async pollEthereum(w: TrackedWallet): Promise<void> {
    if (!this.keys.alchemyKey) return;
    const k = this.walletKey(w);
    const endpoint = `https://eth-mainnet.g.alchemy.com/v2/${this.keys.alchemyKey}`;
    const firstTime = !this.initialized.has(k);
    const out: TrackedActivity[] = [];
    for (const dir of ['toAddress', 'fromAddress'] as const) {
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'alchemy_getAssetTransfers',
        params: [{ [dir]: w.address, category: ['erc20'], order: 'desc', maxCount: '0x19', withMetadata: false }]
      };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { result?: { transfers?: AlchemyTransfer[] } };
      const transfers = json.result?.transfers ?? [];
      for (const t of transfers) {
        const hash = t.hash;
        const token = (t.rawContract?.address ?? '').toLowerCase();
        if (!hash || !token || ETH_BASE.has(token)) continue;
        const action: 'buy' | 'sell' = dir === 'toAddress' ? 'buy' : 'sell';
        const id = `${hash}:${token}:${action}`;
        if (this.seenSet(k).has(id)) continue;
        this.markSeen(k, id);
        if (firstTime) continue;
        out.push({
          id,
          chain: 'ethereum',
          wallet: w.address,
          label: this.label(w),
          action,
          tokenSymbol: t.asset ?? null,
          tokenMint: token,
          tokenAmount: typeof t.value === 'number' ? t.value : null,
          nativeAmount: null,
          nativeSymbol: 'ETH',
          timestamp: Math.floor(Date.now() / 1000)
        });
      }
    }
    this.initialized.add(k);
    for (const a of out.reverse()) this.emit('activity', a);
  }

  private async resolveSymbol(mint: string): Promise<string | null> {
    if (this.symbolCache.has(mint)) return this.symbolCache.get(mint) ?? null;
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      if (res.ok) {
        const json = (await res.json()) as { pairs?: Array<{ baseToken?: { address?: string; symbol?: string } }> };
        const pairs = json.pairs ?? [];
        const sym =
          pairs.find((p) => p.baseToken?.address?.toLowerCase() === mint.toLowerCase())?.baseToken?.symbol ??
          pairs[0]?.baseToken?.symbol ??
          null;
        this.symbolCache.set(mint, sym);
        return sym;
      }
    } catch {
      // best-effort
    }
    this.symbolCache.set(mint, null);
    return null;
  }
}
