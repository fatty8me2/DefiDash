import { EventEmitter } from 'events';
import crypto from 'crypto';
import WebSocket from 'ws';
import type { FlowSnapshot, FlowToken } from '../../shared/types';

// Live pump.fun net-inflow tracker built on a DIRECT Helius WebSocket
// (logsSubscribe) instead of a metered third-party API. We subscribe to the
// pump.fun bonding-curve program, decode its Anchor `TradeEvent` / `CreateEvent`
// logs ourselves, and compute net SOL inflow + price from the curve reserves.
// This removes the Bitquery quota dependency for Solana entirely — it runs on
// the user's existing Helius key.
const HELIUS_WS = (key: string): string => `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
const HELIUS_RPC = (key: string): string => `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;

// pump.fun bonding-curve program. Every pre-graduation trade mentions it.
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

const WINDOW_MS = 15 * 60 * 1000;     // 15-minute rolling window
const EMIT_INTERVAL_MS = 2_000;       // push a fresh snapshot to the UI every 2s
const SPARK_BUCKETS = 24;             // points in each card's mini chart
const PUMP_SUPPLY = 1_000_000_000;    // pump.fun fixed total supply
const TOKEN_DECIMALS = 1e6;           // pump.fun SPL mints use 6 decimals
const LAMPORTS = 1e9;                 // SOL has 9 decimals
const MAX_TRADES_PER_MINT = 4_000;    // safety cap per mint
const MAX_MINTS = 5_000;              // safety cap on tracked mints
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const SOL_PRICE_POLL_MS = 60_000;     // refresh SOL/USD once a minute
const META_BATCH = 80;                // mints per DAS metadata batch
const META_MAX_PER_TICK = 80;         // cap metadata lookups kicked off per snapshot

// Anchor logs events as `Program data: <base64>` where the first 8 bytes are
// sha256("event:<Name>")[..8]. Computing the discriminators at runtime avoids
// hardcoding magic byte arrays.
function anchorDisc(name: string): Buffer {
  return crypto.createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
}
const TRADE_DISC = anchorDisc('TradeEvent');
const CREATE_DISC = anchorDisc('CreateEvent');

// Minimal base58 (Bitcoin alphabet) encoder for 32-byte pubkeys.
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

function u64(buf: Buffer, off: number): number {
  // Magnitudes here (lamports, 1e6-scaled token units) stay well within
  // Number's safe-integer range once scaled, so Number() is fine.
  return Number(buf.readBigUInt64LE(off));
}

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
  metaTried: boolean;     // have we attempted a DAS metadata lookup yet?
  trades: TradeRec[];
  firstSeen: number;      // ms
  lastTrade: number;      // ms
  priceUsd: number | null;
  priceSol: number | null; // last token price in SOL (from curve reserves)
  // Launch-bundle tracking. A pump.fun bundle lands atomically in the same slot
  // as the CreateEvent; we sum the buy token amounts in that slot.
  sawCreate: boolean;          // did we witness this mint's CreateEvent live?
  createSlot: number | null;   // slot the CreateEvent landed in
  firstSlot: number | null;    // earliest slot we observed any event for this mint
  bundleTokens: number;        // Σ token units bought in the creation slot (raw, scaled)
  bundleWallets: Set<string>;  // distinct wallets that bought in the creation slot
}

interface DecodedTrade {
  mint: string;
  sol: number;       // SOL (positive)
  isBuy: boolean;
  priceSol: number | null; // SOL per token, from virtual reserves
  tsMs: number;
  tokens: number;    // token units traded (scaled to whole tokens)
  user: string;      // trader wallet
}

interface DecodedCreate {
  mint: string;
  name: string | null;
  symbol: string | null;
  uri: string | null;
}

export class PumpFlowFeed extends EventEmitter {
  private apiKey = '';
  private ws: WebSocket | null = null;
  private running = false;
  private mints = new Map<string, MintAgg>();
  private emitTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private solPriceTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private solPriceUsd: number | null = null;
  private metaInFlight = new Set<string>();

  start(apiKey: string): void {
    if (this.running) return;
    if (!apiKey) {
      this.emit('status', 'no-key');
      return;
    }
    this.apiKey = apiKey;
    this.running = true;
    this.reconnectAttempts = 0;
    this.connect();
    this.emitTimer = setInterval(() => this.emitSnapshot(), EMIT_INTERVAL_MS);
    // Kick an immediate SOL price fetch, then refresh on a slow cadence.
    void this.refreshSolPrice();
    this.solPriceTimer = setInterval(() => void this.refreshSolPrice(), SOL_PRICE_POLL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.emitTimer) { clearInterval(this.emitTimer); this.emitTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.solPriceTimer) { clearInterval(this.solPriceTimer); this.solPriceTimer = null; }
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.mints.clear();
    this.metaInFlight.clear();
    console.log('[pumpflow] stopped');
  }

  private connect(): void {
    if (!this.running) return;
    this.emit('status', 'connecting');
    console.log('[pumpflow] connecting to Helius logsSubscribe stream');

    let ws: WebSocket;
    try {
      ws = new WebSocket(HELIUS_WS(this.apiKey));
    } catch (e) {
      console.log(`[pumpflow] connect threw: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      console.log('[pumpflow] socket open → logsSubscribe');
      this.reconnectAttempts = 0;
      this.emit('status', 'connected');
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'logsSubscribe',
        params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'confirmed' }]
      }));
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      let msg: {
        id?: number;
        result?: unknown;
        method?: string;
        error?: { message?: string };
        params?: { result?: { value?: { logs?: string[]; err?: unknown }; context?: { slot?: number } } };
      };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.error) {
        console.log(`[pumpflow] rpc error: ${msg.error.message}`);
        this.emit('status', 'error');
        return;
      }
      if (msg.id === 1 && msg.result !== undefined) {
        console.log(`[pumpflow] subscribed (id=${String(msg.result)})`);
        return;
      }
      if (msg.method === 'logsNotification') {
        const value = msg.params?.result?.value;
        const slot = msg.params?.result?.context?.slot ?? null;
        if (value && !value.err && Array.isArray(value.logs)) {
          this.handleLogs(value.logs, slot);
        }
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

  // Scan a transaction's logs for pump.fun Anchor events.
  private handleLogs(logs: string[], slot: number | null): void {
    for (const line of logs) {
      const idx = line.indexOf('Program data: ');
      if (idx === -1) continue;
      const b64 = line.slice(idx + 'Program data: '.length).trim();
      let buf: Buffer;
      try {
        buf = Buffer.from(b64, 'base64');
      } catch {
        continue;
      }
      if (buf.length < 8) continue;
      const disc = buf.subarray(0, 8);
      if (disc.equals(TRADE_DISC)) {
        const tr = decodeTrade(buf);
        if (tr) this.applyTrade(tr, slot);
      } else if (disc.equals(CREATE_DISC)) {
        const cr = decodeCreate(buf);
        if (cr) this.applyCreate(cr, slot);
      }
    }
  }

  private applyTrade(tr: DecodedTrade, slot: number | null): void {
    if (tr.sol <= 0) return;
    let agg = this.mints.get(tr.mint);
    if (!agg) {
      if (this.mints.size >= MAX_MINTS) this.evictOldest();
      agg = {
        mint: tr.mint,
        symbol: null,
        name: null,
        uri: null,
        metaTried: false,
        trades: [],
        firstSeen: tr.tsMs,
        lastTrade: tr.tsMs,
        priceUsd: null,
        priceSol: tr.priceSol,
        sawCreate: false,
        createSlot: null,
        firstSlot: slot,
        bundleTokens: 0,
        bundleWallets: new Set()
      };
      this.mints.set(tr.mint, agg);
    }
    if (tr.priceSol !== null) {
      agg.priceSol = tr.priceSol;
      agg.priceUsd = this.solPriceUsd !== null ? tr.priceSol * this.solPriceUsd : agg.priceUsd;
    }
    agg.lastTrade = tr.tsMs;
    agg.trades.push({ t: tr.tsMs, sol: tr.sol, isBuy: tr.isBuy });
    if (agg.trades.length > MAX_TRADES_PER_MINT) {
      agg.trades.splice(0, agg.trades.length - MAX_TRADES_PER_MINT);
    }
    // Bundle accounting: a launch bundle is the set of buys in the same slot the
    // mint was created. Track the earliest slot we see and accumulate buys there.
    if (slot !== null) {
      if (agg.firstSlot === null) agg.firstSlot = slot;
      if (tr.isBuy && agg.firstSlot === slot) {
        agg.bundleTokens += tr.tokens;
        if (agg.bundleWallets.size < 500) agg.bundleWallets.add(tr.user);
      }
    }
  }

  private applyCreate(cr: DecodedCreate, slot: number | null): void {
    const agg = this.mints.get(cr.mint);
    if (agg) {
      if (agg.symbol === null && cr.symbol) agg.symbol = cr.symbol;
      if (agg.name === null && cr.name) agg.name = cr.name;
      if (agg.uri === null && cr.uri) agg.uri = cr.uri;
      agg.metaTried = true;
      agg.sawCreate = true;
      if (slot !== null) {
        if (agg.createSlot === null) agg.createSlot = slot;
        if (agg.firstSlot === null) agg.firstSlot = slot;
      }
    } else {
      // Seed a metadata-only record; trades may follow within the window.
      const now = Date.now();
      if (this.mints.size < MAX_MINTS) {
        this.mints.set(cr.mint, {
          mint: cr.mint,
          symbol: cr.symbol,
          name: cr.name,
          uri: cr.uri,
          metaTried: true,
          trades: [],
          firstSeen: now,
          lastTrade: now,
          priceUsd: null,
          priceSol: null,
          sawCreate: true,
          createSlot: slot,
          firstSlot: slot,
          bundleTokens: 0,
          bundleWallets: new Set()
        });
      }
    }
  }

  private evictOldest(): void {
    let oldestMint: string | null = null;
    let oldest = Infinity;
    for (const [mint, agg] of this.mints) {
      if (agg.lastTrade < oldest) { oldest = agg.lastTrade; oldestMint = mint; }
    }
    if (oldestMint) this.mints.delete(oldestMint);
  }

  // --- SOL/USD price (free, no key) ---
  private async refreshSolPrice(): Promise<void> {
    try {
      const res = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
        { headers: { accept: 'application/json' } }
      );
      if (!res.ok) return;
      const json = (await res.json()) as { solana?: { usd?: number } };
      const px = json?.solana?.usd;
      if (typeof px === 'number' && px > 0) this.solPriceUsd = px;
    } catch {
      // keep last known price
    }
  }

  // --- Lazy metadata via Helius DAS (only for mints we actually display) ---
  private async fetchMetadata(mints: string[]): Promise<void> {
    const ids = mints.filter((m) => !this.metaInFlight.has(m)).slice(0, META_BATCH);
    if (ids.length === 0) return;
    ids.forEach((m) => this.metaInFlight.add(m));
    try {
      const res = await fetch(HELIUS_RPC(this.apiKey), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'meta', method: 'getAssetBatch', params: { ids } })
      });
      if (res.ok) {
        const json = (await res.json()) as { result?: DasAsset[] };
        const assets = json?.result ?? [];
        for (const a of assets) {
          if (!a?.id) continue;
          const agg = this.mints.get(a.id);
          if (!agg) continue;
          const meta = a.content?.metadata;
          if (agg.symbol === null && meta?.symbol) agg.symbol = meta.symbol;
          if (agg.name === null && meta?.name) agg.name = meta.name;
          if (agg.uri === null) agg.uri = a.content?.json_uri ?? a.content?.links?.image ?? null;
        }
      }
    } catch {
      // best-effort; we'll mark them tried so we don't hammer the endpoint
    } finally {
      for (const m of ids) {
        this.metaInFlight.delete(m);
        const agg = this.mints.get(m);
        if (agg) agg.metaTried = true;
      }
    }
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
      const priceUsd = agg.priceUsd ?? (agg.priceSol !== null && this.solPriceUsd !== null
        ? agg.priceSol * this.solPriceUsd
        : null);
      const marketCapUsd = priceUsd !== null ? priceUsd * PUMP_SUPPLY : null;

      // Bundled% is only meaningful when we witnessed the launch live (the
      // CreateEvent) and the bundle slot matches the first slot we observed.
      const launchObserved = agg.sawCreate && agg.createSlot !== null && agg.createSlot === agg.firstSlot;
      const bundledPct = launchObserved ? Math.min(100, (agg.bundleTokens / PUMP_SUPPLY) * 100) : null;
      const bundleWallets = launchObserved ? agg.bundleWallets.size : 0;

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
        priceUsd,
        marketCapUsd,
        firstSeen: Math.floor(agg.firstSeen / 1000),
        lastTrade: Math.floor(agg.lastTrade / 1000),
        spark,
        bundledPct,
        bundleWallets
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

    // Lazily resolve metadata for any displayed mint we haven't named yet.
    const needMeta: string[] = [];
    for (const t of chosen.values()) {
      if (t.symbol === null) {
        const agg = this.mints.get(t.mint);
        if (agg && !agg.metaTried && !this.metaInFlight.has(t.mint)) needMeta.push(t.mint);
      }
    }
    if (needMeta.length) void this.fetchMetadata(needMeta.slice(0, META_MAX_PER_TICK));

    const snapshot: FlowSnapshot = {
      tokens: [...chosen.values()],
      windowMinutes: 15,
      solPriceUsd: this.solPriceUsd,
      updatedAt: Math.floor(now / 1000)
    };
    this.emit('update', snapshot);
  }
}

// --- Anchor event decoders ---

// TradeEvent layout (after the 8-byte discriminator):
//   mint:Pubkey(32) solAmount:u64(8) tokenAmount:u64(8) isBuy:bool(1)
//   user:Pubkey(32) timestamp:i64(8) virtualSolReserves:u64(8)
//   virtualTokenReserves:u64(8) realSolReserves:u64(8) realTokenReserves:u64(8)
function decodeTrade(buf: Buffer): DecodedTrade | null {
  if (buf.length < 8 + 121) return null;
  let o = 8;
  const mint = base58(buf.subarray(o, o + 32)); o += 32;
  const solAmount = u64(buf, o); o += 8;
  const tokenAmount = u64(buf, o); o += 8;
  const isBuy = buf[o] === 1; o += 1;
  const user = base58(buf.subarray(o, o + 32)); o += 32;
  const ts = Number(buf.readBigInt64LE(o)); o += 8;
  const virtualSolReserves = u64(buf, o); o += 8;
  const virtualTokenReserves = u64(buf, o); o += 8;
  // realSol / realToken reserves follow but are unused here.

  const sol = solAmount / LAMPORTS;
  const priceSol = virtualTokenReserves > 0
    ? (virtualSolReserves / LAMPORTS) / (virtualTokenReserves / TOKEN_DECIMALS)
    : null;
  const tsMs = ts > 0 ? ts * 1000 : Date.now();
  return { mint, sol, isBuy, priceSol, tsMs, tokens: tokenAmount / TOKEN_DECIMALS, user };
}

// CreateEvent layout (after the discriminator):
//   name:string symbol:string uri:string mint:Pubkey(32) ...
function decodeCreate(buf: Buffer): DecodedCreate | null {
  try {
    let o = 8;
    const name = readBorshString(buf, o); o = name.next;
    const symbol = readBorshString(buf, name.next); o = symbol.next;
    const uri = readBorshString(buf, symbol.next); o = uri.next;
    if (o + 32 > buf.length) return null;
    const mint = base58(buf.subarray(o, o + 32));
    return {
      mint,
      name: name.value || null,
      symbol: symbol.value || null,
      uri: uri.value || null
    };
  } catch {
    return null;
  }
}

function readBorshString(buf: Buffer, off: number): { value: string; next: number } {
  const len = buf.readUInt32LE(off);
  const start = off + 4;
  const end = start + len;
  if (end > buf.length) throw new Error('string overrun');
  return { value: buf.subarray(start, end).toString('utf8'), next: end };
}

interface DasAsset {
  id?: string;
  content?: {
    json_uri?: string;
    metadata?: { name?: string; symbol?: string };
    links?: { image?: string };
  };
}
