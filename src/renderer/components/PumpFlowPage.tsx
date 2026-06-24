import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { FlowSnapshot, FlowToken } from '../../shared/types';
import CopyButton from './CopyButton';
import DexScreenerButton from './DexScreenerButton';
import SocialLink from './SocialLink';
import { loadWatchlist, saveWatchlist } from '../lib/watchlist';
import { useWatchlistDex } from '../lib/useWatchlistDex';
import { detectWatchChain, isEthAddr } from '../lib/addr';

interface Props {
  hasHelius: boolean;
  onClickContract: (mint: string) => void;
  onBuy: (mint: string) => void;
  onOpenSettings: () => void;
}

// Ranking keys for the tab bar. The first three are the classic net-flow views;
// the rest are extra sorts requested for digging through the firehose.
type SortKey = 'top' | 'early' | 'dipping' | 'mcap' | 'velocity' | 'buys';

const TABS: { key: SortKey; label: string; hint: string }[] = [
  { key: 'top', label: 'Top', hint: 'Highest net SOL inflow (15m)' },
  { key: 'early', label: 'Early', hint: 'Most recently active mints' },
  { key: 'dipping', label: 'Dipping', hint: 'Largest net SOL outflow (15m)' },
  { key: 'mcap', label: 'Mkt Cap', hint: 'Highest market cap' },
  { key: 'velocity', label: 'Velocity', hint: 'Most trades per minute' },
  { key: 'buys', label: 'Buy Pressure', hint: 'Highest share of buy volume' }
];

const PAGE_SIZE = 24;
// pump.fun tokens graduate to Raydium when the bonding curve fills (~$69k mcap).
const GRADUATION_MCAP_USD = 69_000;

// Custom drag-data type stamped on cards dragged FROM the watchlist, so the feed
// area can tell a remove-drag apart from a normal pin-drag and act accordingly.
const WATCHLIST_REMOVE_TYPE = 'application/x-watchlist-remove';

// A stand-in FlowToken for a pinned mint we have no live data for yet (e.g. one
// restored from a previous session before its first trade arrives this session).
export function makePlaceholderToken(mint: string): FlowToken {
  const now = Math.floor(Date.now() / 1000);
  return {
    mint, symbol: null, name: null, uri: null,
    netInflowSol: 0, buyVolSol: 0, sellVolSol: 0,
    txCount: 0, buyCount: 0, sellCount: 0,
    priceUsd: null, marketCapUsd: null,
    firstSeen: now, lastTrade: now,
    spark: [], bundledPct: null, bundleWallets: 0
  };
}

// Shared sizing for the small action buttons on each tile (socials / lookup /
// copy). Bumped up from w-4 so they fill the card's corner row more comfortably.
const ACTION_BTN =
  'inline-flex items-center justify-center w-6 h-6 rounded text-sm leading-none ' +
  'text-slate-400 hover:text-emerald-400 hover:bg-slate-800/60 shrink-0';

export default function PumpFlowPage({ hasHelius, onClickContract, onBuy, onOpenSettings }: Props) {
  const [tab, setTab] = useState<SortKey>('top');
  const [snap, setSnap] = useState<FlowSnapshot | null>(null);
  const [status, setStatus] = useState<string>('idle');
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [query, setQuery] = useState('');
  const [minMc, setMinMc] = useState('');
  const [maxMc, setMaxMc] = useState('');

  // Watchlist: a user-curated set of mints pinned to the left rail so they can be
  // watched closely. Persisted across sessions. `pinnedData` keeps the last-known
  // FlowToken for each pinned mint so a card still renders (frozen) even after the
  // token drops out of the live 15-minute window.
  const [pinned, setPinned] = useState<string[]>(() => loadWatchlist());
  const [pinnedData, setPinnedData] = useState<Map<string, FlowToken>>(new Map());
  // True while a card dragged out of the watchlist is hovering the feed (drop = remove).
  const [removeOver, setRemoveOver] = useState(false);

  useEffect(() => {
    if (!hasHelius) return;
    window.api.flowAcquire();
    // Seed instantly from the background stream's current snapshot so returning
    // to this page doesn't start blank / stale.
    window.api.flowSnapshot().then((s) => { if (s && !pausedRef.current) setSnap(s); }).catch(() => undefined);
    // While paused we keep the stream running in the background but stop
    // applying snapshots, so the tiles freeze for inspection.
    const offUpdate = window.api.onFlowUpdate((s) => { if (!pausedRef.current) setSnap(s); });
    const offStatus = window.api.onFlowStatus(setStatus);
    // Release on unmount — the stream stays alive across quick navigation (grace
    // period) and auto-pauses once nothing's watching it.
    return () => {
      offUpdate();
      offStatus();
      window.api.flowRelease();
    };
  }, [hasHelius]);

  // Persist the watchlist whenever it changes.
  useEffect(() => { saveWatchlist(pinned); }, [pinned]);

  // DexScreener keeps pinned coins' price/market-cap fresh even when they're
  // outside the live pump.fun window, so the watchlist never goes stale.
  const dexData = useWatchlistDex(pinned);

  // Keep the data for pinned mints fresh: prefer live firehose data; otherwise
  // overlay current DexScreener price/mcap onto the last-known card.
  useEffect(() => {
    setPinnedData((prev) => {
      const next = new Map<string, FlowToken>();
      const byMint = new Map((snap?.tokens ?? []).map((t) => [t.mint, t]));
      for (const mint of pinned) {
        const live = byMint.get(mint);
        if (live) { next.set(mint, live); continue; }
        const base = prev.get(mint) ?? makePlaceholderToken(mint);
        const dex = dexData.get(mint);
        next.set(mint, dex ? {
          ...base,
          symbol: base.symbol ?? dex.symbol,
          name: base.name ?? dex.name,
          priceUsd: dex.priceUsd ?? base.priceUsd,
          marketCapUsd: dex.marketCapUsd ?? base.marketCapUsd,
          lastTrade: Math.floor(Date.now() / 1000)
        } : base);
      }
      return next;
    });
  }, [snap, pinned, dexData]);

  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  // A coin is "live" (not stale) if it's in the firehose window OR DexScreener
  // has fresh data for it.
  const liveMints = useMemo(
    () => new Set([...(snap?.tokens ?? []).map((t) => t.mint), ...dexData.keys()]),
    [snap, dexData]
  );

  function addPin(mint: string, seed?: FlowToken) {
    setPinned((p) => (p.includes(mint) ? p : [...p, mint]));
    const token = seed ?? snap?.tokens.find((t) => t.mint === mint);
    if (token) setPinnedData((prev) => new Map(prev).set(mint, token));
  }
  function removePin(mint: string) {
    setPinned((p) => p.filter((m) => m !== mint));
  }
  function togglePin(t: FlowToken) {
    if (pinnedSet.has(t.mint)) removePin(t.mint);
    else addPin(t.mint, t);
  }

  function togglePause() {
    setPaused((p) => { pausedRef.current = !p; return !p; });
  }

  // Spacebar toggles pause/resume while the Pump Flow page is open — unless the
  // user is typing in the search / market-cap filter inputs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      e.preventDefault();
      setPaused((p) => { pausedRef.current = !p; return !p; });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Restart the live stream from a clean slate (clears the rolling window).
  function refresh() {
    pausedRef.current = false;
    setPaused(false);
    setSnap(null);
    window.api.flowRestart();
  }

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const min = parseUsd(minMc);
    const max = parseUsd(maxMc);
    const filtered = (snap?.tokens ?? []).filter((t) => {
      if (q) {
        const hay = `${t.symbol ?? ''} ${t.name ?? ''} ${t.mint}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (min !== null && (t.marketCapUsd ?? 0) < min) return false;
      if (max !== null && (t.marketCapUsd ?? Infinity) > max) return false;
      return true;
    });
    return sortForTab(filtered, tab).slice(0, PAGE_SIZE);
  }, [snap, tab, query, minMc, maxMc]);

  const filtersActive = query.trim() !== '' || minMc.trim() !== '' || maxMc.trim() !== '';

  if (!hasHelius) {
    return (
      <div className="max-w-2xl mx-auto mt-12 border border-slate-800 rounded-lg p-6 bg-slate-900/40">
        <h2 className="text-lg font-semibold text-slate-100">Pump Flow needs a Helius key</h2>
        <p className="text-sm text-slate-300 mt-2">
          This page streams live pump.fun trades and ranks tokens by net SOL inflow over the last 15 minutes.
          It connects directly to Solana through your Helius RPC — the same key used for Solana lookups.
        </p>
        <ol className="text-sm text-slate-300 mt-4 space-y-2 list-decimal pl-5">
          <li>
            Grab a free key at{' '}
            <a className="text-emerald-400 hover:underline" href="https://dev.helius.xyz" target="_blank" rel="noreferrer">dev.helius.xyz</a>.
          </li>
          <li>
            Paste it into{' '}
            <button onClick={onOpenSettings} className="underline text-emerald-400 hover:text-emerald-300">Settings</button> → Helius Key.
          </li>
        </ol>
        <p className="text-xs text-slate-500 mt-4">
          No metered third-party API — trades are decoded on-device straight from the pump.fun program. The
          stream only runs while this page is open.
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
          <div className="flex flex-wrap gap-1">
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
          <div className="flex gap-1">
            <button
              onClick={togglePause}
              title={paused ? 'Resume live updates (spacebar)' : 'Pause live updates — freeze the tiles (spacebar)'}
              className={`px-2.5 py-1 rounded text-xs border ${
                paused
                  ? 'border-amber-500 text-amber-300 bg-amber-500/10'
                  : 'border-slate-700 text-slate-400 hover:border-slate-500'
              }`}
            >
              {paused ? '▶ Resume' : '⏸ Pause'}
            </button>
            <button
              onClick={refresh}
              title="Restart the live stream and clear the tiles"
              className="px-2.5 py-1 rounded text-xs border border-slate-700 text-slate-400 hover:border-slate-500"
            >
              ↻ Refresh
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-400">
          <span className={`w-1.5 h-1.5 rounded-full ${paused ? 'bg-amber-400' : dotColor}`} />
          {paused ? 'paused' : status === 'connected' ? 'live' : status}
          {snap && <span className="text-slate-600 normal-case tracking-normal ml-1">· {snap.tokens.length} mints</span>}
        </div>
      </div>

      <div className="flex items-center flex-wrap gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search symbol, name, or mint…"
          className="flex-1 min-w-[180px] bg-slate-950 border border-slate-700 rounded px-3 py-1.5 text-sm placeholder-slate-600 focus:outline-none focus:border-emerald-600"
        />
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <span className="uppercase tracking-wider">MC</span>
          <input
            value={minMc}
            onChange={(e) => setMinMc(e.target.value)}
            placeholder="min"
            className="mono w-20 bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm placeholder-slate-600 focus:outline-none focus:border-emerald-600"
          />
          <span className="text-slate-600">–</span>
          <input
            value={maxMc}
            onChange={(e) => setMaxMc(e.target.value)}
            placeholder="max"
            className="mono w-20 bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-sm placeholder-slate-600 focus:outline-none focus:border-emerald-600"
          />
        </div>
        {filtersActive && (
          <button
            onClick={() => { setQuery(''); setMinMc(''); setMaxMc(''); }}
            title="Clear all filters"
            className="px-2.5 py-1.5 rounded text-xs border border-slate-700 text-slate-400 hover:border-slate-500"
          >
            Clear
          </button>
        )}
      </div>

      <div className="flex items-start gap-4">
        <Watchlist
          mints={pinned}
          data={pinnedData}
          liveMints={liveMints}
          onDropMint={(m) => addPin(m)}
          onRemove={removePin}
          onClickContract={onClickContract}
          onBuy={onBuy}
        />

        <div
          className={`flex-1 min-w-0 rounded transition-colors ${removeOver ? 'ring-1 ring-red-500/50 bg-red-500/5' : ''}`}
          onDragOver={(e) => {
            // Only react to cards dragged out of the watchlist (carry the remove type).
            if (e.dataTransfer.types.includes(WATCHLIST_REMOVE_TYPE)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (!removeOver) setRemoveOver(true);
            }
          }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setRemoveOver(false); }}
          onDrop={(e) => {
            const mint = e.dataTransfer.getData(WATCHLIST_REMOVE_TYPE);
            if (mint) { e.preventDefault(); removePin(mint); }
            setRemoveOver(false);
          }}
        >
          {removeOver && (
            <div className="mb-2 rounded border border-dashed border-red-500/60 bg-red-500/5 px-3 py-2 text-center text-xs text-red-300">
              Drop here to remove from the watchlist
            </div>
          )}
          {rows.length === 0 ? (
            <div className="text-sm text-slate-500 border border-slate-800 rounded px-4 py-10 text-center">
              {status === 'error'
                ? 'Stream error — check your Helius key in Settings. Retrying…'
                : filtersActive
                  ? 'No tokens match your filters.'
                  : 'Waiting for the first trades to roll in…'}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {rows.map((t) => (
                <FlowCard
                  key={t.mint}
                  t={t}
                  onClick={() => openPhoton(t.mint)}
                  onLookup={() => onClickContract(t.mint)}
                  onBuy={() => onBuy(t.mint)}
                  draggable
                  pinned={pinnedSet.has(t.mint)}
                  onTogglePin={() => togglePin(t)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Left-rail watchlist. A drop target for cards dragged from the live grid; the
// pinned cards keep updating from each snapshot and freeze (marked "stale") if
// the token leaves the live window.
export function Watchlist({
  mints,
  data,
  liveMints,
  onDropMint,
  onRemove,
  onClickContract,
  onBuy
}: {
  mints: string[];
  data: Map<string, FlowToken>;
  liveMints: Set<string>;
  onDropMint: (mint: string) => void;
  onRemove: (mint: string) => void;
  onClickContract: (mint: string) => void;
  onBuy: (mint: string) => void;
}) {
  const [over, setOver] = useState(false);
  const [addInput, setAddInput] = useState('');
  const [addErr, setAddErr] = useState(false);

  function submitAdd() {
    const m = addInput.trim();
    if (detectWatchChain(m)) {
      onDropMint(m);
      setAddInput('');
      setAddErr(false);
    } else {
      setAddErr(true);
    }
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!over) setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const mint = e.dataTransfer.getData('text/plain');
        if (mint) onDropMint(mint);
      }}
      className={`w-72 shrink-0 self-start sticky top-2 flex flex-col max-h-[calc(100vh-140px)] rounded border transition-colors ${
        over ? 'border-emerald-500 bg-emerald-500/5' : 'border-slate-800 bg-slate-900/30'
      }`}
    >
      <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between shrink-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">★ Watchlist</span>
        <span className="text-[10px] text-slate-500">{mints.length}</span>
      </div>

      {/* Paste a mint to add it to the watchlist manually */}
      <div className="px-2 py-2 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-1.5">
          <input
            value={addInput}
            onChange={(e) => { setAddInput(e.target.value); if (addErr) setAddErr(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') submitAdd(); }}
            placeholder="Paste a mint or 0x… to add"
            spellCheck={false}
            className={`flex-1 min-w-0 bg-slate-950 border rounded px-2 py-1 text-xs font-mono text-slate-200 placeholder-slate-600 focus:outline-none ${
              addErr ? 'border-red-600' : 'border-slate-700 focus:border-emerald-600'
            }`}
          />
          <button
            onClick={submitAdd}
            disabled={!addInput.trim()}
            title="Add to watchlist"
            className="shrink-0 px-2 py-1 rounded text-xs bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40"
          >
            +
          </button>
        </div>
        {addErr && <div className="text-[10px] text-red-400 mt-1">Enter a valid Solana mint or ETH (0x…) address.</div>}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {mints.length === 0 ? (
          <div className="px-3 py-10 text-center text-xs text-slate-600">
            Drag a token card here — or paste a mint above — to pin it and watch it closely.
          </div>
        ) : (
          <div className="p-2 space-y-2">
            {mints.map((mint) => {
              const t = data.get(mint);
              if (!t) return null;
              return (
                <FlowCard
                  key={mint}
                  t={t}
                  onClick={() => openPhoton(mint)}
                  onLookup={() => onClickContract(mint)}
                  onBuy={() => onBuy(mint)}
                  draggable
                  inWatchlist
                  pinned
                  onTogglePin={() => onRemove(mint)}
                  stale={!liveMints.has(mint)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function sortForTab(tokens: FlowToken[], tab: SortKey): FlowToken[] {
  const copy = [...tokens];
  switch (tab) {
    case 'top':
      return copy.sort((a, b) => b.netInflowSol - a.netInflowSol);
    case 'dipping':
      return copy.sort((a, b) => a.netInflowSol - b.netInflowSol);
    case 'early':
      return copy.sort((a, b) => b.firstSeen - a.firstSeen);
    case 'mcap':
      return copy.sort((a, b) => (b.marketCapUsd ?? -1) - (a.marketCapUsd ?? -1));
    case 'velocity':
      return copy.sort((a, b) => txVelocity(b) - txVelocity(a));
    case 'buys':
      return copy.sort((a, b) => buyPressure(b) - buyPressure(a));
  }
}

// Trades per minute over the token's active span (capped to the 15m window).
function txVelocity(t: FlowToken): number {
  const ageMin = Math.max(1, (Date.now() / 1000 - t.firstSeen) / 60);
  return t.txCount / Math.min(ageMin, 15);
}

// Share of total volume that was buys (0..1). Ties break toward more volume.
function buyPressure(t: FlowToken): number {
  const total = t.buyVolSol + t.sellVolSol;
  return total > 0 ? t.buyVolSol / total : 0;
}

// Parse a market-cap filter input, accepting plain numbers plus k/m suffixes
// (e.g. "20k", "1.5m"). Returns null when the field is empty/invalid.
function parseUsd(s: string): number | null {
  const t = s.trim().toLowerCase().replace(/[$,\s]/g, '');
  if (!t) return null;
  const m = t.match(/^([\d.]+)(k|m)?$/);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (!Number.isFinite(v)) return null;
  if (m[2] === 'k') v *= 1_000;
  else if (m[2] === 'm') v *= 1_000_000;
  return v;
}

function FlowCard({
  t,
  onClick,
  onLookup,
  onBuy,
  draggable,
  pinned,
  onTogglePin,
  stale,
  inWatchlist
}: {
  t: FlowToken;
  onClick: () => void;
  onLookup: () => void;
  onBuy?: () => void;
  draggable?: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  stale?: boolean;
  inWatchlist?: boolean;
}) {
  const isEth = isEthAddr(t.mint);
  const positive = t.netInflowSol >= 0;
  const total = t.buyVolSol + t.sellVolSol;
  const buyPct = total > 0 ? (t.buyVolSol / total) * 100 : 50;
  const meta = useTokenMeta(t.mint, t.uri);
  const dexPaid = useDexPaid(t.mint);
  // pump.fun-specific orders endpoint is Solana-only.
  const dexUpdatedAt = useDexUpdatedAt(t.mint, dexPaid && !isEth);

  return (
    <div
      onClick={onClick}
      draggable={draggable}
      onDragStart={draggable ? (e) => {
        e.dataTransfer.setData('text/plain', t.mint);
        // Cards already in the watchlist carry a remove marker so dropping them on
        // the feed unpins them; feed cards just carry the mint (drop on rail = pin).
        if (inWatchlist) {
          e.dataTransfer.setData(WATCHLIST_REMOVE_TYPE, t.mint);
          e.dataTransfer.effectAllowed = 'move';
        } else {
          e.dataTransfer.effectAllowed = 'copy';
        }
      } : undefined}
      title={
        !draggable ? 'Click to open the chart for this token'
        : inWatchlist ? 'Drag out to remove from the watchlist · click to open the chart'
        : 'Drag to the watchlist to pin · click to open the chart'
      }
      className={`rounded border p-3 cursor-pointer transition-colors ${
        dexPaid ? 'bg-emerald-500/15' : 'bg-slate-900/40'
      } ${
        positive ? 'border-emerald-900/60 hover:border-emerald-600' : 'border-red-900/60 hover:border-red-600'
      } ${stale ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2">
        <TokenIcon mint={t.mint} image={meta?.image ?? null} symbol={t.symbol} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-base font-semibold text-slate-100 truncate">{t.symbol ?? '???'}</span>
            {dexPaid && <DexPaidBadge />}
            {dexPaid && dexUpdatedAt !== null && (
              <span
                title={`DexScreener profile updated ${ageStr(dexUpdatedAt)} ago (${new Date(dexUpdatedAt * 1000).toLocaleString()})`}
                className="text-[10px] font-medium text-emerald-300/80 tabular-nums shrink-0"
              >
                {ageStr(dexUpdatedAt)}
              </span>
            )}
            {stale && (
              <span
                title="No trades in the live window — showing last-known values"
                className="rounded bg-slate-700/50 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-400 shrink-0"
              >
                stale
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500 truncate">{t.name ?? '—'}</div>
        </div>
        <div className="ml-auto flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <CopyButton value={t.mint} title="Copy mint address" className={ACTION_BTN} />
          {onTogglePin && (
            <button
              onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
              title={pinned ? 'Remove from watchlist' : 'Add to watchlist'}
              className={`${ACTION_BTN} ${pinned ? 'text-amber-400 hover:text-amber-300' : ''}`}
            >
              {pinned ? '★' : '☆'}
            </button>
          )}
          <SocialLink href={`https://v2.bubblemaps.io/map?address=${t.mint}&chain=${isEth ? 'eth' : 'solana'}`} label="🫧" title="Open on Bubblemaps" className={ACTION_BTN} />
          {!isEth && <SocialLink href={`https://pump.fun/coin/${t.mint}`} label="💊" title="Open on pump.fun" className={ACTION_BTN} />}
          {meta?.twitter && <SocialLink href={meta.twitter} label="𝕏" title="Open X / Twitter" className={ACTION_BTN} />}
          {meta?.telegram && <SocialLink href={meta.telegram} label="✈" title="Open Telegram" className={ACTION_BTN} />}
          {meta?.website && <SocialLink href={meta.website} label="🌐" title="Open website" className={ACTION_BTN} />}
          <button
            onClick={(e) => { e.stopPropagation(); onLookup(); }}
            title="Look up the buyers for this token"
            className={ACTION_BTN}
          >
            🔍
          </button>
          <DexScreenerButton
            address={t.mint}
            chain={isEth ? 'ethereum' : 'solana'}
            title="Open on DexScreener"
            className="inline-flex items-center justify-center w-6 h-6 rounded-[3px] overflow-hidden shrink-0 opacity-80 hover:opacity-100 ring-1 ring-transparent hover:ring-emerald-500/60 transition"
          />
        </div>
      </div>

      {!isEth && (
        <div className="mt-2 flex items-baseline flex-wrap gap-x-2 gap-y-1">
          <span className={`text-xl font-semibold ${positive ? 'text-emerald-400' : 'text-red-400'}`}>
            {positive ? '+' : ''}{fmtSol(t.netInflowSol)}
          </span>
          <span className="text-[11px] uppercase tracking-wider text-slate-500">◎ Net Inflow · 15m</span>
          <span className="text-xs text-slate-400"><span className="text-slate-600">tx</span> {t.txCount}</span>
          <span className="text-xs text-slate-400"><span className="text-slate-600">age</span> {ageStr(t.firstSeen)}</span>
          {t.bundledPct !== null && <BundleBadge pct={t.bundledPct} wallets={t.bundleWallets} />}
        </div>
      )}

      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-wider text-slate-500">{isEth ? 'ETH ·' : ''} Market Cap</span>
        <span className="text-2xl font-bold text-slate-100">{fmtUsd(t.marketCapUsd)}</span>
        {isEth && t.priceUsd !== null && (
          <span className="text-xs text-slate-400 tabular-nums">{fmtPrice(t.priceUsd)}</span>
        )}
        {onBuy && !isEth && (
          <button
            onClick={(e) => { e.stopPropagation(); onBuy(); }}
            title="Buy this token in the Trade terminal"
            className="ml-auto self-center rounded bg-emerald-600 hover:bg-emerald-500 px-3 py-1 text-xs font-bold uppercase tracking-wider text-white shrink-0"
          >
            Buy
          </button>
        )}
      </div>

      {!isEth && <Sparkline data={t.spark} positive={positive} />}

      {!isEth && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="text-emerald-400 font-medium">▲ {fmtSol(t.buyVolSol)}</span>
          <div className="flex-1 h-1.5 rounded-full bg-red-500/40 overflow-hidden">
            <div className="h-full bg-emerald-500" style={{ width: `${buyPct}%` }} />
          </div>
          <span className="text-red-400 font-medium">{fmtSol(t.sellVolSol)} ▼</span>
        </div>
      )}

      {!isEth && <GraduationBar marketCapUsd={t.marketCapUsd} />}

      <div className="mt-1.5 mono text-[11px] text-slate-600 truncate">{shortMint(t.mint)}</div>
    </div>
  );
}

// Shows what % of total supply was bought in the launch bundle (the buys that
// landed in the same slot the mint was created). Only rendered when we
// witnessed the launch live. High % = concentrated insider/bundle launch.
function BundleBadge({ pct, wallets }: { pct: number; wallets: number }) {
  const cls = pct >= 20
    ? 'bg-red-500/15 text-red-400 border-red-900/60'
    : pct >= 8
      ? 'bg-amber-500/15 text-amber-400 border-amber-900/60'
      : 'bg-slate-700/30 text-slate-400 border-slate-700/60';
  return (
    <span
      className={`ml-auto rounded border px-2 py-1 text-sm font-bold leading-none ${cls}`}
      title={`${wallets} wallet${wallets === 1 ? '' : 's'} bought ${pct.toFixed(2)}% of supply in the launch bundle (same slot as token creation)`}
    >
      🧺 {pct.toFixed(pct >= 10 ? 0 : 1)}%
    </span>
  );
}

// Progress of the pump.fun bonding curve toward Raydium graduation, derived from
// market cap (graduation ≈ $69k). Helps spot tokens about to migrate.
function GraduationBar({ marketCapUsd }: { marketCapUsd: number | null }) {
  if (marketCapUsd === null || marketCapUsd <= 0) return null;
  const pct = Math.min(100, (marketCapUsd / GRADUATION_MCAP_USD) * 100);
  const graduated = marketCapUsd >= GRADUATION_MCAP_USD;
  const near = !graduated && pct >= 75;
  const barColor = graduated ? 'bg-sky-400' : near ? 'bg-amber-400' : 'bg-emerald-500';
  return (
    <div
      className="mt-2"
      title={
        graduated
          ? 'Bonding curve full — graduating/graduated to Raydium'
          : `${pct.toFixed(0)}% to Raydium graduation (~$69k market cap)`
      }
    >
      <div className="flex items-center justify-between text-[10px] mb-0.5">
        <span className="uppercase tracking-wider text-slate-500">{graduated ? 'Graduated' : 'Graduation'}</span>
        <span className={graduated ? 'text-sky-300' : near ? 'text-amber-300' : 'text-slate-400'}>{pct.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div className={`h-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
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

// Token metadata (image + socials) lives in the off-chain JSON the mint's URI
// points at. We fetch it once per mint, cache it, and reuse it for both the
// icon and the social links.
interface TokenMeta {
  image: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
}

const metaCache = new Map<string, TokenMeta | null>();

function useTokenMeta(mint: string, uri: string | null): TokenMeta | null {
  const [meta, setMeta] = useState<TokenMeta | null>(() => metaCache.get(mint) ?? null);
  const tried = useRef(false);

  useEffect(() => {
    if (meta || tried.current || !uri) return;
    tried.current = true;
    let cancelled = false;
    (async () => {
      try {
        // Fetch via the main process — token-metadata hosts don't send CORS
        // headers, so a direct renderer fetch is blocked.
        const json = await window.api.fetchJson(toHttp(uri));
        if (!json) throw new Error('meta');
        const image = json.image;
        const m: TokenMeta = {
          image: typeof image === 'string' ? toHttp(image) : null,
          // pump.fun JSON puts socials at the top level; some use `x` for Twitter.
          twitter: asTwitter(json.twitter ?? json.x),
          telegram: asTelegram(json.telegram),
          website: asUrl(json.website)
        };
        if (!cancelled) {
          metaCache.set(mint, m);
          setMeta(m);
        }
      } catch {
        if (!cancelled) metaCache.set(mint, null);
      }
    })();
    return () => { cancelled = true; };
  }, [mint, uri, meta]);

  return meta;
}

// Whether the token has an "updated"/paid DexScreener profile — i.e. the team
// has added enhanced token info (header image, socials, website) to their
// DexScreener page. We read this off the public token-pairs endpoint (the same
// one the EVM page uses, so we know it works from the renderer): when `info` is
// populated on a pair, the page has been enhanced. Cached per mint; we only
// cache a *definitive* answer so a transient network error can't pin a token to
// "not updated" forever.
interface DexPairInfo {
  info?: {
    imageUrl?: string;
    header?: string;
    openGraph?: string;
    socials?: unknown[];
    websites?: unknown[];
  };
}

const dexPaidCache = new Map<string, boolean>();

function useDexPaid(mint: string): boolean {
  const [paid, setPaid] = useState<boolean>(() => dexPaidCache.get(mint) ?? false);

  useEffect(() => {
    if (dexPaidCache.has(mint)) { setPaid(dexPaidCache.get(mint)!); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
        if (!res.ok) throw new Error('dex');
        const json = (await res.json()) as { pairs?: DexPairInfo[] };
        const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
        const updated = pairs.some((p) => {
          const info = p?.info;
          if (!info || typeof info !== 'object') return false;
          const socials = Array.isArray(info.socials) ? info.socials.length : 0;
          const websites = Array.isArray(info.websites) ? info.websites.length : 0;
          return Boolean(info.imageUrl || info.header || info.openGraph) || socials > 0 || websites > 0;
        });
        if (!cancelled) { dexPaidCache.set(mint, updated); setPaid(updated); }
      } catch {
        // Transient failure — do NOT cache, so a later render can retry.
      }
    })();
    return () => { cancelled = true; };
  }, [mint]);

  return paid;
}

// When a token's DexScreener profile was paid for / last updated. DexScreener's
// per-token orders endpoint records each paid action with a `paymentTimestamp`;
// the approved `tokenProfile` (or community takeover) order is the "enhanced
// profile" purchase, so its payment time ≈ when the update went through. Only
// fetched for tokens already flagged paid (so non-paid tokens cost no request).
// Returns unix seconds, or null. Cached per mint; null caches too (definitive
// "no dated order"), but transient errors don't, so a later render can retry.
interface DexOrder {
  type?: string;
  status?: string;
  paymentTimestamp?: number;
}

const dexUpdatedCache = new Map<string, number | null>();

function useDexUpdatedAt(mint: string, enabled: boolean): number | null {
  const [ts, setTs] = useState<number | null>(() => dexUpdatedCache.get(mint) ?? null);

  useEffect(() => {
    if (!enabled) return;
    if (dexUpdatedCache.has(mint)) { setTs(dexUpdatedCache.get(mint)!); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`https://api.dexscreener.com/orders/v1/solana/${mint}`);
        if (!res.ok) throw new Error('orders');
        const json = (await res.json()) as { orders?: DexOrder[] } | DexOrder[];
        const orders = Array.isArray(json) ? json : Array.isArray(json?.orders) ? json.orders : [];
        let latestMs: number | null = null;
        for (const o of orders) {
          if (o?.status !== 'approved') continue;
          if (o?.type !== 'tokenProfile' && o?.type !== 'communityTakeover') continue;
          const pt = typeof o.paymentTimestamp === 'number' ? o.paymentTimestamp : null;
          if (pt !== null && (latestMs === null || pt > latestMs)) latestMs = pt;
        }
        const secs = latestMs !== null ? Math.floor(latestMs / 1000) : null;
        if (!cancelled) { dexUpdatedCache.set(mint, secs); setTs(secs); }
      } catch {
        // Transient failure — do NOT cache, so a later render can retry.
      }
    })();
    return () => { cancelled = true; };
  }, [mint, enabled]);

  return ts;
}

// Bold, hard-to-miss badge shown next to the name when DexScreener is updated.
function DexPaidBadge() {
  return (
    <span
      title="DexScreener updated — this token has an enhanced/paid DexScreener profile (banner image, socials, website)"
      className="inline-flex items-center gap-0.5 rounded bg-emerald-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white shadow-sm shrink-0"
    >
      ✓ DEX
    </span>
  );
}

function TokenIcon({ mint, image, symbol }: { mint: string; image: string | null; symbol: string | null }) {
  if (image) {
    return <img src={image} alt="" className="w-7 h-7 rounded shrink-0 object-cover bg-slate-800" />;
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

// --- URL normalizers for the socials in the token metadata JSON ---
function asUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return 'https:' + s;
  return 'https://' + s.replace(/^\/+/, '');
}

function asTwitter(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return `https://x.com/${s.replace(/^@/, '')}`;
}

function asTelegram(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  return `https://t.me/${s.replace(/^@/, '')}`;
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

function fmtPrice(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(2)}`;
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

// Open the Photon chart for a mint in the system browser. Photon resolves the
// token mint to its primary pool on the /lp route.
function openPhoton(mint: string): void {
  const url = isEthAddr(mint)
    ? `https://dexscreener.com/ethereum/${mint}`
    : `https://photon-sol.tinyastro.io/en/lp/${mint}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}
