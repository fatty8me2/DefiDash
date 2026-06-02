import { EventEmitter } from 'events';
import WebSocket from 'ws';
import type { EvmFlowChain, EvmFlowSnapshot, EvmFlowToken } from '../../shared/types';

// Live Uniswap-V2 net-ETH-inflow tracker built on a DIRECT Alchemy WebSocket
// (eth_subscribe "logs") instead of a metered third-party API. We subscribe to
// every V2-style Swap event on the chain, resolve each pair's tokens once via
// cached eth_call lookups, keep only WETH-paired trades, and compute net ETH
// inflow + price ourselves. Runs on the user's existing Alchemy key — no
// Bitquery involved.
const ALCHEMY_WS = (sub: string, key: string): string => `wss://${sub}.g.alchemy.com/v2/${key}`;
const ALCHEMY_HTTP = (sub: string, key: string): string => `https://${sub}.g.alchemy.com/v2/${key}`;

// keccak256("Swap(address,uint256,uint256,uint256,uint256,address)") — the
// Uniswap V2 Swap event (shared by every V2 fork: Sushi, ShibaSwap, etc.).
const SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';

// ERC-20 / pair function selectors (first 4 bytes of keccak256 of the signature).
const SEL_TOKEN0 = '0x0dfe1681';   // token0()
const SEL_TOKEN1 = '0xd21220a7';   // token1()
const SEL_DECIMALS = '0x313ce567'; // decimals()
const SEL_SYMBOL = '0x95d89b41';   // symbol()
const SEL_NAME = '0x06fdde03';     // name()

const WINDOW_MS = 15 * 60 * 1000;     // 15-minute rolling window
const EMIT_INTERVAL_MS = 2_000;       // push a fresh snapshot to the UI every 2s
const SPARK_BUCKETS = 24;             // points in each card's mini chart
const MAX_TRADES_PER_TOKEN = 4_000;   // safety cap per token
const MAX_TOKENS = 5_000;             // safety cap on tracked tokens
const MAX_PAIRS = 20_000;             // safety cap on the pair cache
const MAX_PENDING = 40;               // concurrent pair-resolution lookups
const MAX_BUFFER_PER_PAIR = 40;       // swaps buffered while a pair resolves
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const ETH_PRICE_POLL_MS = 60_000;     // refresh ETH/USD once a minute

// Per-chain config: Alchemy subdomain + the wrapped-native (WETH) address used
// as the quote side. Base's native asset is also ETH. A single Alchemy key
// works across both networks (only the subdomain changes).
const CHAIN_CONFIG: Record<EvmFlowChain, { sub: string; weth: string; cgId: string }> = {
  ethereum: { sub: 'eth-mainnet', weth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', cgId: 'ethereum' },
  base: { sub: 'base-mainnet', weth: '0x4200000000000000000000000000000000000006', cgId: 'ethereum' }
};

interface RawSwap {
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
  t: number;
}

interface PairInfo {
  token: string;          // the non-WETH ERC-20 address
  wethIsToken0: boolean;  // is WETH token0 of the pair?
  decimals: number;       // decimals of the non-WETH token
  symbol: string | null;
  name: string | null;
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
  priceEth: number | null; // last token price in ETH (from swap ratio)
}

function hexToBig(hex: string): bigint {
  if (!hex || hex === '0x') return 0n;
  try { return BigInt(hex.startsWith('0x') ? hex : `0x${hex}`); } catch { return 0n; }
}

// Decode an eth_call return value that is either an ABI dynamic string or a
// legacy bytes32 (e.g. MKR). Returns null on empty/garbage.
function decodeString(hexResult: string | undefined): string | null {
  if (!hexResult || hexResult === '0x') return null;
  const data = hexResult.slice(2);
  let raw: string;
  try {
    if (data.length >= 128) {
      // dynamic string: [offset][length][bytes...]
      const offset = Number(hexToBig(`0x${data.slice(0, 64)}`)) * 2;
      const len = Number(hexToBig(`0x${data.slice(offset, offset + 64)}`));
      const strHex = data.slice(offset + 64, offset + 64 + len * 2);
      raw = Buffer.from(strHex, 'hex').toString('utf8');
    } else {
      // legacy bytes32 (NUL-padded)
      raw = Buffer.from(data, 'hex').toString('utf8');
    }
  } catch {
    return null;
  }
  // Keep printable ASCII (space..~), drop NUL/control padding. Keeps spaces so
  // names like "Shiba Inu" survive.
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c >= 0x20 && c < 0x7f) out += raw[i];
  }
  out = out.trim();
  if (!out) return null;
  return out.length > 40 ? out.slice(0, 40) : out;
}

// An eth_call address result is a left-padded 32-byte word; the address is the
// trailing 20 bytes. Returns a lowercased 0x address or null.
function addrFromResult(hex: string | undefined): string | null {
  if (!hex || hex === '0x' || hex.length < 42) return null;
  const a = `0x${hex.slice(-40)}`.toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(a) ? a : null;
}

export class EvmFlowFeed extends EventEmitter {
  private apiKey = '';
  private chain: EvmFlowChain = 'ethereum';
  private ws: WebSocket | null = null;
  private running = false;
  private tokens = new Map<string, TokenAgg>();
  private pairInfo = new Map<string, PairInfo>();    // resolved WETH pairs
  private pairIgnore = new Set<string>();            // resolved non-WETH pairs
  private pairPending = new Set<string>();           // in-flight resolutions
  private pairBuffer = new Map<string, RawSwap[]>(); // swaps awaiting resolution
  private emitTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private ethPriceTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private ethPriceUsd: number | null = null;

  start(apiKey: string, chain: EvmFlowChain): void {
    if (this.running) return;
    if (!apiKey) {
      this.emit('status', 'no-key');
      return;
    }
    this.apiKey = apiKey;
    this.chain = chain;
    this.running = true;
    this.reconnectAttempts = 0;
    this.connect();
    this.emitTimer = setInterval(() => this.emitSnapshot(), EMIT_INTERVAL_MS);
    void this.refreshEthPrice();
    this.ethPriceTimer = setInterval(() => void this.refreshEthPrice(), ETH_PRICE_POLL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.emitTimer) { clearInterval(this.emitTimer); this.emitTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ethPriceTimer) { clearInterval(this.ethPriceTimer); this.ethPriceTimer = null; }
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.tokens.clear();
    this.pairInfo.clear();
    this.pairIgnore.clear();
    this.pairPending.clear();
    this.pairBuffer.clear();
    this.ethPriceUsd = null;
    console.log('[evmflow] stopped');
  }

  private connect(): void {
    if (!this.running) return;
    this.emit('status', 'connecting');
    const { sub } = CHAIN_CONFIG[this.chain];
    console.log(`[evmflow] connecting to Alchemy logs stream (${this.chain})`);

    let ws: WebSocket;
    try {
      ws = new WebSocket(ALCHEMY_WS(sub, this.apiKey));
    } catch (e) {
      console.log(`[evmflow] connect threw: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      console.log('[evmflow] socket open -> eth_subscribe(logs)');
      this.reconnectAttempts = 0;
      this.emit('status', 'connected');
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_subscribe',
        params: ['logs', { topics: [SWAP_TOPIC] }]
      }));
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      let msg: {
        id?: number;
        result?: unknown;
        method?: string;
        error?: { message?: string };
        params?: { result?: { address?: string; data?: string; removed?: boolean } };
      };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.error) {
        console.log(`[evmflow] rpc error: ${msg.error.message}`);
        this.emit('status', 'error');
        return;
      }
      if (msg.id === 1 && msg.result !== undefined) {
        console.log(`[evmflow] subscribed (id=${String(msg.result)})`);
        return;
      }
      if (msg.method === 'eth_subscription') {
        const log = msg.params?.result;
        if (log && !log.removed && log.address && log.data) {
          this.handleLog(log.address.toLowerCase(), log.data);
        }
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

  // A Uniswap V2 Swap log. `data` is 4 packed uint256:
  // amount0In, amount1In, amount0Out, amount1Out.
  private handleLog(pair: string, data: string): void {
    const d = data.startsWith('0x') ? data.slice(2) : data;
    if (d.length < 256) return;
    const swap: RawSwap = {
      amount0In: hexToBig(`0x${d.slice(0, 64)}`),
      amount1In: hexToBig(`0x${d.slice(64, 128)}`),
      amount0Out: hexToBig(`0x${d.slice(128, 192)}`),
      amount1Out: hexToBig(`0x${d.slice(192, 256)}`),
      t: Date.now()
    };

    if (this.pairIgnore.has(pair)) return;
    const info = this.pairInfo.get(pair);
    if (info) {
      this.applySwap(info, swap);
      return;
    }
    // Unknown pair: buffer this swap and kick off a one-time resolution.
    let buf = this.pairBuffer.get(pair);
    if (!buf) { buf = []; this.pairBuffer.set(pair, buf); }
    if (buf.length < MAX_BUFFER_PER_PAIR) buf.push(swap);
    if (!this.pairPending.has(pair) && this.pairPending.size < MAX_PENDING) {
      void this.resolvePair(pair);
    }
  }

  private applySwap(info: PairInfo, s: RawSwap): void {
    // WETH side amounts.
    const wethIn = info.wethIsToken0 ? s.amount0In : s.amount1In;
    const wethOut = info.wethIsToken0 ? s.amount0Out : s.amount1Out;
    const tokIn = info.wethIsToken0 ? s.amount1In : s.amount0In;
    const tokOut = info.wethIsToken0 ? s.amount1Out : s.amount0Out;

    // Trader pays WETH (wethIn>0) -> buying the token. Trader receives WETH
    // (wethOut>0) -> selling the token.
    const isBuy = wethIn > 0n;
    const wethRaw = isBuy ? wethIn : wethOut;
    if (wethRaw <= 0n) return;
    const tokRaw = isBuy ? tokOut : tokIn;

    const eth = Number(wethRaw) / 1e18;
    if (!(eth > 0)) return;

    const tokAmt = info.decimals >= 0 ? Number(tokRaw) / 10 ** info.decimals : 0;
    const priceEth = tokAmt > 0 ? eth / tokAmt : null;

    let agg = this.tokens.get(info.token);
    if (!agg) {
      if (this.tokens.size >= MAX_TOKENS) this.evictOldest();
      agg = {
        address: info.token,
        symbol: info.symbol,
        name: info.name,
        trades: [],
        firstSeen: s.t,
        lastTrade: s.t,
        priceEth
      };
      this.tokens.set(info.token, agg);
    }
    if (agg.symbol === null && info.symbol) agg.symbol = info.symbol;
    if (agg.name === null && info.name) agg.name = info.name;
    if (priceEth !== null) agg.priceEth = priceEth;
    agg.lastTrade = s.t;
    agg.trades.push({ t: s.t, eth, isBuy });
    if (agg.trades.length > MAX_TRADES_PER_TOKEN) {
      agg.trades.splice(0, agg.trades.length - MAX_TRADES_PER_TOKEN);
    }
  }

  // Resolve a pair's tokens once (token0/token1 -> WETH side -> token metadata),
  // then flush any swaps buffered while it was resolving.
  private async resolvePair(pair: string): Promise<void> {
    this.pairPending.add(pair);
    try {
      const weth = CHAIN_CONFIG[this.chain].weth;
      const [t0, t1] = await this.ethCallBatch(pair, [SEL_TOKEN0, SEL_TOKEN1]);
      const token0 = addrFromResult(t0);
      const token1 = addrFromResult(t1);
      if (!token0 || !token1) throw new Error('no tokens');

      const wethIsToken0 = token0 === weth;
      const wethIsToken1 = token1 === weth;
      if (!wethIsToken0 && !wethIsToken1) {
        // Not a WETH pair — remember and forget.
        this.pairIgnore.add(pair);
        this.pairBuffer.delete(pair);
        return;
      }
      const tokenAddr = wethIsToken0 ? token1 : token0;
      const [decRes, symRes, nameRes] = await this.ethCallBatch(tokenAddr, [SEL_DECIMALS, SEL_SYMBOL, SEL_NAME]);
      const decimals = decRes && decRes !== '0x' ? Number(hexToBig(decRes)) : 18;

      const info: PairInfo = {
        token: tokenAddr,
        wethIsToken0,
        decimals: Number.isFinite(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 18,
        symbol: decodeString(symRes),
        name: decodeString(nameRes)
      };
      if (this.pairInfo.size < MAX_PAIRS) this.pairInfo.set(pair, info);

      const buf = this.pairBuffer.get(pair);
      if (buf) { for (const s of buf) this.applySwap(info, s); }
      this.pairBuffer.delete(pair);
    } catch {
      // Leave unresolved; a future swap on this pair will retry. Drop the
      // buffer so it can't grow unbounded.
      this.pairBuffer.delete(pair);
    } finally {
      this.pairPending.delete(pair);
    }
  }

  // Batched eth_call against the chain's Alchemy HTTP endpoint.
  private async ethCallBatch(to: string, selectors: string[]): Promise<(string | undefined)[]> {
    const { sub } = CHAIN_CONFIG[this.chain];
    const body = selectors.map((data, i) => ({
      jsonrpc: '2.0',
      id: i,
      method: 'eth_call',
      params: [{ to, data }, 'latest']
    }));
    const res = await fetch(ALCHEMY_HTTP(sub, this.apiKey), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const json = (await res.json()) as { id?: number; result?: string }[];
    const out: (string | undefined)[] = new Array(selectors.length).fill(undefined);
    if (Array.isArray(json)) {
      for (const r of json) {
        if (typeof r?.id === 'number' && r.id >= 0 && r.id < out.length) out[r.id] = r.result;
      }
    }
    return out;
  }

  private async refreshEthPrice(): Promise<void> {
    try {
      const id = CHAIN_CONFIG[this.chain].cgId;
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
        { headers: { accept: 'application/json' } }
      );
      if (!res.ok) return;
      const json = (await res.json()) as Record<string, { usd?: number }>;
      const px = json?.[id]?.usd;
      if (typeof px === 'number' && px > 0) this.ethPriceUsd = px;
    } catch {
      // keep last known price
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

      const priceUsd = agg.priceEth !== null && this.ethPriceUsd !== null
        ? agg.priceEth * this.ethPriceUsd
        : null;

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
        priceUsd,
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
