import React, { useState } from 'react';
import type { BundleAnalysis, Chain, SniperAnalysis } from '../../shared/types';

interface Props {
  chain: Chain;
  contract: string;
}

type Result = { sniper: SniperAnalysis; bundle: BundleAnalysis };

export default function LaunchAnalysisPanel({ chain, contract }: Props) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [data, setData] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setState('loading');
    setErr(null);
    try {
      const res = await window.api.analyzeLaunch(chain, contract);
      setData(res);
      setState('done');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setState('error');
    }
  }

  if (state === 'idle') {
    return (
      <button
        onClick={run}
        className="text-xs px-3 py-1.5 rounded border border-violet-700 text-violet-300 hover:border-violet-500 hover:bg-violet-500/10"
        title="Scan the first buyers for snipers and coordinated funding"
      >
        🎯 Analyze launch (snipers &amp; bundles)
      </button>
    );
  }

  if (state === 'loading') {
    return <div className="text-xs text-slate-400">Analyzing the opening buys…</div>;
  }

  if (state === 'error') {
    return (
      <div className="rounded border border-red-800 bg-red-900/20 px-3 py-2 text-xs text-red-300">
        Launch analysis failed: {err}
      </div>
    );
  }

  if (!data) return null;
  const { sniper, bundle } = data;

  const sniperSeverity =
    sniper.sniperSupplyPct === null ? 'slate'
    : sniper.sniperSupplyPct >= 50 ? 'red'
    : sniper.sniperSupplyPct >= 25 ? 'amber'
    : 'emerald';
  const bundleSeverity = bundle.clusters.length > 0 ? 'red' : 'emerald';

  return (
    <div className="rounded border border-slate-800 bg-slate-900/40 p-3 space-y-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-slate-100">🎯 Launch analysis</span>
        <span className="text-slate-500">first {sniper.totalEarly} buys</span>
      </div>

      {/* Sniper concentration */}
      <div className={`rounded border px-3 py-2 ${borderFor(sniperSeverity)}`}>
        <div className="flex items-center justify-between">
          <span className="text-slate-200 font-medium">Sniper concentration</span>
          <span className={textFor(sniperSeverity)}>
            {sniper.sniperSupplyPct === null ? '—' : `${sniper.sniperSupplyPct.toFixed(0)}% of open volume`}
          </span>
        </div>
        <div className="text-slate-400 mt-1">{sniper.note}</div>
        <div className="text-slate-500 mt-1 flex gap-3">
          <span>{sniper.sniperCount} sniper wallets</span>
          {sniper.freshSniperCount > 0 && <span>· {sniper.freshSniperCount} freshly funded</span>}
          <span>· window {sniper.windowSeconds}s</span>
        </div>
      </div>

      {/* Bundle / shared funder */}
      <div className={`rounded border px-3 py-2 ${borderFor(bundleSeverity)}`}>
        <div className="flex items-center justify-between">
          <span className="text-slate-200 font-medium">Shared-funder clusters</span>
          <span className={textFor(bundleSeverity)}>
            {bundle.clusters.length === 0 ? 'none' : `${bundle.clusters.length} cluster(s)`}
          </span>
        </div>
        <div className="text-slate-400 mt-1">{bundle.note}</div>
        {bundle.clusters.length > 0 && (
          <ul className="mt-2 space-y-1">
            {bundle.clusters.slice(0, 5).map((c) => (
              <li key={c.funder} className="flex items-center gap-2">
                <span className="text-red-300">{c.wallets.length} wallets</span>
                <span className="text-slate-500">←</span>
                <span className="mono text-slate-400">{c.funderLabel ?? short(c.funder)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="text-slate-600 mt-1">{bundle.checked} early wallets checked</div>
      </div>
    </div>
  );
}

function borderFor(sev: string): string {
  if (sev === 'red') return 'border-red-800 bg-red-900/20';
  if (sev === 'amber') return 'border-amber-800 bg-amber-900/20';
  if (sev === 'emerald') return 'border-emerald-900 bg-emerald-900/10';
  return 'border-slate-800';
}
function textFor(sev: string): string {
  if (sev === 'red') return 'text-red-300';
  if (sev === 'amber') return 'text-amber-300';
  if (sev === 'emerald') return 'text-emerald-300';
  return 'text-slate-400';
}
function short(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
