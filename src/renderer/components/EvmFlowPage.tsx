import React, { useEffect, useMemo, useState } from 'react';
import type { EvmFlowChain, EvmFlowSnapshot, EvmFlowToken, FlowTab } from '../../shared/types';
import CopyButton from './CopyButton';
import DexScreenerButton from './DexScreenerButton';

interface Props {
  hasBitqueryToken: boolean;
  onClickContract: (address: string) => void; // ETH-mainnet buyer lookup
  onOpenSettings: () => void;
}

const TABS: { key: FlowTab; label: string; hint: string }[] = [
  { key: 'top', label: 'Top', hint: 'Highest net ETH inflow (15m)' },
  { key: 'early', label: 'Early', hint: 'Most recently active tokens' },
  { key: 'dipping', label: 'Dipping', hint: 'Largest net ETH outflow (15m)' }
];

const CHAINS: { key: EvmFlowChain; label: string }[] = [
  { key: 'ethereum', label: 'Ethereum' },
  { key: 'base', label: 'Base' }
];

const PAGE_SIZE = 24;

export default function EvmFlowPage({ hasBitqueryToken, onClickContract, onOpenSettings }: Props) {
  const [chain, setChain] = useState<EvmFlowChain>('ethereum');
  const [tab, setTab] = useState<FlowTab>('top');
  const [snap, setSnap] = useState<EvmFlowSnapshot | null>(null);
  const [status, setStatus] = useState<string>('idle');

  useEffect(() => {
    if (!hasBitqueryToken) return;
    setSnap(null); // clear stale data when switching chains
    window.api.startEvmFlow(chain);
    const offUpdate = window.api.onEvmFlowUpdate((s) => {
      // Ignore late snapshots from the previous chain after a toggle.
      if (s.chain === chain) setSnap(s);
    });
    const offStatus = window.api.onEvmFlowStatus(setStatus);
    return () => {
      offUpdate();
      offStatus();
      window.api.stopEvmFlow();
    };
  }, [hasBitqueryToken, chain]);

  const rows = useMemo(() => sortForTab(snap?.tokens ?? [], tab).slice(0, PAGE_SIZE), [snap, tab]);

  if (!hasBitqueryToken) {
    return (
      <div className="max-w-2xl mx-auto mt-12 border border-slate-800 rounded-lg p-6 bg-slate-900/40">
        <h2 className="text-lg font-semibold text-slate-100">ETH Flow needs a Bitquery token</h2>
        <p className="text-sm text-slate-300 mt-2">
          This page streams live Uniswap V2 trades on Ethereum and Base, ranking tokens by net ETH
          inflow over the last 15 minutes. It uses the same Bitquery token as the Pump Flow page.
        </p>
        <p className="text-sm text-slate-300 mt-4">
          Paste an OAuth access token (starts with <span className="mono">ory_at_…</span>) into{' '}
          <button onClick={onOpenSettings} className="underline text-emerald-400 hover:text-emerald-300">Settings</button> → Bitquery Token.
        </p>
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
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Uniswap V2 Live</span>
          <div className="flex gap-1">
            {CHAINS.map((c) => (
              <button
                key={c.key}
                onClick={() => setChain(c.key)}
                className={`px-2.5 py-1 rounded text-xs border ${
                  chain === c.key
                    ? 'border-sky-500 text-sky-300 bg-sky-500/10'
                    : 'border-slate-700 text-slate-400 hover:border-slate-500'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
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
          {snap && <span className="text-slate-600 normal-case tracking-normal ml-1">· {snap.tokens.length} tokens</span>}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="text-sm text-slate-500 border border-slate-800 rounded px-4 py-10 text-center">
          {status === 'error'
            ? 'Stream error — check your Bitquery token in Settings. Retrying…'
            : chain === 'base'
              ? 'Waiting for Uniswap V2 trades on Base… (V2 is quiet on Base — try Ethereum for more activity.)'
              : 'Waiting for the first Uniswap V2 trades to roll in…'}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {rows.map((t) => (
            <FlowCard key={t.address} t={t} chain={chain} onClick={() => onClickContract(t.address)} />
          ))}
        </div>
      )}
    </div>
  );
}

function sortForTab(tokens: EvmFlowToken[], tab: FlowTab): EvmFlowToken[] {
  const copy = [...tokens];
  switch (tab) {
    case 'top':
      return copy.sort((a, b) => b.netInflowEth - a.netInflowEth);
    case 'dipping':
      return copy.sort((a, b) => a.netInflowEth - b.netInflowEth);
    case 'early':
      return copy.sort((a, b) => b.firstSeen - a.firstSeen);
  }
}

function FlowCard({ t, chain, onClick }: { t: EvmFlowToken; chain: EvmFlowChain; onClick: () => void }) {
  const positive = t.netInflowEth >= 0;
  const total = t.buyVolEth + t.sellVolEth;
  const buyPct = total > 0 ? (t.buyVolEth / total) * 100 : 50;

  // On Ethereum a click runs the buyer lookup; on Base (no mainnet lookup) it
  // opens DexScreener instead.
  function handleClick() {
    if (chain === 'ethereum') {
      onClick();
    } else {
      window.open(`https://dexscreener.com/base/${t.address}`, '_blank', 'noopener,noreferrer');
    }
  }
  const clickHint = chain === 'ethereum'
    ? 'Click to look up the buyers for this token'
    : 'Click to open this token on DexScreener';

  return (
    <div
      onClick={handleClick}
      title={clickHint}
      className={`rounded border bg-slate-900/40 p-3 cursor-pointer transition-colors ${
        positive ? 'border-emerald-900/60 hover:border-emerald-600' : 'border-red-900/60 hover:border-red-600'
      }`}
    >
      <div className="flex items-center gap-2">
        <LetterAvatar address={t.address} symbol={t.symbol} />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-100 truncate">{t.symbol ?? '???'}</div>
          <div className="text-[11px] text-slate-500 truncate">{t.name ?? '—'}</div>
        </div>
        <div className="ml-auto flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <DexScreenerButton address={t.address} chain={chain} title="Open on DexScreener" />
          <CopyButton value={t.address} title="Copy token address" />
        </div>
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <span className={`text-xl font-semibold ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
          {positive ? '+' : ''}{fmtEth(t.netInflowEth)}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-slate-500">Ξ Net Inflow · 15m</span>
      </div>

      <Sparkline data={t.spark} positive={positive} />

      <div className="mt-2 flex items-center gap-2 text-[11px]">
        <span className="text-emerald-400">▲ {fmtEth(t.buyVolEth)}</span>
        <div className="flex-1 h-1 rounded-full bg-red-500/40 overflow-hidden">
          <div className="h-full bg-emerald-500" style={{ width: `${buyPct}%` }} />
        </div>
        <span className="text-red-400">{fmtEth(t.sellVolEth)} ▼</span>
      </div>

      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
        <span>{t.txCount} tx</span>
        <span>{fmtPriceUsd(t.priceUsd)}</span>
        <span>age {ageStr(t.firstSeen)}</span>
      </div>
      <div className="mt-1 mono text-[10px] text-slate-600 truncate">{shortAddr(t.address)}</div>
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

// EVM tokens have no standard on-chain metadata URI, so we render a colored
// letter avatar (no network fetch, avoids CORS).
function LetterAvatar({ address, symbol }: { address: string; symbol: string | null }) {
  const letter = (symbol ?? address.slice(2)).slice(0, 1).toUpperCase();
  const hue = hashHue(address);
  return (
    <div
      className="w-7 h-7 rounded shrink-0 flex items-center justify-center text-[11px] font-semibold text-white"
      style={{ backgroundColor: `hsl(${hue} 45% 35%)` }}
    >
      {letter}
    </div>
  );
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

function fmtEth(n: number): string {
  const v = Math.abs(n);
  if (v >= 1000) return (n / 1000).toFixed(2) + 'K';
  if (v >= 1) return n.toFixed(2);
  if (v >= 0.001) return n.toFixed(3);
  return n.toFixed(4);
}

function fmtPriceUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  // Very small prices: show the first significant digits.
  return `$${n.toPrecision(2)}`;
}

function ageStr(firstSeenSec: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - firstSeenSec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function shortAddr(a: string): string {
  if (a.length <= 14) return a;
  return `${a.slice(0, 6)}…${a.slice(-6)}`;
}
