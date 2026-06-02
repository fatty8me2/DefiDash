import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { EvmFlowChain, EvmFlowSnapshot, EvmFlowToken } from '../../shared/types';

// Bitquery EVM streaming endpoint. Unlike Solana (which uses /eap), EVM data is
// served from /graphql. Same legacy subscriptions-transport-ws framing
// (connection_init → connection_ack → start → data) despite the "graphql-ws"
// subprotocol — matching Bitquery's documented example.
const ENDPOINT = 'wss://streaming.bitquery.io/graphql';

const WINDOW_MS = 15 * 60 * 1000;     // 15-minute rolling window
const EMIT_INTERVAL_MS = 2_000;       // push a fresh snapshot to the UI every 2s
const SPARK_BUCKETS = 24;             // points in each card's mini chart
const MAX_TRADES_PER_TOKEN = 4_000;   // safety cap per token
const MAX_TOKENS = 5_000;             // safety cap on tracked tokens
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

// Per-chain config: Bitquery network slug + the wrapped-native (WETH) address
// used as the quote side. Base's native asset is also ETH.
const CHAIN_CONFIG: Record<EvmFlowChain, { network: string; weth: string }> = {
  ethereum: { network: 'eth', weth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' },
  base: { network: 'base', weth: '0x4200000000000000000000000000000000000006' }
};

function isWeth(address: string | undefined, symbol: string | undefined, weth: string): boolean {
  if (address && address.toLowerCase() === weth) return true;
  if (symbol && /^w?eth$/i.test(symbol)) return true;
  return false;
}

// Live Uniswap V2 trades for the given network. ProtocolName "uniswap_v2" is
// Bitquery's identifier for the V2 protocol across EVM chains.
function buildQuery(network: string): string {
  return `subscription {
  EVM(network: ${network}) {
    DEXTrades(
      where: {
        Trade: { Dex: { ProtocolName: { in: ["uniswap_v2"] } } }
      }
    ) {
      Trade {
        Buy {
          Amount
          AmountInUSD
          Currency { SmartContract Symbol Name }
        }
        Sell {
          Amount
          AmountInUSD
          Currency { SmartContract Symbol Name }
        }
      }
      Block { Time }
    }
  }
}`;
}

interface TradeRec {
  t: number;        // ms
  eth: number;      // ETH size of the trade (always positive)
  isBuy: boolean;   // true = token bought (ETH in), false = token sold (ETH out)
}

interface TokenAgg {
  address: string;
  symbol: string | null;
  name: string | null;
  trades: TradeRec[];
  firstSeen: number;   // ms
  lastTrade: number;   // ms
  priceUsd: number | null;
}

interface BqCurrency {
  SmartContract?: string;
  Symbol?: string;
  Name?: string;
}
interface BqSide {
  Amount?: string;
  AmountInUSD?: string;
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

export class EvmFlowFeed extends EventEmitter {
  private token = '';
  private chain: EvmFlowChain = 'ethereum';
  private ws: WebSocket | null = null;
  private running = false;
  private tokens = new Map<string, TokenAgg>();
  private emitTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private ethPriceUsd: number | null = null;

  start(token: string, chain: EvmFlowChain): void {
    if (this.running) return;
    if (!token) {
      this.emit('status', 'no-key');
      return;
    }
    this.token = token;
    this.chain = chain;
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
    this.tokens.clear();
    this.ethPriceUsd = null;
    console.log('[evmflow] stopped');
  }

  private connect(): void {
    if (!this.running) return;
    this.emit('status', 'connecting');
    const url = `${ENDPOINT}?token=${encodeURIComponent(this.token)}`;
    console.log(`[evmflow] connecting to Bitquery stream (${this.chain})`);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, ['graphql-ws']);
    } catch (e) {
      console.log(`[evmflow] connect threw: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      console.log('[evmflow] socket open → connection_init');
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
        case 'connection_ack': {
          console.log('[evmflow] connection_ack → starting subscription');
          this.reconnectAttempts = 0;
          this.emit('status', 'connected');
          const query = buildQuery(CHAIN_CONFIG[this.chain].network);
          ws.send(JSON.stringify({ type: 'start', id: '1', payload: { query } }));
          break;
        }
        case 'data':
        case 'next': {
          const payload = msg.payload as { data?: { EVM?: { DEXTrades?: BqTrade[] } } } | undefined;
          const trades = payload?.data?.EVM?.DEXTrades;
          if (Array.isArray(trades)) {
            for (const t of trades) this.handleTrade(t);
          }
          break;
        }
        case 'error':
        case 'connection_error':
          console.log(`[evmflow] server error: ${JSON.stringify(msg.payload)}`);
          this.emit('status', 'error');
          break;
        case 'complete':
          console.log('[evmflow] subscription complete');
          break;
        case 'ka':
        case 'connection_keep_alive':
        default:
          break;
      }
    });

    ws.on('close', (code) => {
      console.log(`[evmflow] socket closed (${code})`);
      if (this.running) {
        this.emit('status', 'disconnected');
        this.scheduleReconnect();
      }
    });

    ws.on('error', (err: Error) => {
      console.log(`[evmflow] socket error: ${err.message}`);
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

    const weth = CHAIN_CONFIG[this.chain].weth;
    const buyIsWeth = isWeth(buy.Currency.SmartContract, buy.Currency.Symbol, weth);
    const sellIsWeth = isWeth(sell.Currency.SmartContract, sell.Currency.Symbol, weth);
    if (buyIsWeth === sellIsWeth) return; // token↔token or non-WETH pair — skip

    // Token bought (ETH in): token on Buy side, WETH on Sell side.
    // Token sold  (ETH out): token on Sell side, WETH on Buy side.
    const isBuy = sellIsWeth;
    const tokenSide = isBuy ? buy : sell;
    const ethSide = isBuy ? sell : buy;

    const address = tokenSide.Currency?.SmartContract;
    if (!address) return;
    const ethAmount = n(ethSide.Amount);
    if (ethAmount <= 0) return;

    const tsMs = t.Block?.Time ? new Date(t.Block.Time).getTime() : Date.now();

    // Derive token USD price and ETH/USD from the trade's USD values.
    const tokenAmount = n(tokenSide.Amount);
    const tokenUsd = n(tokenSide.AmountInUSD);
    const priceUsd = tokenAmount > 0 && tokenUsd > 0 ? tokenUsd / tokenAmount : null;
    const ethUsd = n(ethSide.AmountInUSD);
    if (ethUsd > 0 && ethAmount > 0) this.ethPriceUsd = ethUsd / ethAmount;

    let agg = this.tokens.get(address);
    if (!agg) {
      if (this.tokens.size >= MAX_TOKENS) this.evictOldest();
      agg = {
        address,
        symbol: tokenSide.Currency?.Symbol ?? null,
        name: tokenSide.Currency?.Name ?? null,
        trades: [],
        firstSeen: tsMs,
        lastTrade: tsMs,
        priceUsd
      };
      this.tokens.set(address, agg);
    }
    if (agg.symbol === null && tokenSide.Currency?.Symbol) agg.symbol = tokenSide.Currency.Symbol;
    if (agg.name === null && tokenSide.Currency?.Name) agg.name = tokenSide.Currency.Name;
    if (priceUsd !== null) agg.priceUsd = priceUsd;
    agg.lastTrade = tsMs;
    agg.trades.push({ t: tsMs, eth: ethAmount, isBuy });
    if (agg.trades.length > MAX_TRADES_PER_TOKEN) {
      agg.trades.splice(0, agg.trades.length - MAX_TRADES_PER_TOKEN);
    }
  }

  private evictOldest(): void {
    let oldestAddr: string | null = null;
    let oldest = Infinity;
    for (const [addr, agg] of this.tokens) {
      if (agg.lastTrade < oldest) { oldest = agg.lastTrade; oldestAddr = addr; }
    }
    if (oldestAddr) this.tokens.delete(oldestAddr);
  }

  private emitSnapshot(): void {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    const computed: EvmFlowToken[] = [];

    for (const [address, agg] of this.tokens) {
      // Drop trades outside the window.
      if (agg.trades.length && agg.trades[0].t < cutoff) {
        let i = 0;
        while (i < agg.trades.length && agg.trades[i].t < cutoff) i++;
        if (i > 0) agg.trades.splice(0, i);
      }
      if (agg.trades.length === 0) {
        // Idle for the whole window — forget it after a grace period.
        if (now - agg.lastTrade > WINDOW_MS + 60_000) this.tokens.delete(address);
        continue;
      }

      let buyVol = 0, sellVol = 0, buyCount = 0, sellCount = 0;
      const buckets = new Array<number>(SPARK_BUCKETS).fill(0);
      const span = WINDOW_MS;
      for (const tr of agg.trades) {
        const signed = tr.isBuy ? tr.eth : -tr.eth;
        if (tr.isBuy) { buyVol += tr.eth; buyCount++; } else { sellVol += tr.eth; sellCount++; }
        let b = Math.floor(((tr.t - cutoff) / span) * SPARK_BUCKETS);
        if (b < 0) b = 0; else if (b >= SPARK_BUCKETS) b = SPARK_BUCKETS - 1;
        buckets[b] += signed;
      }
      // Cumulative net inflow across the window → the sparkline.
      const spark: number[] = [];
      let run = 0;
      for (const v of buckets) { run += v; spark.push(run); }

      computed.push({
        address,
        symbol: agg.symbol,
        name: agg.name,
        netInflowEth: buyVol - sellVol,
        buyVolEth: buyVol,
        sellVolEth: sellVol,
        txCount: agg.trades.length,
        buyCount,
        sellCount,
        priceUsd: agg.priceUsd,
        firstSeen: Math.floor(agg.firstSeen / 1000),
        lastTrade: Math.floor(agg.lastTrade / 1000),
        spark
      });
    }

    // Select a bounded, useful set: strongest inflows, strongest outflows, and
    // the newest tokens — so the UI's Top / Dipping / Early tabs all have data.
    const byNetDesc = [...computed].sort((a, b) => b.netInflowEth - a.netInflowEth);
    const byNetAsc = [...computed].sort((a, b) => a.netInflowEth - b.netInflowEth);
    const byNewest = [...computed].sort((a, b) => b.firstSeen - a.firstSeen);
    const chosen = new Map<string, EvmFlowToken>();
    for (const t of byNetDesc.slice(0, 60)) chosen.set(t.address, t);
    for (const t of byNetAsc.slice(0, 40)) chosen.set(t.address, t);
    for (const t of byNewest.slice(0, 50)) chosen.set(t.address, t);

    const snapshot: EvmFlowSnapshot = {
      chain: this.chain,
      tokens: [...chosen.values()],
      windowMinutes: 15,
      ethPriceUsd: this.ethPriceUsd,
      updatedAt: Math.floor(now / 1000)
    };
    this.emit('update', snapshot);
  }
}
