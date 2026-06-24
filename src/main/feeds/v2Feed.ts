import { EventEmitter } from 'events';
import type { LiveFeedItem } from '../../shared/types';

const V2_FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const PAIR_CREATED_TOPIC = '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9';
// Known "quote" tokens — when one side of a pair is one of these, the other side is the "new" token.
const QUOTE_TOKENS = new Set([
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
  '0x6b175474e89094c44da98b954eedeac495271d0f'  // DAI
]);

const POLL_INTERVAL_MS = 12_000;  // ~one ETH block
const MAX_BLOCK_LAG = 200;        // safety cap if we fall behind

// Cold-start backfill: seed the panel with recent PairCreated events on launch.
// Alchemy's FREE tier caps eth_getLogs at a 10-block range, so we scan backward
// from the head in 10-block windows and stop once we've collected enough (or hit
// the request cap, which bounds startup time / compute-unit usage).
const BACKFILL_TARGET = 10;
const BACKFILL_CHUNK = 10;          // free-tier eth_getLogs max range
const BACKFILL_MAX_REQUESTS = 70;   // ~700 blocks back, ~2s of sequential calls
const SECONDS_PER_BLOCK = 12;

function topicToAddress(topic: string): string {
  return '0x' + topic.slice(-40).toLowerCase();
}

function dataToAddress(data: string, slot: number): string {
  const start = 2 + slot * 64;
  return '0x' + data.slice(start + 24, start + 64).toLowerCase();
}

function toHex(n: number): string {
  return '0x' + n.toString(16);
}

interface RpcLog {
  address?: string;
  topics?: string[];
  data?: string;
  blockNumber?: string;
  transactionHash?: string;
}

interface TokenMeta { symbol: string | null; name: string | null }

async function fetchTokenMeta(alchemyKey: string, contract: string): Promise<TokenMeta> {
  try {
    const res = await fetch(`https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'alchemy_getTokenMetadata',
        params: [contract]
      })
    });
    if (!res.ok) return { symbol: null, name: null };
    const json = (await res.json()) as { result?: { symbol?: string | null; name?: string | null } };
    return { symbol: json.result?.symbol ?? null, name: json.result?.name ?? null };
  } catch {
    return { symbol: null, name: null };
  }
}

async function rpc<T>(alchemyKey: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(`https://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  if (!res.ok) throw new Error(`Alchemy ${method} HTTP ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message?: string } };
  if (json.error) throw new Error(`Alchemy ${method}: ${json.error.message}`);
  return json.result as T;
}

export class V2Feed extends EventEmitter {
  private alchemyKey = '';
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private lastBlock = 0;
  private seenPairs = new Set<string>();

  start(alchemyKey: string): void {
    if (this.running) return;
    if (!alchemyKey) {
      console.log('[v2feed] no Alchemy key — feed will not start');
      this.emit('error', new Error('Alchemy key missing — V2 feed cannot start'));
      return;
    }
    this.alchemyKey = alchemyKey;
    this.running = true;
    console.log('[v2feed] starting (eth_getLogs polling every 12s)');
    this.emit('status', 'connecting');
    this.bootstrap();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log('[v2feed] stopped');
  }

  private async bootstrap(): Promise<void> {
    try {
      const head = await rpc<string>(this.alchemyKey, 'eth_blockNumber', []);
      this.lastBlock = parseInt(head, 16);
      console.log(`[v2feed] head block ${this.lastBlock}, beginning polling`);
      this.emit('status', 'connected');
      // Seed the panel with recent history so it's populated immediately on a
      // cold start, instead of waiting for the next live PairCreated event.
      await this.backfill(this.lastBlock);
    } catch (e) {
      console.log(`[v2feed] bootstrap failed: ${(e as Error).message}`);
      this.emit('status', 'error');
      // Retry bootstrap on the next tick
      this.lastBlock = 0;
    }
    if (!this.running) return;
    this.timer = setInterval(() => this.tick().catch(() => undefined), POLL_INTERVAL_MS);
  }

  // One-time historical scan run at startup. Walks backward from the head in
  // chunks until we've gathered BACKFILL_TARGET recent PairCreated events (or
  // exhausted BACKFILL_MAX_BLOCKS), then emits them oldest→newest so the buffer
  // ends up most-recent-first. Block times are approximated from the head time
  // to avoid an eth_getBlockByNumber call per event.
  private async backfill(head: number): Promise<void> {
    try {
      const headBlock = await rpc<{ timestamp?: string }>(
        this.alchemyKey,
        'eth_getBlockByNumber',
        [toHex(head), false]
      );
      const headTimeSec = headBlock?.timestamp
        ? parseInt(headBlock.timestamp, 16)
        : Math.floor(Date.now() / 1000);

      const collected: RpcLog[] = [];
      let toBlock = head;
      let requests = 0;

      while (
        toBlock > 0 &&
        collected.length < BACKFILL_TARGET &&
        requests < BACKFILL_MAX_REQUESTS &&
        this.running
      ) {
        const fromBlock = Math.max(0, toBlock - BACKFILL_CHUNK + 1);
        requests++;
        let logs: RpcLog[];
        try {
          logs = await rpc<RpcLog[]>(this.alchemyKey, 'eth_getLogs', [{
            fromBlock: toHex(fromBlock),
            toBlock: toHex(toBlock),
            address: V2_FACTORY,
            topics: [PAIR_CREATED_TOPIC]
          }]);
        } catch (chunkErr) {
          // e.g. a transient rate-limit (429). Keep whatever we've gathered.
          console.log(`[v2feed] backfill chunk ${fromBlock}..${toBlock} error: ${(chunkErr as Error).message}`);
          break;
        }
        // Logs come oldest→newest; we want the newest ones first.
        for (let i = logs.length - 1; i >= 0; i--) {
          collected.push(logs[i]);
          if (collected.length >= BACKFILL_TARGET) break;
        }
        toBlock = fromBlock - 1;
      }

      if (!this.running) return;

      // Emit oldest→newest so the downstream buffer (which prepends) ends
      // most-recent-first, matching live-event ordering.
      const ordered = collected.slice(0, BACKFILL_TARGET).reverse();
      console.log(`[v2feed] backfill seeded ${ordered.length} recent PairCreated event(s)`);
      for (const log of ordered) {
        const blockNum = log.blockNumber ? parseInt(log.blockNumber, 16) : head;
        const blockTime = headTimeSec - Math.max(0, head - blockNum) * SECONDS_PER_BLOCK;
        this.handleLog(log, blockTime);
      }
    } catch (e) {
      console.log(`[v2feed] backfill skipped: ${(e as Error).message}`);
    } finally {
      // Signal that the one-time historical seed is done. The main process uses
      // this to push a fresh snapshot to the renderer, covering the race where
      // the renderer fetched the (then-empty) buffer before backfill finished.
      this.emit('backfill');
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      // Bootstrap retry if the first call failed
      if (this.lastBlock === 0) {
        const head = await rpc<string>(this.alchemyKey, 'eth_blockNumber', []);
        this.lastBlock = parseInt(head, 16);
        this.emit('status', 'connected');
        return;
      }

      const headHex = await rpc<string>(this.alchemyKey, 'eth_blockNumber', []);
      const head = parseInt(headHex, 16);
      if (head <= this.lastBlock) return;

      const startBlock = Math.max(this.lastBlock + 1, head - MAX_BLOCK_LAG);

      // Alchemy's free tier caps eth_getLogs at a 10-block range, so walk from
      // the last-seen block to the head in <=10-block windows. Normally this is
      // a single tiny window; after a sleep/lag it catches up in chunks instead
      // of issuing one oversized (and rejected) request.
      const logs: RpcLog[] = [];
      for (let from = startBlock; from <= head; from += BACKFILL_CHUNK) {
        const to = Math.min(head, from + BACKFILL_CHUNK - 1);
        const chunk = await rpc<RpcLog[]>(this.alchemyKey, 'eth_getLogs', [{
          fromBlock: toHex(from),
          toBlock: toHex(to),
          address: V2_FACTORY,
          topics: [PAIR_CREATED_TOPIC]
        }]);
        logs.push(...chunk);
      }

      this.lastBlock = head;
      this.emit('status', 'connected');

      console.log(`[v2feed] tick blocks ${startBlock}..${head} → ${logs.length} raw PairCreated log(s)`);
      for (const log of logs) {
        this.handleLog(log);
      }
    } catch (e) {
      console.log(`[v2feed] tick error: ${(e as Error).message}`);
      this.emit('status', 'reconnecting');
    }
  }

  private handleLog(log: RpcLog, blockTimeOverride?: number): void {
    if (!log.topics || log.topics.length < 3 || !log.data) return;
    const token0 = topicToAddress(log.topics[1]);
    const token1 = topicToAddress(log.topics[2]);
    const pair = dataToAddress(log.data, 0);
    if (this.seenPairs.has(pair)) return;
    this.seenPairs.add(pair);
    // Cap the dedupe set so it doesn't grow forever.
    if (this.seenPairs.size > 2000) {
      const first = this.seenPairs.values().next().value;
      if (first) this.seenPairs.delete(first);
    }
    // Pick the "new" token: the side that isn't a known quote (WETH/USDC/USDT/DAI).
    // If both are quotes (rare), or neither is, default to token0.
    const t0IsQuote = QUOTE_TOKENS.has(token0);
    const t1IsQuote = QUOTE_TOKENS.has(token1);
    const newToken = t0IsQuote && !t1IsQuote ? token1 : !t0IsQuote && t1IsQuote ? token0 : token0;

    const item: LiveFeedItem = {
      contract: newToken,
      pair,
      symbol: null,
      name: null,
      blockTime: blockTimeOverride ?? Math.floor(Date.now() / 1000),
      txHash: log.transactionHash ?? ''
    };

    console.log(`[v2feed] PairCreated token=${newToken} pair=${pair}`);
    this.emit('deploy', item);
    fetchTokenMeta(this.alchemyKey, newToken).then((meta) => {
      if (meta.symbol === null && meta.name === null) return;
      this.emit('deploy:update', { ...item, ...meta });
    });
  }
}
