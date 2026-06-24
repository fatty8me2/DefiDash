// Local API-usage meter. Wraps the main-process global `fetch` once and buckets
// every outbound call by hostname → provider, so the "API Usage" page can show
// how much of each provider's rate/quota this app has consumed.
//
// Counts are LOCAL: we tally the requests this app makes (never the URLs — those
// can carry API keys), within the app's own rolling windows. Providers meter in
// credits / compute-units that differ per endpoint, so the monthly bars are a
// rough proxy, not a billing-accurate figure. Day/month counters persist to
// userData/apiUsage.json and reset on date/month rollover.
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { ApiProviderUsage, ApiUsageSnapshot } from '../shared/types';

type KeyName = 'alchemyKey' | 'heliusKey' | 'etherscanKey' | 'cieloKey';

interface ProviderDef {
  id: string;
  label: string;
  keyName?: KeyName;        // present ⇒ this provider needs an API key
  hosts: string[];          // hostname suffixes (exact or *.suffix) → this provider
  perMinute?: number;       // soft rate cap (req/min) for the live bar
  perDay?: number;
  perMonth?: number;
  note?: string;
  docsUrl?: string;
}

// Keyed providers first (their quotas matter most), then keyless ones. Limits are
// documented free-tier figures as of this writing — see each `note`.
const PROVIDERS: ProviderDef[] = [
  {
    id: 'alchemy',
    label: 'Alchemy',
    keyName: 'alchemyKey',
    hosts: ['alchemy.com'],
    perMinute: 1500, // ~25 req/s throughput
    perMonth: 300_000_000,
    note: 'Free tier ≈300M compute units/month, ~25 req/s. 1 request = a variable number of CUs (eth_getLogs is heavy), so the monthly bar is a rough proxy.',
    docsUrl: 'https://dashboard.alchemy.com'
  },
  {
    id: 'helius',
    label: 'Helius',
    keyName: 'heliusKey',
    hosts: ['helius.xyz', 'helius-rpc.com'],
    perMinute: 600, // ~10 req/s
    perMonth: 1_000_000,
    note: 'Free tier ≈1M credits/month, ~10 req/s. Most calls cost ≈1 credit, so requests ≈ credits.',
    docsUrl: 'https://dashboard.helius.dev'
  },
  {
    id: 'etherscan',
    label: 'Etherscan',
    keyName: 'etherscanKey',
    hosts: ['etherscan.io'],
    perMinute: 300, // 5 req/s
    perDay: 100_000,
    note: 'Free tier: 5 req/s, 100k requests/day.',
    docsUrl: 'https://etherscan.io/myapikey'
  },
  {
    id: 'cielo',
    label: 'Cielo',
    keyName: 'cieloKey',
    hosts: ['cielo.finance'],
    note: 'Rate limits depend on your Cielo plan.',
    docsUrl: 'https://cielo.finance'
  },
  // Keyless providers (no API key — public rate limits only).
  {
    id: 'dexscreener',
    label: 'DexScreener',
    hosts: ['dexscreener.com'],
    perMinute: 300,
    note: 'Keyless. Token endpoints allow ≈300 requests/min.'
  },
  {
    id: 'jupiter',
    label: 'Jupiter',
    hosts: ['jup.ag'],
    perMinute: 60,
    note: 'Keyless lite/main swap API; rate-limits aggressively on bursts.'
  },
  {
    id: 'pumpportal',
    label: 'PumpPortal',
    hosts: ['pumpportal.fun'],
    note: 'Keyless pump.fun trade builder (fallback path).'
  },
  {
    id: 'coingecko',
    label: 'CoinGecko',
    hosts: ['coingecko.com'],
    perMinute: 30,
    note: 'Public API ≈10–30 calls/min, no key.'
  },
  {
    id: 'geckoterminal',
    label: 'GeckoTerminal',
    hosts: ['geckoterminal.com'],
    perMinute: 30,
    note: 'Public API ≈30 calls/min, no key.'
  },
  {
    id: 'goplus',
    label: 'GoPlus (honeypot)',
    hosts: ['gopluslabs.io'],
    perMinute: 30,
    note: 'Public security API, no key.'
  },
  {
    id: 'solana-rpc',
    label: 'Solana public RPC',
    hosts: ['api.mainnet-beta.solana.com'],
    note: 'Public mainnet-beta RPC (heavily rate-limited; a fallback).'
  },
  {
    id: 'firebase',
    label: 'Firebase (Dale sync)',
    hosts: ['firebaseio.com', 'firebasedatabase.app'],
    note: 'Shared Dale charts ledger. The live stream is one long-lived connection; adds/removes are individual writes. Free tier: 100 simultaneous connections, 10GB/mo download.'
  }
];

interface Counts { total: number; day: number; month: number; }

const counts: Record<string, Counts> = {};
const recent: Record<string, number[]> = {}; // request timestamps (ms) within the last minute
let resetDay = dayKey();
let resetMonth = monthKey();
let loaded = false;
let saveTimer: NodeJS.Timeout | null = null;

function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function blank(): Counts { return { total: 0, day: 0, month: 0 }; }

function storePath(): string {
  return path.join(app.getPath('userData'), 'apiUsage.json');
}

function load(): void {
  if (loaded) return;
  loaded = true;
  for (const p of PROVIDERS) { counts[p.id] = blank(); recent[p.id] = []; }
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const data = JSON.parse(raw) as { resetDay?: string; resetMonth?: string; counts?: Record<string, Counts> };
    resetDay = data.resetDay ?? resetDay;
    resetMonth = data.resetMonth ?? resetMonth;
    for (const p of PROVIDERS) {
      const c = data.counts?.[p.id];
      if (c) counts[p.id] = { total: c.total ?? 0, day: c.day ?? 0, month: c.month ?? 0 };
    }
  } catch {
    // first run / unreadable — start fresh
  }
  rollover();
}

// Reset day/month counters when the calendar day or month changes.
function rollover(): void {
  const d = dayKey();
  const m = monthKey();
  if (d !== resetDay) {
    resetDay = d;
    for (const id of Object.keys(counts)) counts[id].day = 0;
  }
  if (m !== resetMonth) {
    resetMonth = m;
    for (const id of Object.keys(counts)) counts[id].month = 0;
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(storePath(), JSON.stringify({ resetDay, resetMonth, counts }));
    } catch {
      // non-fatal — counts stay in memory
    }
  }, 2000);
}

function hostToProvider(hostname: string): string | null {
  const h = hostname.toLowerCase();
  for (const p of PROVIDERS) {
    for (const suffix of p.hosts) {
      if (h === suffix || h.endsWith(`.${suffix}`)) return p.id;
    }
  }
  return null;
}

function record(id: string): void {
  load();
  rollover();
  const c = counts[id];
  c.total += 1; c.day += 1; c.month += 1;
  const now = Date.now();
  const r = recent[id];
  r.push(now);
  // trim to the last 60s
  const cutoff = now - 60_000;
  while (r.length && r[0] < cutoff) r.shift();
  scheduleSave();
}

// Snapshot for the renderer. `keys` reports which API keys are configured so the
// page can flag a keyed provider that's enabled but missing its key.
export function snapshot(keys: Partial<Record<KeyName, string | undefined>>): ApiUsageSnapshot {
  load();
  rollover();
  const now = Date.now();
  const cutoff = now - 60_000;
  const providers: ApiProviderUsage[] = PROVIDERS.map((p) => {
    const c = counts[p.id] ?? blank();
    const r = recent[p.id] ?? [];
    const lastMinute = r.filter((t) => t >= cutoff).length;
    return {
      id: p.id,
      label: p.label,
      keyed: !!p.keyName,
      configured: p.keyName ? !!keys[p.keyName] : true,
      note: p.note,
      docsUrl: p.docsUrl,
      minute: { used: lastMinute, limit: p.perMinute ?? null },
      day: { used: c.day, limit: p.perDay ?? null },
      month: { used: c.month, limit: p.perMonth ?? null },
      total: c.total
    };
  });
  return { resetDay, resetMonth, providers };
}

// Wrap global fetch once so every outbound HTTP call is metered by host. Safe to
// call once at startup; failures to parse a URL just skip recording.
export function installApiUsageTracking(): void {
  const g = globalThis as unknown as { fetch?: typeof fetch };
  const orig = g.fetch;
  if (!orig) return;
  const bound = orig.bind(globalThis);
  g.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    try {
      const url =
        typeof input === 'string' ? input :
        input instanceof URL ? input.href :
        (input as Request).url;
      const id = hostToProvider(new URL(url).hostname);
      if (id) record(id);
    } catch {
      // unparseable input — don't let metering ever break a request
    }
    return bound(input, init);
  }) as typeof fetch;
}
