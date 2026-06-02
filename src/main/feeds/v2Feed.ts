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
    } catch (e) {
      console.log(`[v2feed] bootstrap failed: ${(e as Error).message}`);
      this.emit('status', 'error');
      // Retry bootstrap on the next tick
      this.lastBlock = 0;
    }
    if (!this.running) return;
    this.timer = setInterval(() => this.tick().catch(() => undefined), POLL_INTERVAL_MS);
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

      const fromBlock = Math.max(this.lastBlock + 1, head - MAX_BLOCK_LAG);
      const toBlock = head;

      const logs = await rpc<RpcLog[]>(this.alchemyKey, 'eth_getLogs', [{
        fromBlock: toHex(fromBlock),
        toBlock: toHex(toBlock),
        address: V2_FACTORY,
        topics: [PAIR_CREATED_TOPIC]
      }]);

      this.lastBlock = toBlock;
      this.emit('status', 'connected');

      console.log(`[v2feed] tick blocks ${fromBlock}..${toBlock} → ${logs.length} raw PairCreated log(s)`);
      for (const log of logs) {
        this.handleLog(log);
      }
    } catch (e) {
      console.log(`[v2feed] tick error: ${(e as Error).message}`);
      this.emit('status', 'reconnecting');
    }
  }

  private handleLog(log: RpcLog): void {
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
      blockTime: Math.floor(Date.now() / 1000),
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
