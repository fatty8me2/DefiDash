import { EventEmitter } from 'events';
import type { LiveFeedItem } from '../../shared/types';

const POLL_INTERVAL_MS = 30_000;
const MAX_AGE_MS = 30 * 60 * 1000; // drop unverified candidates after 30 min
const PER_REQUEST_DELAY_MS = 220;  // ~4.5 req/s, under Etherscan's 5/s free-tier cap

interface Candidate {
  item: LiveFeedItem;
  addedAt: number;
}

interface EtherscanSourceResult {
  status?: string;
  result?: Array<{ ContractName?: string; SourceCode?: string }>;
}

export class VerifiedFeed extends EventEmitter {
  private etherscanKey = '';
  private running = false;
  private pending = new Map<string, Candidate>(); // key = contract (lowercased)
  private seenVerified = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  start(etherscanKey: string): void {
    if (this.running) return;
    if (!etherscanKey) {
      console.log('[verifiedfeed] no Etherscan key — disabled');
      this.emit('status', 'no-key');
      this.emit('error', new Error('Etherscan key missing — verified feed disabled'));
      return;
    }
    this.etherscanKey = etherscanKey;
    this.running = true;
    console.log('[verifiedfeed] starting (poll every 30s)');
    this.emit('status', 'connected');
    this.timer = setInterval(() => this.poll().catch(() => undefined), POLL_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }

  enqueue(item: LiveFeedItem): void {
    if (!this.running) return;
    const key = item.contract.toLowerCase();
    if (this.seenVerified.has(key) || this.pending.has(key)) return;
    this.pending.set(key, { item, addedAt: Date.now() });
  }

  /** If a deploy item gets metadata after enqueue, refresh the candidate so the verified event has it. */
  updateMetadata(item: LiveFeedItem): void {
    const key = item.contract.toLowerCase();
    const existing = this.pending.get(key);
    if (existing) existing.item = { ...existing.item, ...item };
  }

  private async poll(): Promise<void> {
    if (!this.running || this.pending.size === 0) return;
    const now = Date.now();
    const batch = Array.from(this.pending.values());

    for (const cand of batch) {
      if (!this.running) return;
      if (now - cand.addedAt > MAX_AGE_MS) {
        this.pending.delete(cand.item.contract.toLowerCase());
        continue;
      }
      const verifiedName = await this.checkVerified(cand.item.contract);
      if (verifiedName) {
        const key = cand.item.contract.toLowerCase();
        this.pending.delete(key);
        this.seenVerified.add(key);
        const enriched: LiveFeedItem = {
          ...cand.item,
          // Prefer the verified contract name when our metadata fetch came up empty.
          name: cand.item.name ?? verifiedName,
          verifiedAt: Math.floor(Date.now() / 1000)
        };
        this.emit('verified', enriched);
      }
      await new Promise((r) => setTimeout(r, PER_REQUEST_DELAY_MS));
    }
  }

  private async checkVerified(contract: string): Promise<string | null> {
    try {
      const url = `https://api.etherscan.io/v2/api?chainid=1&module=contract&action=getsourcecode&address=${contract}&apikey=${this.etherscanKey}`;
      const res = await fetch(url);
      if (!res.ok) {
        console.log(`[verifiedfeed] http ${res.status} for ${contract}`);
        return null;
      }
      const json = (await res.json()) as EtherscanSourceResult;
      const entry = json.result?.[0];
      if (!entry) return null;
      const name = (entry.ContractName ?? '').trim();
      const source = entry.SourceCode ?? '';
      if (name && source) {
        console.log(`[verifiedfeed] VERIFIED ${contract} (${name})`);
        return name;
      }
      return null;
    } catch (e) {
      console.log(`[verifiedfeed] error checking ${contract}: ${(e as Error).message}`);
      return null;
    }
  }
}
