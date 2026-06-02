import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { FlowSnapshot, FlowTab, FlowToken } from '../../shared/types';
import CopyButton from './CopyButton';

interface Props {
  hasBitqueryToken: boolean;
  onClickContract: (mint: string) => void;
  onOpenSettings: () => void;
}

const TABS: { key: FlowTab; label: string; hint: string }[] = [
  { key: 'top', label: 'Top', hint: 'Highest net SOL inflow (15m)' },
  { key: 'early', label: 'Early', hint: 'Most recently active mints' },
  { key: 'dipping', label: 'Dipping', hint: 'Largest net SOL outflow (15m)' }
];

const PAGE_SIZE = 24;

export default function PumpFlowPage({ hasBitqueryToken, onClickContract, onOpenSettings }: Props) {
  const [tab, setTab] = useState<FlowTab>('top');
  const [snap, setSnap] = useState<FlowSnapshot | null>(null);
  const [status, setStatus] = useState<string>('idle');

  useEffect(() => {
    if (!hasBitqueryToken) return;
    window.api.startFlow();
    const offUpdate = window.api.onFlowUpdate(setSnap);
    const offStatus = window.api.onFlowStatus(setStatus);
    return () => {
      offUpdate();
      offStatus();
      window.api.stopFlow();
    };
  }, [hasBitqueryToken]);

  const rows = useMemo(() => sortForTab(snap?.tokens ?? [], tab).slice(0, PAGE_SIZE), [snap, tab]);

  if (!hasBitqueryToken) {
    return (
      <div className="max-w-2xl mx-auto mt-12 border border-slate-800 rounded-lg p-6 bg-slate-900/40">
        <h2 className="text-lg font-semibold text-slate-100">Pump Flow needs a Bitquery token</h2>
        <p className="text-sm text-slate-300 mt-2">
          This page streams live pump.fun trades and ranks tokens by net SOL inflow over the last 15 minutes.
          It uses Bitquery's real-time API.
        </p>
        <ol className="text-sm text-slate-300 mt-4 space-y-2 list-decimal pl-5">
          <li>
            Make a free account at{' '}
            <a className="text-emerald-400 hover:underline" href="https://account.bitquery.io" target="_blank" rel="noreferrer">account.bitquery.io</a>.
          </li>
          <li>
            Create an OAuth <span className="text-slate-200">access token</span> (starts with <span className="mono">ory_at_…</span>).
          </li>
          <li>
            Paste it into{' '}
            <button onClick={onOpenSettings} className="underline text-emerald-400 hover:text-emerald-300">Settings</button> → Bitquery Token.
          </li>
        </ol>
        <p className="text-xs text-slate-500 mt-4">
          Heads-up: the live stream draws from your monthly Bitquery quota, so this page only streams while it's open.
        </p>
      </div>
    );
  }

  const dotColor =
    status === 'connected' ? 'bg-emerald-400'
    : status === 'connecting' || status === 'disconnected' ? 'bg-amber-400'
    : status === 'no-key' ? 'bg-slate-600'
    : status === 'error' ? 'bg-red-500'
    : 'bg-slate-500';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Pump.fun Live</span>
          <div className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                title={t.hint}
                onClick={() => setTab(t.key)}
                className={`px-2.5 py-1 rounded text-xs border ${
                  tab === t.key
                    ? 'border-emerald-500 text-emerald-300 bg-emerald-500/10'
                    : 'border-slate-700 text-slate-400 hover:border-slate-500'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-400">
          <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
          {status === 'connected' ? 'live' : status}
          {snap && <span className="text-slate-600 normal-case tracking-normal ml-1">· {snap.tokens.length} mints</span>}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="text-sm text-slate-500 border border-slate-800 rounded px-4 py-10 text-center">
          {status === 'error'
            ? 'Stream error — check your Bitquery token in Settings. Retrying…'
            : 'Waiting for the first trades to roll in…'}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {rows.map((t) => (
            <FlowCard key={t.mint} t={t} onClick={() => onClickContract(t.mint)} />
          ))}
        </div>
      )}
    </div>
  );
}

function sortForTab(tokens: FlowToken[], tab: FlowTab): FlowToken[] {
  const copy = [...tokens];
  switch (tab) {
    case 'top':
      return copy.sort((a, b) => b.netInflowSol - a.netInflowSol);
    case 'dipping':
      return copy.sort((a, b) => a.netInflowSol - b.netInflowSol);
    case 'early':
      return copy.sort((a, b) => b.firstSeen - a.firstSeen);
  }
}

function FlowCard({ t, onClick }: { t: FlowToken; onClick: () => void }) {
  const positive = t.netInflowSol >= 0;
  const total = t.buyVolSol + t.sellVolSol;
  const buyPct = total > 0 ? (t.buyVolSol / total) * 100 : 50;

  return (
    <div
      onClick={onClick}
      title="Click to look up the buyers for this token"
      className={`rounded border bg-slate-900/40 p-3 cursor-pointer transition-colors ${
        positive ? 'border-emerald-900/60 hover:border-emerald-600' : 'border-red-900/60 hover:border-red-600'
      }`}
    >
      <div className="flex items-center gap-2">
        <TokenIcon mint={t.mint} uri={t.uri} symbol={t.symbol} />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-100 truncate">{t.symbol ?? '???'}</div>
          <div className="text-[11px] text-slate-500 truncate">{t.name ?? '—'}</div>
        </div>
        <div className="ml-auto" onClick={(e) => e.stopPropagation()}>
          <CopyButton value={t.mint} title="Copy mint address" />
        </div>
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className={`text-xl font-semibold ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
          {positive ? '+' : ''}{fmtSol(t.netInflowSol)}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-slate-500">◎ Net Inflow · 15m</span>
      </div>

      <Sparkline data={t.spark} positive={positive} />

      <div className="mt-2 flex items-center gap-2 text-[11px]">
        <span className="text-emerald-400">▲ {fmtSol(t.buyVolSol)}</span>
        <div className="flex-1 h-1 rounded-full bg-red-500/40 overflow-hidden">
          <div className="h-full bg-emerald-500" style={{ width: `${buyPct}%` }} />
        </div>
        <span className="text-red-400">{fmtSol(t.sellVolSol)} ▼</span>
      </div>

      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
        <span>{t.txCount} tx</span>
        <span>mc {fmtUsd(t.marketCapUsd)}</span>
        <span>age {ageStr(t.firstSeen)}</span>
      </div>
      <div className="mt-1 mono text-[10px] text-slate-600 truncate">{shortMint(t.mint)}</div>
    </div>
  );
}

function Sparkline({ data, positive }: { data: number[]; positive: boolean }) {
  const W = 240;
  const H = 44;
  if (!data || data.length < 2) {
    return <div style={{ height: H }} className="mt-1" />;
  }
  const min = Math.min(...data, 0);
  const max = Math.max(...data, 0);
  const range = max - min || 1;
  const stepX = W / (data.length - 1);
  const y = (v: number) => H - ((v - min) / range) * (H - 4) - 2;
  const pts = data.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`);
  const line = `M${pts.join(' L')}`;
  const area = `${line} L${W},${H} L0,${H} Z`;
  const stroke = positive ? '#34d399' : '#f87171';
  const fill = positive ? 'rgba(52,211,153,0.12)' : 'rgba(248,113,113,0.12)';
  const zeroY = y(0);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-1 w-full" style={{ height: H }}>
      <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke="#334155" strokeWidth={0.5} strokeDasharray="2,3" />
      <path d={area} fill={fill} />
      <path d={line} fill="none" stroke={stroke} strokeWidth={1.5} />
    </svg>
  );
}

// Lazy token icon: resolves the metadata URI → image once, caches, falls back to a letter avatar.
const iconCache = new Map<string, string | null>();

function TokenIcon({ mint, uri, symbol }: { mint: string; uri: string | null; symbol: string | null }) {
  const [src, setSrc] = useState<string | null>(() => iconCache.get(mint) ?? null);
  const tried = useRef(false);

  useEffect(() => {
    if (src || tried.current || !uri) return;
    tried.current = true;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(toHttp(uri));
        if (!res.ok) throw new Error('meta');
        const json = await res.json();
        const img = typeof json?.image === 'string' ? toHttp(json.image) : null;
        if (!cancelled && img) {
          iconCache.set(mint, img);
          setSrc(img);
        } else if (!cancelled) {
          iconCache.set(mint, null);
        }
      } catch {
        if (!cancelled) iconCache.set(mint, null);
      }
    })();
    return () => { cancelled = true; };
  }, [mint, uri, src]);

  if (src) {
    return <img src={src} alt="" className="w-7 h-7 rounded shrink-0 object-cover bg-slate-800" />;
  }
  const letter = (symbol ?? mint).slice(0, 1).toUpperCase();
  const hue = hashHue(mint);
  return (
    <div
      className="w-7 h-7 rounded shrink-0 flex items-center justify-center text-[11px] font-semibold text-white"
      style={{ backgroundColor: `hsl(${hue} 45% 35%)` }}
    >
      {letter}
    </div>
  );
}

function toHttp(uri: string): string {
  if (uri.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length)}`;
  return uri;
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function fmtSol(n: number): string {
  const v = Math.abs(n);
  if (v >= 1000) return (n / 1000).toFixed(2) + 'K';
  if (v >= 1) return n.toFixed(2);
  return n.toFixed(3);
}

function fmtUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function ageStr(firstSeenSec: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - firstSeenSec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function shortMint(a: string): string {
  if (a.length <= 14) return a;
  return `${a.slice(0, 6)}…${a.slice(-6)}`;
}
