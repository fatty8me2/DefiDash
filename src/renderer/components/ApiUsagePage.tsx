import React, { useEffect, useState } from 'react';
import type { ApiProviderUsage, ApiUsageSnapshot, ApiUsageWindow } from '../../shared/types';

// "API Usage" tab — how much of each provider's rate/quota this app has consumed.
// Counts are local (this app's own requests); see src/main/apiUsage.ts.
const POLL_MS = 2000;

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })}M`;
  if (n >= 10_000) return `${(n / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}k`;
  return n.toLocaleString();
}

export default function ApiUsagePage() {
  const [snap, setSnap] = useState<ApiUsageSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => window.api.apiUsage().then((s) => { if (!cancelled) setSnap(s); }).catch(() => undefined);
    load();
    const iv = window.setInterval(load, POLL_MS);
    return () => { cancelled = true; window.clearInterval(iv); };
  }, []);

  if (!snap) {
    return <div className="text-sm text-slate-500">Loading usage…</div>;
  }

  const keyed = snap.providers.filter((p) => p.keyed);
  const keyless = snap.providers.filter((p) => !p.keyed);

  return (
    <div className="max-w-4xl space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-slate-100">API Usage</h2>
        <p className="text-xs text-slate-500 mt-1 max-w-2xl">
          Requests this app has made to each provider, counted locally. Day/month totals reset on{' '}
          <span className="text-slate-400">{snap.resetDay}</span> /{' '}
          <span className="text-slate-400">{snap.resetMonth}</span> rollover. Providers meter in credits or
          compute-units that vary per endpoint, so monthly bars are a rough proxy, not your exact bill.
        </p>
      </div>

      <Section title="Keyed providers">
        {keyed.map((p) => <ProviderCard key={p.id} p={p} />)}
      </Section>

      <Section title="Keyless providers">
        {keyless.map((p) => <ProviderCard key={p.id} p={p} />)}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase tracking-wider text-slate-500">{title}</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">{children}</div>
    </div>
  );
}

function ProviderCard({ p }: { p: ApiProviderUsage }) {
  const missingKey = p.keyed && !p.configured;
  return (
    <div className="rounded border border-slate-800 bg-slate-900/40 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-100">{p.label}</span>
          {p.keyed ? (
            missingKey ? (
              <span className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider bg-amber-900/40 text-amber-300">No key</span>
            ) : (
              <span className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider bg-emerald-900/40 text-emerald-300">Key set</span>
            )
          ) : (
            <span className="px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider bg-slate-800 text-slate-400">Keyless</span>
          )}
        </div>
        <span className="text-[11px] text-slate-500 tabular-nums">{fmt(p.total)} all-time</span>
      </div>

      <div className="space-y-2">
        <UsageBar label="This minute" w={p.minute} suffix="/min" />
        <UsageBar label="Today" w={p.day} />
        <UsageBar label="This month" w={p.month} />
      </div>

      {p.note && <p className="text-[11px] text-slate-500 leading-relaxed">{p.note}</p>}
      {p.docsUrl && (
        <a href={p.docsUrl} target="_blank" rel="noreferrer" className="inline-block text-[11px] text-emerald-400 hover:underline">
          Open provider dashboard ↗
        </a>
      )}
    </div>
  );
}

function UsageBar({ label, w, suffix }: { label: string; w: ApiUsageWindow; suffix?: string }) {
  // No documented cap → show the raw count without a bar.
  if (w.limit === null) {
    return (
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-500">{label}</span>
        <span className="text-slate-300 tabular-nums">{fmt(w.used)}{suffix ?? ''}</span>
      </div>
    );
  }
  const pct = Math.min(100, (w.used / w.limit) * 100);
  const color = pct >= 90 ? 'bg-rose-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-500">{label}</span>
        <span className="text-slate-300 tabular-nums">
          {fmt(w.used)} <span className="text-slate-600">/ {fmt(w.limit)}{suffix ?? ''} · {pct < 1 && w.used > 0 ? '<1' : Math.round(pct)}%</span>
        </span>
      </div>
      <div className="h-1.5 rounded bg-slate-800 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
