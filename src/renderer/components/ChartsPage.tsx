import React, { useEffect, useRef, useState } from 'react';
import RGL, { WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import CopyButton from './CopyButton';
import { loadWatchlist, saveWatchlist } from '../lib/watchlist';
import { isEthAddr } from '../lib/addr';
import type { DaleSnapshot, DaleStatus } from '../../shared/types';

// Note: React already provides JSX typings for the Electron <webview> tag
// (WebViewHTMLAttributes) — it's enabled at runtime via webviewTag in the main window.

// WidthProvider(RGL) is typed for older React; cast to the props we actually use
// to sidestep the @types/react-grid-layout vs React 18 JSX incompatibility.
const Grid = WidthProvider(RGL) as unknown as React.ComponentType<{
  className?: string;
  layout?: Layout[];
  cols?: number;
  rowHeight?: number;
  margin?: [number, number];
  draggableHandle?: string;
  draggableCancel?: string;
  compactType?: 'vertical' | 'horizontal' | null;
  isBounded?: boolean;
  onLayoutChange?: (l: Layout[]) => void;
  onDragStart?: () => void;
  onDragStop?: () => void;
  onResizeStart?: () => void;
  onResizeStop?: () => void;
  children?: React.ReactNode;
}>;
// Bumped to v2 to discard older free-form layouts that placed the first card
// off-origin; everyone gets the clean reading-order layout below.
const LAYOUT_KEY = 'charts:layout:v2';
const DALE_LAYOUT_KEY = 'charts:dale:layout:v1';
const COLS = 12;
const ROW_H = 30;
const CARD_W = 6; // 2 charts per row on the 12-col grid
const CARD_H = 16; // ≈ 480px tall
const PER_ROW = COLS / CARD_W;

interface Props {
  onClickContract?: (mint: string) => void;
}

// One card in a chart grid. `key` is stable per card (a mint on Charts, a Dale
// push-id on Dale); `address` is what the chart renders.
interface GridItem {
  key: string;
  address: string;
  addedBy?: string;   // shown on Dale cards
}

function shortMint(a: string): string {
  return a.length <= 14 ? a : `${a.slice(0, 6)}…${a.slice(-6)}`;
}
// Chain slug for GMGN URLs (eth for 0x contracts, sol otherwise).
function gmgnChain(mint: string): string {
  return isEthAddr(mint) ? 'eth' : 'sol';
}
function gmgnChartUrl(mint: string): string {
  return `https://www.gmgn.cc/kline/${gmgnChain(mint)}/${mint}`;
}
function gmgnUrl(mint: string): string {
  return `https://www.gmgn.ai/${gmgnChain(mint)}/token/${mint}`;
}
// Second "open in browser" link: Photon for Solana, DexScreener for ETH.
function altOpenUrl(mint: string): string {
  return isEthAddr(mint)
    ? `https://dexscreener.com/ethereum/${mint}`
    : `https://photon-sol.tinyastro.io/en/lp/${mint}`;
}

// Injected into each chart webview so trading SPAs don't pause live updates when
// they think they're a hidden/background tab (the cause of the freeze).
const FORCE_VISIBLE = `(function(){try{
  Object.defineProperty(document,'visibilityState',{configurable:true,get:function(){return 'visible';}});
  Object.defineProperty(document,'hidden',{configurable:true,get:function(){return false;}});
  window.addEventListener('visibilitychange',function(e){e.stopImmediatePropagation();},true);
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('focus'));
}catch(e){}})();`;

function loadSavedLayout(key: string): Layout[] {
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveSavedLayout(key: string, layout: Layout[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))));
  } catch {
    /* ignore */
  }
}

// Per-card `data-grid` position keyed by the card's stable id (RGL uncontrolled
// mode). Unsaved cards flow in reading order — top-left first, fill right, then
// wrap down. Cards the user has dragged/resized keep their saved position.
function buildGridMap(saved: Layout[], keys: string[]): Record<string, Layout> {
  const byId = new Map(saved.map((l) => [l.i, l]));
  const out: Record<string, Layout> = {};
  keys.forEach((id, i) => {
    const ex = byId.get(id);
    out[id] = ex
      ? { i: id, x: ex.x, y: ex.y, w: ex.w, h: ex.h, minW: 3, minH: 6 }
      : {
          i: id,
          x: (i % PER_ROW) * CARD_W,
          y: Math.floor(i / PER_ROW) * CARD_H,
          w: CARD_W,
          h: CARD_H,
          minW: 3,
          minH: 6
        };
  });
  return out;
}

type Tab = 'charts' | 'dale';

export default function ChartsPage({ onClickContract }: Props) {
  const [tab, setTab] = useState<Tab>('charts');
  const [pinned, setPinned] = useState<string[]>(() => loadWatchlist());
  const [hasWallet, setHasWallet] = useState(false);
  const [dale, setDale] = useState<DaleSnapshot>({ entries: [], status: 'off' });

  // Only show the "Sell all" button if a trading wallet is configured.
  useEffect(() => {
    window.api.tradeWalletInfo().then((w) => setHasWallet(!!w.exists)).catch(() => undefined);
  }, []);

  // Persist watchlist removals made on this page.
  useEffect(() => { saveWatchlist(pinned); }, [pinned]);

  // Always reflect the current watchlist: re-read when it changes anywhere, and
  // on window focus. Equality guard avoids a save→event→re-read loop.
  useEffect(() => {
    const sync = () => {
      const next = loadWatchlist();
      setPinned((prev) => (prev.length === next.length && prev.every((m, i) => m === next[i]) ? prev : next));
    };
    window.addEventListener('watchlist:changed', sync);
    window.addEventListener('focus', sync);
    return () => {
      window.removeEventListener('watchlist:changed', sync);
      window.removeEventListener('focus', sync);
    };
  }, []);

  // Subscribe to the shared Dale ledger (seeded instantly from the main process,
  // then kept live by the Firebase stream).
  useEffect(() => {
    window.api.daleList().then(setDale).catch(() => undefined);
    const off = window.api.onDaleUpdate(setDale);
    return off;
  }, []);

  const removePin = (m: string) => setPinned((p) => p.filter((x) => x !== m));
  const refresh = () => setPinned(loadWatchlist());

  const addToDale = async (address: string) => {
    await window.api.daleAdd(address); // throws on failure; caller surfaces it
  };
  const removeFromDale = (id: string) => {
    window.api.daleRemove(id).catch((e) => window.alert(e instanceof Error ? e.message : String(e)));
  };

  const chartItems: GridItem[] = pinned.map((m) => ({ key: m, address: m }));
  const daleItems: GridItem[] = dale.entries.map((e) => ({ key: e.id, address: e.address, addedBy: e.addedBy }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="flex items-center gap-1">
            <TabButton label="Charts" active={tab === 'charts'} onClick={() => setTab('charts')} />
            <TabButton
              label="Dale"
              active={tab === 'dale'}
              onClick={() => setTab('dale')}
              badge={dale.entries.length || undefined}
            />
          </div>
          <p className="text-xs text-slate-500 mt-1.5">
            {tab === 'charts'
              ? 'Live GMGN charts for your watchlist. Drag a card by its title bar to move it, drag the corner to resize. “+ Dale” shares it with the crew.'
              : 'Shared charts — synced live with everyone on the same Dale. Anyone can add or remove; each card shows who added it.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tab === 'dale' && <DaleStatusPill status={dale.status} />}
          <span className="text-[11px] text-slate-500">{(tab === 'charts' ? chartItems : daleItems).length} coins</span>
          <button
            onClick={refresh}
            title="Reload the watchlist"
            className="text-xs px-2 py-1 rounded border border-slate-700 hover:border-slate-500 text-slate-400"
          >
            ↻
          </button>
        </div>
      </div>

      {tab === 'charts' ? (
        chartItems.length === 0 ? (
          <EmptyNote>
            Your watchlist is empty. Pin coins from the Pump Flow page (drag a card to the watchlist or tap ★),
            or buy one on the Trade tab — they'll show up here with their live chart.
          </EmptyNote>
        ) : (
          <ChartGrid
            items={chartItems}
            layoutKey={LAYOUT_KEY}
            hasWallet={hasWallet}
            onRemove={removePin}
            onLookup={onClickContract}
            onAddToDale={addToDale}
          />
        )
      ) : (
        <DaleView
          items={daleItems}
          status={dale.status}
          hasWallet={hasWallet}
          onRemove={removeFromDale}
          onLookup={onClickContract}
          onAdd={addToDale}
        />
      )}
    </div>
  );
}

// The Dale tab: a paste-to-add box + the shared grid (or setup/empty prompts).
function DaleView({
  items,
  status,
  hasWallet,
  onRemove,
  onLookup,
  onAdd
}: {
  items: GridItem[];
  status: DaleStatus;
  hasWallet: boolean;
  onRemove: (id: string) => void;
  onLookup?: (mint: string) => void;
  onAdd: (address: string) => Promise<void>;
}) {
  if (status === 'off') {
    return (
      <EmptyNote>
        Dale isn’t set up yet. Open <span className="text-slate-300">⚙ Settings → Dale (shared charts)</span> and
        enter the same Firebase URL, secret, and your name on all three machines. Then anything you add here is
        beamed to the crew in real time.
      </EmptyNote>
    );
  }
  return (
    <div className="space-y-3">
      <DaleAddBox onAdd={onAdd} />
      {items.length === 0 ? (
        <EmptyNote>
          No shared charts yet. Paste an address above, or hit “+ Dale” on any chart in the Charts tab to beam it here.
        </EmptyNote>
      ) : (
        <ChartGrid
          items={items}
          layoutKey={DALE_LAYOUT_KEY}
          hasWallet={hasWallet}
          onRemove={onRemove}
          onLookup={onLookup}
        />
      )}
    </div>
  );
}

function DaleAddBox({ onAdd }: { onAdd: (address: string) => Promise<void> }) {
  const [val, setVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    const a = val.trim();
    if (a.length < 32) { setErr('Paste a full token mint / contract address.'); return; }
    setBusy(true);
    setErr(null);
    try {
      await onAdd(a);
      setVal('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <input
          value={val}
          onChange={(e) => { setVal(e.target.value); setErr(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="Paste a mint / 0x contract to share on Dale"
          spellCheck={false}
          className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 font-mono focus:border-emerald-500 outline-none"
        />
        <button
          onClick={submit}
          disabled={busy}
          className="px-4 py-2 rounded text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40"
        >
          {busy ? 'Adding…' : '+ Add to Dale'}
        </button>
      </div>
      {err && <p className="text-xs text-rose-300 mt-1">{err}</p>}
    </div>
  );
}

// Shared grid renderer used by both tabs. Keeps its own saved layout (keyed by
// `layoutKey`) so Charts and Dale arrangements are independent.
function ChartGrid({
  items,
  layoutKey,
  hasWallet,
  onRemove,
  onLookup,
  onAddToDale
}: {
  items: GridItem[];
  layoutKey: string;
  hasWallet: boolean;
  onRemove: (key: string) => void;
  onLookup?: (mint: string) => void;
  onAddToDale?: (address: string) => Promise<void>;
}) {
  const [interacting, setInteracting] = useState(false);
  const [gridKey, setGridKey] = useState(0);
  const savedRef = useRef<Layout[]>(loadSavedLayout(layoutKey));

  const grids = buildGridMap(savedRef.current, items.map((it) => it.key));

  function onLayoutChange(l: Layout[]) {
    savedRef.current = l;
    saveSavedLayout(layoutKey, l);
  }
  function resetLayout() {
    localStorage.removeItem(layoutKey);
    savedRef.current = [];
    setGridKey((k) => k + 1);
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <button
          onClick={resetLayout}
          title="Reset the layout to a tidy grid"
          className="text-xs px-2 py-1 rounded border border-slate-700 hover:border-slate-500 text-slate-400"
        >
          Reset layout
        </button>
      </div>
      <Grid
        key={gridKey}
        className="layout"
        cols={COLS}
        rowHeight={ROW_H}
        margin={[12, 12]}
        draggableHandle=".chart-drag-handle"
        draggableCancel=".no-drag"
        compactType={null}
        isBounded={false}
        onLayoutChange={onLayoutChange}
        onDragStart={() => setInteracting(true)}
        onDragStop={() => setInteracting(false)}
        onResizeStart={() => setInteracting(true)}
        onResizeStop={() => setInteracting(false)}
      >
        {items.map((it) => (
          <div key={it.key} data-grid={grids[it.key]} className="rounded border border-slate-800 bg-slate-900/40 overflow-hidden">
            <ChartFrame
              mint={it.address}
              addedBy={it.addedBy}
              interacting={interacting}
              hasWallet={hasWallet}
              onRemove={() => onRemove(it.key)}
              onLookup={onLookup ? () => onLookup(it.address) : undefined}
              onAddToDale={onAddToDale ? () => onAddToDale(it.address) : undefined}
            />
          </div>
        ))}
      </Grid>
    </div>
  );
}

function ChartFrame({
  mint,
  addedBy,
  interacting,
  hasWallet,
  onRemove,
  onLookup,
  onAddToDale
}: {
  mint: string;
  addedBy?: string;
  interacting: boolean;
  hasWallet: boolean;
  onRemove: () => void;
  onLookup?: () => void;
  onAddToDale?: () => Promise<void>;
}) {
  // When on (default), embed GMGN's full token page (chart + transactions table
  // below). Toggle off for the lightweight chart-only view to reclaim space.
  const [txnsOn, setTxnsOn] = useState(true);
  const [selling, setSelling] = useState<'idle' | 'busy' | 'done'>('idle');
  const [daleState, setDaleState] = useState<'idle' | 'busy' | 'done'>('idle');

  async function sellAll() {
    if (!window.confirm(`Sell ALL of ${shortMint(mint)} for SOL? This swaps your entire balance of this token.`)) return;
    setSelling('busy');
    try {
      const r = await window.api.tradeSellAll({ mint });
      if (r.ok) {
        setSelling('done');
        window.setTimeout(() => setSelling('idle'), 4000);
      } else {
        setSelling('idle');
        window.alert(`Sell failed: ${r.error ?? 'unknown error'}`);
      }
    } catch (e) {
      setSelling('idle');
      window.alert(`Sell failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function shareToDale() {
    if (!onAddToDale || daleState === 'busy') return;
    setDaleState('busy');
    try {
      await onAddToDale();
      setDaleState('done');
      window.setTimeout(() => setDaleState('idle'), 3000);
    } catch (e) {
      setDaleState('idle');
      window.alert(`Couldn’t add to Dale: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const ref = useRef<HTMLDivElement>(null);
  const wvRef = useRef<(HTMLElement & { executeJavaScript: (code: string) => Promise<unknown> }) | null>(null);
  const [show, setShow] = useState(false);
  // Full GMGN page shows the transactions under the chart; kline is chart-only.
  const url = txnsOn ? gmgnUrl(mint) : gmgnChartUrl(mint);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShow(true);
          obs.disconnect();
        }
      },
      { rootMargin: '300px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Keep the embedded page "visible" so it keeps streaming.
  useEffect(() => {
    if (!show) return;
    const wv = wvRef.current;
    if (!wv) return;
    const inject = () => {
      try {
        wv.executeJavaScript(FORCE_VISIBLE);
      } catch {
        /* best-effort */
      }
    };
    wv.addEventListener('dom-ready', inject);
    const t = window.setInterval(inject, 20_000);
    return () => {
      try {
        wv.removeEventListener('dom-ready', inject);
      } catch {
        /* ignore */
      }
      window.clearInterval(t);
    };
  }, [show]);

  return (
    <div ref={ref} className="h-full flex flex-col">
      <div className="chart-drag-handle cursor-move px-3 py-2 border-b border-slate-800 flex items-center gap-2 bg-slate-900/60">
        <span className="mono text-xs text-slate-300 select-none">{shortMint(mint)}</span>
        <CopyButton value={mint} title="Copy mint" className="no-drag inline-flex items-center justify-center w-4 h-4 rounded text-[10px] leading-none text-slate-500 hover:text-emerald-400 hover:bg-slate-800/60 shrink-0" />
        {addedBy && (
          <span title={`Added by ${addedBy}`} className="no-drag text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-300 shrink-0">
            {addedBy}
          </span>
        )}
        {onLookup && (
          <button onClick={onLookup} title="Look up the buyers for this token" className="no-drag text-xs text-slate-500 hover:text-emerald-400">
            🔍
          </button>
        )}
        <button
          onClick={() => window.open(gmgnUrl(mint), '_blank', 'noopener,noreferrer')}
          title="Open the full GMGN page in your browser"
          className="no-drag text-[11px] text-slate-500 hover:text-emerald-400"
        >
          ↗ GMGN
        </button>
        <button
          onClick={() => window.open(altOpenUrl(mint), '_blank', 'noopener,noreferrer')}
          title={isEthAddr(mint) ? 'Open on DexScreener' : 'Open the full Photon trading page in your browser'}
          className="no-drag text-[11px] text-slate-500 hover:text-emerald-400"
        >
          {isEthAddr(mint) ? '↗ Dex' : '↗ Photon'}
        </button>
        <button
          onClick={() => setTxnsOn((v) => !v)}
          title={txnsOn ? 'Hide the transactions table (chart only)' : 'Show GMGN transactions under the chart'}
          className={`no-drag text-[11px] px-2 py-0.5 rounded border ${
            txnsOn
              ? 'border-sky-500 text-sky-300 bg-sky-500/10'
              : 'border-slate-700 text-slate-400 hover:border-sky-500 hover:text-sky-300'
          }`}
        >
          Txns
        </button>
        {onAddToDale && (
          <button
            onClick={shareToDale}
            disabled={daleState === 'busy'}
            title="Share this chart on the Dale ledger with the crew"
            className={`no-drag text-[11px] px-2 py-0.5 rounded border ${
              daleState === 'done'
                ? 'border-emerald-500 text-emerald-300 bg-emerald-500/10'
                : 'border-slate-700 text-slate-400 hover:border-emerald-500 hover:text-emerald-300'
            } disabled:opacity-50`}
          >
            {daleState === 'busy' ? '…' : daleState === 'done' ? '✓ Dale' : '+ Dale'}
          </button>
        )}
        {hasWallet && !isEthAddr(mint) && (
          <button
            onClick={sellAll}
            disabled={selling === 'busy'}
            title="Sell your entire balance of this token for SOL"
            className="no-drag text-[11px] px-2 py-0.5 rounded bg-rose-600 hover:bg-rose-500 text-white font-semibold disabled:opacity-50"
          >
            {selling === 'busy' ? 'Selling…' : selling === 'done' ? '✓ Sold' : 'Sell all'}
          </button>
        )}
        <button
          onClick={onRemove}
          title={addedBy ? 'Remove from Dale' : 'Remove from watchlist'}
          className="no-drag ml-auto text-slate-600 hover:text-red-300 text-sm leading-none"
        >
          ✕
        </button>
      </div>
      <div className="relative bg-slate-950 flex-1">
        <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-600">
          {show ? 'Loading live chart…' : 'Scroll to load chart…'}
        </div>
        {show && (
          <webview
            ref={(el) => {
              wvRef.current = el as unknown as HTMLElement & { executeJavaScript: (code: string) => Promise<unknown> };
            }}
            src={url}
            partition="persist:charts"
            webpreferences="backgroundThrottling=no"
            // Disable pointer events while dragging/resizing so the webview
            // doesn't swallow the mouse and break the gesture.
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: interacting ? 'none' : 'auto' }}
          />
        )}
      </div>
    </div>
  );
}

function TabButton({ label, active, onClick, badge }: { label: string; active: boolean; onClick: () => void; badge?: number }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded text-sm font-semibold border flex items-center gap-1.5 ${
        active
          ? 'border-emerald-500 text-emerald-300 bg-emerald-500/10'
          : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-700'
      }`}
    >
      {label}
      {badge !== undefined && (
        <span className={`text-[10px] px-1.5 rounded-full ${active ? 'bg-emerald-500/20 text-emerald-200' : 'bg-slate-800 text-slate-400'}`}>
          {badge}
        </span>
      )}
    </button>
  );
}

function DaleStatusPill({ status }: { status: DaleStatus }) {
  const live = status === 'live';
  const connecting = status === 'connecting';
  const cls = live
    ? 'bg-emerald-900/40 text-emerald-300'
    : connecting
      ? 'bg-amber-900/30 text-amber-300'
      : status === 'off'
        ? 'bg-slate-800 text-slate-500'
        : 'bg-rose-900/30 text-rose-300';
  const label = live ? '● live' : connecting ? '○ connecting…' : status === 'off' ? 'not set up' : status;
  return <span title={status} className={`text-[10px] px-2 py-0.5 rounded uppercase tracking-wider ${cls} max-w-[16rem] truncate`}>{label}</span>;
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-sm text-slate-500 border border-slate-800 rounded px-4 py-12 text-center max-w-2xl mx-auto">
      {children}
    </div>
  );
}
