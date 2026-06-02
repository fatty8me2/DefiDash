import React, { useEffect, useRef, useState } from 'react';
import type { TrendingList, TrendingToken } from '../../shared/types';
import CopyButton from './CopyButton';

interface Props {
  onClickContract?: (contract: string) => void;
  refreshSec?: number;
  maxFdvUsd?: number;   // 0 = no cap
  minLiqUsd?: number;   // 0 = no floor
}

const TABS: { key: TrendingList; label: string }[] = [
  { key: 'trending', label: '🔥 Trending' },
  { key: 'new', label: '🆕 New' },
  { key: 'volume', label: '📊 Volume' }
];

export default function TrendingPanel({ onClickContract, refreshSec = 30, maxFdvUsd = 0, minLiqUsd = 0 }: Props) {
  const [tab, setTab] = useState<TrendingList>('trending');
  const [rows, setRows] = useState<TrendingToken[]>([]);
  const [status, setStatus] = useState<'loading' | 'live' | 'error'>('loading');
  const tabRef = useRef(tab);
  tabRef.current = tab;

  const refreshMs = Math.max(10, Math.min(300, refreshSec)) * 1000;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const which = tabRef.current;
      try {
        const data = await window.api.getTrending(which);
        if (cancelled || tabRef.current !== which) return;
        setRows(data);
        setStatus('live');
      } catch {
        if (cancelled) return;
        setStatus('error');
      }
    }

    setStatus('loading');
    setRows([]);
    load();
    const id = setInterval(load, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tab, refreshMs]);

  // Apply the low-cap filter from settings.
  const filtered = rows.filter((t) => {
    if (maxFdvUsd > 0 && t.fdvUsd !== null && t.fdvUsd > maxFdvUsd) return false;
    if (minLiqUsd > 0 && (t.liquidityUsd === null || t.liquidityUsd < minLiqUsd)) return false;
    return true;
  });

  const dotColor =
    status === 'live' ? 'bg-violet-400' : status === 'loading' ? 'bg-amber-400' : 'bg-red-500';

  return (
    <div className="rounded border border-slate-800 bg-slate-900/40 flex flex-col" style={{ height: 280 }}>
      <div className="px-3 py-2 border-b border-slate-800">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-slate-100">Hot Tokens · ETH</div>
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-400">
            <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
            {status}
          </div>
        </div>
        <div className="mt-1.5 flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-1.5 py-0.5 rounded text-[10px] border ${
                tab === t.key
                  ? 'border-violet-500 text-violet-300 bg-violet-500/10'
                  : 'border-slate-700 text-slate-400 hover:border-slate-500'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="text-xs text-slate-500 px-3 py-6 text-center">
            {status === 'error'
              ? 'Could not load — retrying…'
              : status === 'loading'
                ? 'Loading…'
                : rows.length > 0
                  ? 'No tokens match your low-cap filter.'
                  : 'No tokens right now.'}
          </div>
        ) : (
          <ul className="divide-y divide-slate-800/60">
            {filtered.map((t) => (
              <TrendingRow key={t.pairAddress || t.contract} t={t} onClickContract={onClickContract} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TrendingRow({
  t,
  onClickContract
}: {
  t: TrendingToken;
  onClickContract?: (contract: string) => void;
}) {
  const chg = t.priceChangeH24;
  const chgColor = chg === null ? 'text-slate-500' : chg >= 0 ? 'text-emerald-400' : 'text-red-400';

  return (
    <li
      className="px-3 py-1.5 text-xs hover:bg-slate-800/40 cursor-pointer"
      onClick={() => onClickContract?.(t.contract)}
      title={`${t.pairLabel ?? t.symbol ?? ''}\nClick to analyze buyers`}
    >
      <div className="flex items-center gap-2">
        <span className="text-slate-200 font-medium truncate max-w-[38%]">{t.symbol ?? '…'}</span>
        <CopyButton value={t.contract} />
        <span className={`ml-auto ${chgColor}`}>{fmtPct(chg)}</span>
      </div>
      <div className="flex items-center gap-2 mt-0.5 text-[10px] text-slate-500">
        <span title="24h volume">V {fmtUsd(t.volumeH24Usd)}</span>
        <span title="liquidity">L {fmtUsd(t.liquidityUsd)}</span>
        {t.fdvUsd !== null && <span title="fully diluted valuation">FDV {fmtUsd(t.fdvUsd)}</span>}
        {(t.buysH24 !== null || t.sellsH24 !== null) && (
          <span className="ml-auto">
            <span className="text-emerald-500">{t.buysH24 ?? 0}b</span>
            <span className="text-slate-600">/</span>
            <span className="text-red-400">{t.sellsH24 ?? 0}s</span>
          </span>
        )}
      </div>
    </li>
  );
}

function fmtPct(v: number | null): string {
  if (v === null) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(v >= 100 || v <= -100 ? 0 : 1)}%`;
}

function fmtUsd(v: number | null): string {
  if (v === null) return '—';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}
