import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { FlowSnapshot, FlowToken } from '../../shared/types';

// Bitquery Solana streaming endpoint (EAP dataset). Token is passed in the URL.
// The endpoint speaks the legacy subscriptions-transport-ws frames
// (connection_init → connection_ack → start → data), despite advertising the
// "graphql-ws" subprotocol — this matches Bitquery's own documented example.
const ENDPOINT = 'wss://streaming.bitquery.io/eap';

const WINDOW_MS = 15 * 60 * 1000;     // 15-minute rolling window
const EMIT_INTERVAL_MS = 2_000;       // push a fresh snapshot to the UI every 2s
const SPARK_BUCKETS = 24;             // points in each card's mini chart
const PUMP_SUPPLY = 1_000_000_000;    // pump.fun fixed total supply
const MAX_TRADES_PER_MINT = 4_000;    // safety cap per mint
const MAX_MINTS = 5_000;              // safety cap on tracked mints
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

// SOL is the quote currency on pump.fun. Match wrapped/native SOL on either side.
const SOL_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // wrapped SOL
  '11111111111111111111111111111111'             // native (system program)
]);
function isSol(mint: string | undefined, symbol: string | undefined): boolean {
  if (mint && SOL_MINTS.has(mint)) return true;
  if (symbol && /^w?sol$/i.test(symbol)) return true;
  return false;
}

const SUBSCRIPTION_QUERY = `subscription {
  Solana {
    DEXTrades(
      where: {
        Trade: { Dex: { ProtocolName: { is: "pump" } } }
        Transaction: { Result: { Success: true } }
      }
    ) {
      Trade {
        Buy {
          Amount
          AmountInUSD
          PriceInUSD
          Currency { MintAddress Symbol Name Uri }
        }
        Sell {
          Amount
          AmountInUSD
          PriceInUSD
          Currency { MintAddress Symbol Name Uri }
        }
      }
      Block { Time }
    }
  }
}`;

interface TradeRec {
  t: number;        // ms
  sol: number;      // SOL size of the trade (always positive)
  isBuy: boolean;   // true = token bought (SOL in), false = token sold (SOL out)
}

interface MintAgg {
  mint: string;
  symbol: string | null;
  name: string | null;
  uri: string | null;
  trades: TradeRec[];
  firstSeen: number;   // ms
  lastTrade: number;   // ms
  priceUsd: number | null;
}

interface BqCurrency {
  MintAddress?: string;
  Symbol?: string;
  Name?: string;
  Uri?: string;
}
interface BqSide {
  Amount?: string;
  AmountInUSD?: string;
  PriceInUSD?: string;
  Currency?: BqCurrency;
}
interface BqTrade {
  Trade?: { Buy?: BqSide; Sell?: BqSide };
  Block?: { Time?: string };
}

function n(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}

export class PumpFlowFeed extends EventEmitter {
  private token = '';
  private ws: WebSocket | null = null;
  private running = false;
  private mints = new Map<string, MintAgg>();
  private emitTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private solPriceUsd: number | null = null;

  start(token: string): void {
    if (this.running) return;
    if (!token) {
      this.emit('status', 'no-key');
      return;
    }
    this.token = token;
    this.running = true;
    this.reconnectAttempts = 0;
    this.connect();
    this.emitTimer = setInterval(() => this.emitSnapshot(), EMIT_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.emitTimer) { clearInterval(this.emitTimer); this.emitTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.mints.clear();
    console.log('[pumpflow] stopped');
  }

  private connect(): void {
    if (!this.running) return;
    this.emit('status', 'connecting');
    const url = `${ENDPOINT}?token=${encodeURIComponent(this.token)}`;
    console.log('[pumpflow] connecting to Bitquery stream');

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, ['graphql-ws']);
    } catch (e) {
      console.log(`[pumpflow] connect threw: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      console.log('[pumpflow] socket open → connection_init');
      ws.send(JSON.stringify({ type: 'connection_init' }));
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      let msg: { type?: string; id?: string; payload?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case 'connection_ack':
          console.log('[pumpflow] connection_ack → starting subscription');
          this.reconnectAttempts = 0;
          this.emit('status', 'connected');
          ws.send(JSON.stringify({ type: 'start', id: '1', payload: { query: SUBSCRIPTION_QUERY } }));
          break;
        case 'data':
        case 'next': {
          const payload = msg.payload as { data?: { Solana?: { DEXTrades?: BqTrade[] } } } | undefined;
          const trades = payload?.data?.Solana?.DEXTrades;
          if (Array.isArray(trades)) {
            for (const t of trades) this.handleTrade(t);
          }
          break;
        }
        case 'error':
        case 'connection_error':
          console.log(`[pumpflow] server error: ${JSON.stringify(msg.payload)}`);
          this.emit('status', 'error');
          break;
        case 'complete':
          console.log('[pumpflow] subscription complete');
          break;
        case 'ka':
        case 'connection_keep_alive':
        default:
          break;
      }
    });

    ws.on('close', (code) => {
      console.log(`[pumpflow] socket closed (${code})`);
      if (this.running) {
        this.emit('status', 'disconnected');
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err: Error) => {
      console.log(`[pumpflow] socket error: ${err.message}`);
      this.emit('status', 'error');
      // 'close' will fire next and trigger reconnect.
    });
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.ws) {
        try { this.ws.removeAllListeners(); this.ws.close(); } catch { /* ignore */ }
        this.ws = null;
      }
      this.connect();
    }, delay);
  }

  private handleTrade(t: BqTrade): void {
    const buy = t.Trade?.Buy;
    const sell = t.Trade?.Sell;
    if (!buy?.Currency || !sell?.Currency) return;

    const buyIsSol = isSol(buy.Currency.MintAddress, buy.Currency.Symbol);
    const sellIsSol = isSol(sell.Currency.MintAddress, sell.Currency.Symbol);
    if (buyIsSol === sellIsSol) return; // token↔token or unrecognized — skip

    // Token bought (SOL in): meme on Buy side, SOL on Sell side.
    // Token sold  (SOL out): meme on Sell side, SOL on Buy side.
    const isBuy = sellIsSol;
    const memeSide = isBuy ? buy : sell;
    const solSide = isBuy ? sell : buy;

    const mint = memeSide.Currency?.MintAddress;
    if (!mint) return;
    const solAmount = n(solSide.Amount);
    if (solAmount <= 0) return;

    const tsMs = t.Block?.Time ? new Date(t.Block.Time).getTime() : Date.now();
    const priceUsd = n(memeSide.PriceInUSD) || null;

    // Keep a running SOL/USD estimate from the SOL side of any trade.
    const solUsd = n(solSide.AmountInUSD);
    if (solUsd > 0 && solAmount > 0) this.solPriceUsd = solUsd / solAmount;

    let agg = this.mints.get(mint);
    if (!agg) {
      if (this.mints.size >= MAX_MINTS) this.evictOldest();
      agg = {
        mint,
        symbol: memeSide.Currency?.Symbol ?? null,
        name: memeSide.Currency?.Name ?? null,
        uri: memeSide.Currency?.Uri ?? null,
        trades: [],
        firstSeen: tsMs,
        lastTrade: tsMs,
        priceUsd
      };
      this.mints.set(mint, agg);
    }
    if (agg.symbol === null && memeSide.Currency?.Symbol) agg.symbol = memeSide.Currency.Symbol;
    if (agg.name === null && memeSide.Currency?.Name) agg.name = memeSide.Currency.Name;
    if (agg.uri === null && memeSide.Currency?.Uri) agg.uri = memeSide.Currency.Uri;
    if (priceUsd !== null) agg.priceUsd = priceUsd;
    agg.lastTrade = tsMs;
    agg.trades.push({ t: tsMs, sol: solAmount, isBuy });
    if (agg.trades.length > MAX_TRADES_PER_MINT) agg.trades.splice(0, agg.trades.length - MAX_TRADES_PER_MINT);
  }

  private evictOldest(): void {
    let oldestMint: string | null = null;
    let oldest = Infinity;
    for (const [mint, agg] of this.mints) {
      if (agg.lastTrade < oldest) { oldest = agg.lastTrade; oldestMint = mint; }
    }
    if (oldestMint) this.mints.delete(oldestMint);
  }

  private emitSnapshot(): void {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    const computed: FlowToken[] = [];

    for (const [mint, agg] of this.mints) {
      // Drop trades outside the window.
      if (agg.trades.length && agg.trades[0].t < cutoff) {
        let i = 0;
        while (i < agg.trades.length && agg.trades[i].t < cutoff) i++;
        if (i > 0) agg.trades.splice(0, i);
      }
      if (agg.trades.length === 0) {
        // Idle for the whole window — forget it after a grace period.
        if (now - agg.lastTrade > WINDOW_MS + 60_000) this.mints.delete(mint);
        continue;
      }

      let buyVol = 0, sellVol = 0, buyCount = 0, sellCount = 0;
      const buckets = new Array<number>(SPARK_BUCKETS).fill(0);
      const span = WINDOW_MS;
      for (const tr of agg.trades) {
        const signed = tr.isBuy ? tr.sol : -tr.sol;
        if (tr.isBuy) { buyVol += tr.sol; buyCount++; } else { sellVol += tr.sol; sellCount++; }
        let b = Math.floor(((tr.t - cutoff) / span) * SPARK_BUCKETS);
        if (b < 0) b = 0; else if (b >= SPARK_BUCKETS) b = SPARK_BUCKETS - 1;
        buckets[b] += signed;
      }
      // Cumulative net inflow across the window → the sparkline.
      const spark: number[] = [];
      let run = 0;
      for (const v of buckets) { run += v; spark.push(run); }

      const netInflowSol = buyVol - sellVol;
      const marketCapUsd = agg.priceUsd !== null ? agg.priceUsd * PUMP_SUPPLY : null;

      computed.push({
        mint,
        symbol: agg.symbol,
        name: agg.name,
        uri: agg.uri,
        netInflowSol,
        buyVolSol: buyVol,
        sellVolSol: sellVol,
        txCount: agg.trades.length,
        buyCount,
        sellCount,
        priceUsd: agg.priceUsd,
        marketCapUsd,
        firstSeen: Math.floor(agg.firstSeen / 1000),
        lastTrade: Math.floor(agg.lastTrade / 1000),
        spark
      });
    }

    // Select a bounded, useful set: strongest inflows, strongest outflows, and
    // the newest mints — so the UI's Top / Dipping / Early tabs all have data.
    const byNetDesc = [...computed].sort((a, b) => b.netInflowSol - a.netInflowSol);
    const byNetAsc = [...computed].sort((a, b) => a.netInflowSol - b.netInflowSol);
    const byNewest = [...computed].sort((a, b) => b.firstSeen - a.firstSeen);
    const chosen = new Map<string, FlowToken>();
    for (const t of byNetDesc.slice(0, 60)) chosen.set(t.mint, t);
    for (const t of byNetAsc.slice(0, 40)) chosen.set(t.mint, t);
    for (const t of byNewest.slice(0, 50)) chosen.set(t.mint, t);

    const snapshot: FlowSnapshot = {
      tokens: [...chosen.values()],
      windowMinutes: 15,
      solPriceUsd: this.solPriceUsd,
      updatedAt: Math.floor(now / 1000)
    };
    this.emit('update', snapshot);
  }
}
