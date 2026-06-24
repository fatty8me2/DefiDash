import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { FlowSnapshot, FlowToken, TradeHolding, TradeQuote, TradeResult, TradeSide, TradeSpeed, TradeTokenBalance, TradeWalletInfo, TradeWalletSummary } from '../../shared/types';
import CopyButton from './CopyButton';
import { Watchlist, makePlaceholderToken } from './PumpFlowPage';
import { loadWatchlist, saveWatchlist } from '../lib/watchlist';
import { loadHidden, saveHidden } from '../lib/hiddenTokens';
import { useWatchlistDex } from '../lib/useWatchlistDex';

interface Props {
  hasHelius: boolean;
  initialMint?: string | null;   // autofilled when arriving from a Pump Flow "Buy" click
  onOpenSettings: () => void;
}

const QUOTE_REFRESH_MS = 5000; // re-fetch the quote this often to keep it fresh (lower = more rate-limit risk)
const SOL_PRESETS = [0.05, 0.1, 0.25, 0.5, 1];
const SELL_PCTS = [25, 50, 75, 100];
const SLIPPAGE_OPTS = [50, 100, 300, 500, 1000]; // bps
const AUTO_QUOTE_BPS = 500; // slippage used only for the indicative quote while "Auto" is selected
const SPEED_OPTS: { key: TradeSpeed; label: string; hint: string }[] = [
  { key: 'normal', label: 'Normal', hint: 'Lowest fee (~0.0005 SOL max priority) — fine when the network is quiet' },
  { key: 'fast', label: 'Fast', hint: 'Higher priority fee (~0.001 SOL max) — lands quicker in busy conditions' },
  { key: 'turbo', label: 'Turbo', hint: 'Aggressive priority fee (~0.004 SOL max) — for hot launches / congestion' }
];

function shortAddr(a: string): string {
  return a.length <= 10 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}
function fmt(n: number | null, max = 6): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return n.toLocaleString(undefined, { maximumFractionDigits: max });
}

export default function TradePage({ hasHelius, initialMint, onOpenSettings }: Props) {
  const [wallet, setWallet] = useState<TradeWalletInfo | null>(null);
  const [wallets, setWallets] = useState<TradeWalletSummary[]>([]);
  const [loadingWallet, setLoadingWallet] = useState(true);

  const [side, setSide] = useState<TradeSide>('buy');
  const [mint, setMint] = useState<string>(initialMint ?? '');
  const [amount, setAmount] = useState<string>('');
  const [slippageBps, setSlippageBps] = useState<number>(100);
  const [autoSlip, setAutoSlip] = useState(true); // default to Auto (Jupiter dynamic slippage)
  const [customSlip, setCustomSlip] = useState('');
  // Effective slippage for the indicative quote; the swap uses dynamic slippage when Auto.
  const effSlippageBps = autoSlip ? AUTO_QUOTE_BPS : slippageBps;
  const [speed, setSpeed] = useState<TradeSpeed>('fast');

  const [tokenBal, setTokenBal] = useState<TradeTokenBalance | null>(null);
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [result, setResult] = useState<TradeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [holdings, setHoldings] = useState<TradeHolding[]>([]);
  const [loadingHoldings, setLoadingHoldings] = useState(false);
  const [hidden, setHidden] = useState<string[]>(() => loadHidden());

  // Watchlist (shared with Pump Flow via localStorage) shown on the left rail.
  const [pinned, setPinned] = useState<string[]>(() => loadWatchlist());

  // Persist the hidden-token list so it survives restarts.
  useEffect(() => { saveHidden(hidden); }, [hidden]);
  const hideToken = (mintToHide: string) => setHidden((h) => (h.includes(mintToHide) ? h : [...h, mintToHide]));
  const unhideToken = (mintToShow: string) => setHidden((h) => h.filter((m) => m !== mintToShow));

  // Persist the watchlist whenever it changes.
  useEffect(() => { saveWatchlist(pinned); }, [pinned]);
  const addPin = (m: string) => setPinned((p) => (p.includes(m) ? p : [...p, m]));
  const removePin = (m: string) => setPinned((p) => p.filter((x) => x !== m));

  const refreshWallet = () => {
    setLoadingWallet(true);
    Promise.all([window.api.tradeWalletInfo(), window.api.tradeListWallets()])
      .then(([w, list]) => { setWallet(w); setWallets(list); })
      .catch(() => undefined)
      .finally(() => setLoadingWallet(false));
  };

  // Switch which wallet trades execute from.
  function selectWallet(address: string) {
    window.api.tradeSelectWallet(address).then((w) => {
      setWallet(w);
      window.api.tradeListWallets().then(setWallets).catch(() => undefined);
      loadHoldings();
      setTokenBal(null);
    }).catch(() => undefined);
  }

  const loadHoldings = () => {
    setLoadingHoldings(true);
    window.api.tradeWalletTokens()
      .then(setHoldings)
      .catch(() => setHoldings([]))
      .finally(() => setLoadingHoldings(false));
  };

  useEffect(() => {
    refreshWallet();
  }, []);

  // Load the wallet's token holdings once it's connected.
  useEffect(() => {
    if (wallet?.exists) loadHoldings();
    else setHoldings([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet?.exists, wallet?.address]);

  // Jump straight to selling a held token from the holdings list.
  function sellHolding(h: TradeHolding) {
    setSide('sell');
    setMint(h.mint);
    setAmount('');
    setQuote(null);
    setResult(null);
    setError(null);
  }

  // Autofill the mint (and default to Buy) when arriving from a Pump Flow card.
  useEffect(() => {
    if (initialMint) {
      setMint(initialMint);
      setSide('buy');
      setQuote(null);
      setResult(null);
      setError(null);
    }
  }, [initialMint]);

  // Pull the wallet's balance of the active mint (for Sell + Max).
  const mintTrim = mint.trim();
  useEffect(() => {
    setTokenBal(null);
    if (!wallet?.exists || mintTrim.length < 32) return;
    let cancelled = false;
    window.api.tradeTokenBalance(mintTrim).then((b) => {
      if (!cancelled) setTokenBal(b);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [wallet?.exists, mintTrim]);

  const amountNum = Number(amount);
  const canTrade = wallet?.exists && mintTrim.length >= 32 && amountNum > 0 && hasHelius;

  // Keep the quote refreshing on a constant interval (not just once after you
  // stop typing). A live, fresh quote keeps Jupiter's route cache warm for the
  // pair, which makes the swap land reliably — manually refreshing right before
  // trading is what fixed the intermittent errors, so we do it automatically.
  // Background refreshes are silent (no spinner / no error spam); only the first
  // fetch after an input change shows "Quoting…".
  useEffect(() => {
    setResult(null);
    if (!canTrade) { setQuote(null); setQuoting(false); return; }
    let cancelled = false;
    const fetchQuote = async (showSpinner: boolean) => {
      if (showSpinner) setQuoting(true);
      try {
        const q = await window.api.tradeQuote({ side, mint: mintTrim, amount: amountNum, slippageBps: effSlippageBps });
        if (!cancelled) { setQuote(q); setError(null); }
      } catch {
        if (!cancelled && showSpinner) setQuote(null);
      } finally {
        if (!cancelled && showSpinner) setQuoting(false);
      }
    };
    const timer = setTimeout(() => fetchQuote(true), 500);
    const interval = setInterval(() => fetchQuote(false), QUOTE_REFRESH_MS);
    return () => { cancelled = true; clearTimeout(timer); clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, mintTrim, amount, effSlippageBps, canTrade]);

  async function onQuote() {
    if (!canTrade) return;
    setQuoting(true);
    setError(null);
    setQuote(null);
    try {
      const q = await window.api.tradeQuote({ side, mint: mintTrim, amount: amountNum, slippageBps: effSlippageBps });
      setQuote(q);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setQuoting(false);
    }
  }

  async function onSwap() {
    if (!canTrade) return;
    setSwapping(true);
    setError(null);
    setResult(null);
    try {
      const r = await window.api.tradeSwap({ side, mint: mintTrim, amount: amountNum, slippageBps: effSlippageBps, speed, dynamicSlippage: autoSlip });
      setResult(r);
      if (r.ok) {
        // Auto-pin bought tokens to the watchlist so they're easy to watch.
        if (side === 'buy' && mintTrim.length >= 32) addPin(mintTrim);
        setQuote(null);
        setAmount('');
        refreshWallet();
        loadHoldings();
        if (mintTrim.length >= 32) {
          window.api.tradeTokenBalance(mintTrim).then(setTokenBal).catch(() => undefined);
        }
      } else if (r.error) {
        setError(r.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSwapping(false);
    }
  }

  function applySellPct(pct: number) {
    if (!tokenBal) return;
    const v = (tokenBal.uiAmount * pct) / 100;
    // Trim float noise for display.
    setAmount(v > 0 ? String(Number(v.toPrecision(9))) : '0');
  }

  // Load a watchlist coin into the terminal (defaults to Buy).
  function loadMint(m: string) {
    setSide('buy');
    setMint(m);
    setAmount('');
    setQuote(null);
    setResult(null);
    setError(null);
  }

  // Manual refresh for the trade ("Jupiter") cell — clears any hung quoting /
  // error state and re-fetches the quote + the active mint's balance.
  function refreshTerminal() {
    setError(null);
    setResult(null);
    setQuoting(false);
    if (mintTrim.length >= 32 && wallet?.exists) {
      window.api.tradeTokenBalance(mintTrim).then(setTokenBal).catch(() => undefined);
    }
    onQuote();
  }

  return (
    <div className="flex items-start gap-4">
      {pinned.length > 0 && (
        <TradeWatchlist pinned={pinned} onRemove={removePin} onAdd={addPin} onPick={loadMint} onBuy={loadMint} />
      )}
      <div className="flex-1 min-w-0 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Trade</h2>
          <p className="text-xs text-slate-500">
            Swap on Solana via Jupiter, with an automatic pump.fun (PumpPortal) fallback for new coins Jupiter can&apos;t route. Your key is encrypted on this machine and only ever signs in the background process.
          </p>
        </div>
      </div>

      {!hasHelius && (
        <div className="rounded border border-amber-700 bg-amber-900/20 px-4 py-3 text-sm text-amber-200">
          A Helius key is required to broadcast trades.{' '}
          <button onClick={onOpenSettings} className="underline hover:text-amber-100">Add one in Settings</button>.
        </div>
      )}

      <WalletPanel
        wallet={wallet}
        wallets={wallets}
        loading={loadingWallet}
        onChanged={refreshWallet}
        onRefresh={refreshWallet}
        onSelect={selectWallet}
      />

      {wallet?.exists && (
        <>
        <div className="rounded border border-slate-800 bg-slate-900/40 p-4 space-y-4">
          {/* Header: Buy/Sell toggle + refresh */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-1 rounded bg-slate-900/60 border border-slate-800 p-1 w-fit">
              <SideTab label="Buy" active={side === 'buy'} accent="emerald" onClick={() => setSide('buy')} />
              <SideTab label="Sell" active={side === 'sell'} accent="rose" onClick={() => setSide('sell')} />
            </div>
            <button
              onClick={refreshTerminal}
              title="Refresh — re-fetch the quote & balance and clear any stuck state"
              className="text-xs px-2 py-1 rounded border border-slate-700 hover:border-slate-500 text-slate-400 shrink-0"
            >
              {quoting ? '…' : '↻'}
            </button>
          </div>

          {/* Slippage (above the mint box) — Auto (Jupiter dynamic) by default */}
          <div>
            <label className="text-[11px] uppercase tracking-wider text-slate-500">Slippage</label>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Chip
                label="Auto"
                title="Let Jupiter pick the optimal slippage for each trade (recommended)"
                active={autoSlip}
                onClick={() => { setAutoSlip(true); setCustomSlip(''); }}
              />
              {SLIPPAGE_OPTS.map((bps) => (
                <Chip
                  key={bps}
                  label={`${bps / 100}%`}
                  active={!autoSlip && customSlip === '' && slippageBps === bps}
                  onClick={() => { setAutoSlip(false); setCustomSlip(''); setSlippageBps(bps); }}
                />
              ))}
              <div
                className={`flex items-center rounded border px-1.5 ${
                  !autoSlip && customSlip !== ''
                    ? 'border-emerald-500 bg-emerald-500/10'
                    : 'border-slate-700'
                }`}
                title="Custom slippage %"
              >
                <input
                  value={customSlip}
                  onChange={(e) => {
                    const cleaned = e.target.value.replace(/[^0-9.]/g, '');
                    setCustomSlip(cleaned);
                    const pct = parseFloat(cleaned);
                    if (Number.isFinite(pct) && pct > 0) {
                      setAutoSlip(false);
                      setSlippageBps(Math.round(pct * 100));
                    }
                  }}
                  inputMode="decimal"
                  placeholder="x"
                  className="w-10 bg-transparent text-xs text-slate-200 text-right outline-none placeholder-slate-600"
                />
                <span className="text-xs text-slate-500 pl-0.5">%</span>
              </div>
            </div>
          </div>

          {/* Mint */}
          <div>
            <label className="text-[11px] uppercase tracking-wider text-slate-500">Token mint</label>
            <div className="mt-1 flex items-center gap-2">
              <input
                value={mint}
                onChange={(e) => setMint(e.target.value)}
                placeholder="Paste an SPL token mint address"
                spellCheck={false}
                className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 font-mono focus:border-emerald-500 outline-none"
              />
              {mintTrim.length >= 32 && <CopyButton value={mintTrim} title="Copy mint" />}
            </div>
            {side === 'sell' && tokenBal && (
              <div className="mt-1 text-[11px] text-slate-500">
                Holding <span className="text-slate-300">{fmt(tokenBal.uiAmount)}</span> of this token
              </div>
            )}
          </div>

          {/* Amount */}
          <div>
            <div className="flex items-center justify-between">
              <label className="text-[11px] uppercase tracking-wider text-slate-500">
                {side === 'buy' ? 'Amount to spend (SOL)' : 'Amount to sell (tokens)'}
              </label>
              {side === 'buy' && wallet.solBalance !== null && (
                <span className="text-[11px] text-slate-500">Balance: {fmt(wallet.solBalance)} SOL</span>
              )}
            </div>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              inputMode="decimal"
              placeholder="0.0"
              className="mt-1 w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 focus:border-emerald-500 outline-none"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {side === 'buy'
                ? SOL_PRESETS.map((p) => (
                    <Chip key={p} label={`${p}`} onClick={() => setAmount(String(p))} />
                  ))
                : SELL_PCTS.map((p) => (
                    <Chip
                      key={p}
                      label={`${p}%`}
                      disabled={!tokenBal || tokenBal.uiAmount <= 0}
                      onClick={() => applySellPct(p)}
                    />
                  ))}
            </div>
          </div>

          {/* Speed / priority fee */}
          <div>
            <label className="text-[11px] uppercase tracking-wider text-slate-500">Speed (priority fee)</label>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {SPEED_OPTS.map((s) => (
                <Chip
                  key={s.key}
                  label={s.label}
                  title={s.hint}
                  active={speed === s.key}
                  onClick={() => setSpeed(s.key)}
                />
              ))}
            </div>
          </div>

          {/* Quote / actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={onQuote}
              disabled={!canTrade || quoting || swapping}
              className="px-4 py-2 rounded text-sm border border-slate-700 hover:border-slate-500 text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {quoting ? 'Quoting…' : 'Refresh quote'}
            </button>
            <button
              onClick={onSwap}
              disabled={!canTrade || swapping}
              className={`px-5 py-2 rounded text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed ${
                side === 'buy'
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
                  : 'bg-rose-600 hover:bg-rose-500 text-white'
              }`}
            >
              {swapping ? 'Swapping…' : side === 'buy' ? 'Buy' : 'Sell'}
            </button>
          </div>

          {quote && <QuotePanel quote={quote} auto={autoSlip} />}

          {!quote && !quoting && canTrade && (
            <div className="rounded border border-slate-800 bg-slate-900/40 px-3 py-2 text-[11px] text-slate-500">
              No live quote for this token — the trade will route via pump.fun (PumpPortal) if Jupiter can&apos;t.
            </div>
          )}

          {error && (
            <div className="rounded border border-red-700 bg-red-900/30 px-3 py-2 text-xs text-red-200 break-words">
              {error}
            </div>
          )}

          {result?.ok && result.signature && (
            <div className="rounded border border-emerald-700 bg-emerald-900/20 px-3 py-2 text-xs text-emerald-200 flex items-center gap-2 flex-wrap">
              <span>✓ Swap confirmed.</span>
              <a
                href={`https://solscan.io/tx/${result.signature}`}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-emerald-100 font-mono"
              >
                {shortAddr(result.signature)}
              </a>
              <CopyButton value={result.signature} title="Copy signature" />
            </div>
          )}
        </div>

        <HoldingsPanel
          holdings={holdings}
          loading={loadingHoldings}
          activeMint={mintTrim}
          hidden={hidden}
          onRefresh={loadHoldings}
          onSell={sellHolding}
          onHide={hideToken}
          onUnhide={unhideToken}
          onWatch={addPin}
        />
        </>
      )}
      </div>
    </div>
  );
}

// Left-rail watchlist for the Trade tab — reuses the Pump Flow Watchlist card,
// streaming live data for the pinned mints (only while there's something to show).
function TradeWatchlist({
  pinned,
  onRemove,
  onAdd,
  onPick,
  onBuy
}: {
  pinned: string[];
  onRemove: (mint: string) => void;
  onAdd: (mint: string) => void;
  onPick: (mint: string) => void;
  onBuy: (mint: string) => void;
}) {
  const [snap, setSnap] = useState<FlowSnapshot | null>(null);
  const [data, setData] = useState<Map<string, FlowToken>>(new Map());

  useEffect(() => {
    window.api.flowAcquire();
    // Seed instantly from the background stream so the rail isn't stale on mount.
    window.api.flowSnapshot().then((s) => { if (s) setSnap(s); }).catch(() => undefined);
    const off = window.api.onFlowUpdate(setSnap);
    // Release on unmount — the stream auto-pauses when no watchlist view is open.
    return () => { off(); window.api.flowRelease(); };
  }, []);

  // DexScreener keeps pinned coins' price/market-cap fresh so they never go stale.
  const dexData = useWatchlistDex(pinned);

  // Prefer live firehose data; otherwise overlay current DexScreener price/mcap.
  useEffect(() => {
    setData((prev) => {
      const next = new Map<string, FlowToken>();
      const byMint = new Map((snap?.tokens ?? []).map((t) => [t.mint, t]));
      for (const m of pinned) {
        const live = byMint.get(m);
        if (live) { next.set(m, live); continue; }
        const base = prev.get(m) ?? makePlaceholderToken(m);
        const dex = dexData.get(m);
        next.set(m, dex ? {
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

  const liveMints = useMemo(
    () => new Set([...(snap?.tokens ?? []).map((t) => t.mint), ...dexData.keys()]),
    [snap, dexData]
  );

  return (
    <Watchlist
      mints={pinned}
      data={data}
      liveMints={liveMints}
      onDropMint={onAdd}
      onRemove={onRemove}
      onClickContract={onPick}
      onBuy={onBuy}
    />
  );
}

function HoldingsPanel({
  holdings,
  loading,
  activeMint,
  hidden,
  onRefresh,
  onSell,
  onHide,
  onUnhide,
  onWatch
}: {
  holdings: TradeHolding[];
  loading: boolean;
  activeMint: string;
  hidden: string[];
  onRefresh: () => void;
  onSell: (h: TradeHolding) => void;
  onHide: (mint: string) => void;
  onUnhide: (mint: string) => void;
  onWatch: (mint: string) => void;
}) {
  const [showHidden, setShowHidden] = useState(false);
  const hiddenSet = new Set(hidden);
  const visible = holdings.filter((h) => !hiddenSet.has(h.mint));
  const hiddenHoldings = holdings.filter((h) => hiddenSet.has(h.mint));
  const totalUsd = visible.reduce((sum, h) => sum + (h.usdValue ?? 0), 0);

  return (
    <div className="rounded border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] uppercase tracking-wider text-slate-500">Your tokens</span>
          <span className="text-[11px] text-slate-600">{visible.length}</span>
          {totalUsd > 0 && <span className="text-sm font-semibold text-slate-100">${fmt(totalUsd, 2)}</span>}
        </div>
        <div className="flex items-center gap-1.5">
          {hiddenHoldings.length > 0 && (
            <button
              onClick={() => setShowHidden((v) => !v)}
              className="text-[11px] px-2 py-1 rounded border border-slate-700 hover:border-slate-500 text-slate-400"
            >
              {showHidden ? 'Hide hidden' : `Hidden (${hiddenHoldings.length})`}
            </button>
          )}
          <button
            onClick={onRefresh}
            title="Refresh holdings"
            className="text-xs px-2 py-1 rounded border border-slate-700 hover:border-slate-500 text-slate-400"
          >
            {loading ? '…' : '↻'}
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="text-xs text-slate-500 py-4 text-center">
          {loading ? 'Loading holdings…' : holdings.length > 0 ? 'All tokens are hidden.' : 'No SPL tokens in this wallet yet.'}
        </div>
      ) : (
        <div className="divide-y divide-slate-800/60 max-h-80 overflow-y-auto">
          {visible.map((h) => (
            <HoldingRow
              key={h.mint}
              h={h}
              active={h.mint === activeMint}
              onSell={() => onSell(h)}
              onHide={() => onHide(h.mint)}
              onWatch={() => onWatch(h.mint)}
            />
          ))}
        </div>
      )}

      {showHidden && hiddenHoldings.length > 0 && (
        <div className="mt-3 pt-2 border-t border-slate-800">
          <div className="text-[10px] uppercase tracking-wider text-slate-600 mb-1">Hidden</div>
          <div className="divide-y divide-slate-800/60 max-h-48 overflow-y-auto">
            {hiddenHoldings.map((h) => (
              <div key={h.mint} className="flex items-center gap-2 px-1 py-2 opacity-60">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-slate-300 truncate">{h.symbol ?? shortAddr(h.mint)}</div>
                </div>
                <div className="text-xs text-slate-500 tabular-nums shrink-0">{fmt(h.uiAmount)}</div>
                <button
                  onClick={() => onUnhide(h.mint)}
                  title="Unhide this token"
                  className="ml-1 shrink-0 text-[10px] px-2 py-0.5 rounded border border-slate-700 hover:border-emerald-500 text-slate-400 hover:text-emerald-300"
                >
                  Unhide
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function HoldingRow({
  h,
  active,
  onSell,
  onHide,
  onWatch
}: {
  h: TradeHolding;
  active: boolean;
  onSell: () => void;
  onHide: () => void;
  onWatch: () => void;
}) {
  return (
    <div
      onClick={onSell}
      title="Click to sell this token"
      className={`group flex items-center gap-2 px-2 py-2 rounded cursor-pointer hover:bg-slate-800/40 ${active ? 'bg-slate-800/30' : ''}`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm text-slate-100 font-medium truncate">{h.symbol ?? shortAddr(h.mint)}</div>
        {h.name && <div className="text-[11px] text-slate-500 truncate">{h.name}</div>}
      </div>
      <div className="text-right shrink-0">
        <div className="text-sm text-slate-200 tabular-nums">{fmt(h.uiAmount)}</div>
        {h.usdValue !== null && h.usdValue > 0 && (
          <div className="text-[11px] text-slate-500 tabular-nums">${fmt(h.usdValue, 2)}</div>
        )}
      </div>
      <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={onWatch}
          title="Add to watchlist"
          className="w-5 h-5 rounded text-xs text-slate-600 hover:text-amber-400 hover:bg-slate-700/60 opacity-0 group-hover:opacity-100"
        >
          ★
        </button>
        <CopyButton
          value={h.mint}
          title="Copy mint"
          className="inline-flex items-center justify-center w-5 h-5 rounded text-[10px] leading-none text-slate-600 hover:text-emerald-400 hover:bg-slate-700/60 opacity-0 group-hover:opacity-100"
        />
        <button
          onClick={onHide}
          title="Hide from your tokens"
          className="w-5 h-5 rounded text-slate-600 hover:text-slate-300 hover:bg-slate-700/60 opacity-0 group-hover:opacity-100"
        >
          ✕
        </button>
      </div>
      <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-rose-300/80 px-1.5 py-0.5 rounded bg-rose-500/10">
        Sell
      </span>
    </div>
  );
}

function SideTab({ label, active, accent, onClick }: { label: string; active: boolean; accent: 'emerald' | 'rose'; onClick: () => void }) {
  const on = accent === 'emerald' ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white';
  return (
    <button
      onClick={onClick}
      className={`px-5 py-1.5 rounded text-sm font-medium ${active ? on : 'text-slate-400 hover:text-slate-200'}`}
    >
      {label}
    </button>
  );
}

function Chip({ label, active, disabled, title, onClick }: { label: string; active?: boolean; disabled?: boolean; title?: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`px-2.5 py-1 rounded text-xs border ${
        active
          ? 'border-emerald-500 text-emerald-300 bg-emerald-500/10'
          : 'border-slate-700 text-slate-400 hover:border-slate-500 hover:text-slate-200'
      } disabled:opacity-30 disabled:cursor-not-allowed`}
    >
      {label}
    </button>
  );
}

function QuotePanel({ quote, auto }: { quote: TradeQuote; auto: boolean }) {
  const inSym = quote.side === 'buy' ? 'SOL' : 'tokens';
  const outSym = quote.side === 'buy' ? 'tokens' : 'SOL';
  const impact = quote.priceImpactPct;
  const impactColor = impact === null ? 'text-slate-400' : impact > 0.05 ? 'text-rose-300' : impact > 0.01 ? 'text-amber-300' : 'text-emerald-300';
  return (
    <div className="rounded border border-slate-800 bg-slate-900/60 px-3 py-2.5 text-xs space-y-1.5">
      <Row label="You pay" value={`${fmt(quote.inUiAmount)} ${inSym}`} />
      <Row label="You receive (est.)" value={`${fmt(quote.outUiAmount)} ${outSym}`} valueClass="text-slate-100 font-medium" />
      {quote.usdValue !== null && <Row label="Value" value={`$${fmt(quote.usdValue, 2)}`} />}
      <Row
        label="Price impact"
        value={impact === null ? '—' : `${(impact * 100).toFixed(2)}%`}
        valueClass={impactColor}
      />
      <Row label="Max slippage" value={auto ? 'Auto (dynamic)' : `${quote.slippageBps / 100}%`} />
      {quote.routeLabels.length > 0 && <Row label="Route" value={quote.routeLabels.join(' → ')} />}
    </div>
  );
}

function Row({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className={`text-right ${valueClass ?? 'text-slate-300'}`}>{value}</span>
    </div>
  );
}

function WalletPanel({
  wallet,
  wallets,
  loading,
  onChanged,
  onRefresh,
  onSelect
}: {
  wallet: TradeWalletInfo | null;
  wallets: TradeWalletSummary[];
  loading: boolean;
  onChanged: () => void;
  onRefresh: () => void;
  onSelect: (address: string) => void;
}) {
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const revealRef = useRef<number | null>(null);

  async function generate() {
    setBusy(true);
    setErr(null);
    try {
      await window.api.tradeGenerateWallet();
      setAdding(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    if (!secret.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await window.api.tradeImportWallet(secret.trim());
      setSecret('');
      setImporting(false);
      setAdding(false);
      onChanged();
    } catch (e) {
      setErr('Invalid key. Paste a base58 secret key or a JSON byte array.');
    } finally {
      setBusy(false);
    }
  }

  async function reveal() {
    const s = await window.api.tradeRevealSecret();
    setRevealed(s);
    if (revealRef.current) window.clearTimeout(revealRef.current);
    revealRef.current = window.setTimeout(() => setRevealed(null), 30_000);
  }

  if (loading) {
    return <div className="rounded border border-slate-800 bg-slate-900/40 px-4 py-3 text-xs text-slate-500">Loading wallet…</div>;
  }

  if (!wallet?.exists) {
    return (
      <div className="rounded border border-slate-800 bg-slate-900/40 p-4 space-y-3">
        <div className="text-sm text-slate-200 font-medium">Connect a trading wallet</div>
        <p className="text-xs text-slate-500">
          Generate a fresh burner wallet (recommended — fund it with only what you want to trade), or import an
          existing key. The key is encrypted on this device with your OS keychain and never leaves the background process.
        </p>
        {!importing ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={generate}
              disabled={busy}
              className="px-4 py-2 rounded text-sm bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40"
            >
              {busy ? 'Working…' : 'Generate burner wallet'}
            </button>
            <button
              onClick={() => setImporting(true)}
              className="px-4 py-2 rounded text-sm border border-slate-700 hover:border-slate-500 text-slate-200"
            >
              Import private key
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <input
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Base58 secret key or [1,2,3,…] byte array"
              spellCheck={false}
              type="password"
              className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 font-mono focus:border-emerald-500 outline-none"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={doImport}
                disabled={busy || !secret.trim()}
                className="px-4 py-2 rounded text-sm bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40"
              >
                {busy ? 'Importing…' : 'Import'}
              </button>
              <button
                onClick={() => { setImporting(false); setSecret(''); setErr(null); }}
                className="px-4 py-2 rounded text-sm border border-slate-700 hover:border-slate-500 text-slate-300"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {err && <div className="text-xs text-red-300">{err}</div>}
      </div>
    );
  }

  return (
    <div className="rounded border border-slate-800 bg-slate-900/40 p-4 space-y-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-slate-500">Wallet</span>
          {wallets.length > 1 ? (
            <select
              value={wallet.address ?? ''}
              onChange={(e) => onSelect(e.target.value)}
              title="Switch the wallet you trade with"
              className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-200 font-mono focus:border-emerald-500 outline-none"
            >
              {wallets.map((w) => (
                <option key={w.address} value={w.address}>{shortAddr(w.address)}</option>
              ))}
            </select>
          ) : (
            <span className="font-mono text-sm text-slate-200">{wallet.address ? shortAddr(wallet.address) : '—'}</span>
          )}
          {wallet.address && <CopyButton value={wallet.address} title="Copy address" />}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-300">{fmt(wallet.solBalance)} SOL</span>
          <button onClick={onRefresh} title="Refresh balance" className="text-xs px-2 py-1 rounded border border-slate-700 hover:border-slate-500 text-slate-400">↻</button>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={reveal} className="text-[11px] px-2 py-1 rounded border border-slate-700 hover:border-amber-500 text-slate-400 hover:text-amber-300">
          Reveal private key
        </button>
        <button
          onClick={() => { setAdding((v) => !v); setImporting(false); setErr(null); }}
          className="text-[11px] px-2 py-1 rounded border border-slate-700 hover:border-emerald-500 text-slate-400 hover:text-emerald-300"
        >
          {adding ? 'Close' : '+ Add wallet'}
        </button>
      </div>
      {adding && (
        <div className="pt-2 mt-1 space-y-2 border-t border-slate-800">
          <p className="text-[11px] text-slate-500">Add another wallet — it becomes the active one. Switch back anytime from the dropdown above.</p>
          {!importing ? (
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={generate} disabled={busy} className="px-3 py-1.5 rounded text-sm bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40">
                {busy ? 'Working…' : 'Generate burner'}
              </button>
              <button onClick={() => setImporting(true)} className="px-3 py-1.5 rounded text-sm border border-slate-700 hover:border-slate-500 text-slate-200">
                Import private key
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <input
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="Base58 secret key or [1,2,3,…] byte array"
                spellCheck={false}
                type="password"
                className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 font-mono focus:border-emerald-500 outline-none"
              />
              <div className="flex items-center gap-2">
                <button onClick={doImport} disabled={busy || !secret.trim()} className="px-3 py-1.5 rounded text-sm bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40">
                  {busy ? 'Importing…' : 'Import'}
                </button>
                <button onClick={() => { setImporting(false); setSecret(''); setErr(null); }} className="px-3 py-1.5 rounded text-sm border border-slate-700 hover:border-slate-500 text-slate-300">
                  Cancel
                </button>
              </div>
            </div>
          )}
          {err && <div className="text-xs text-red-300">{err}</div>}
        </div>
      )}
      {revealed && (
        <div className="rounded border border-amber-700 bg-amber-900/20 px-3 py-2 space-y-1">
          <div className="text-[11px] text-amber-300">
            Back this up somewhere safe. Anyone with this key controls the funds. Auto-hides in 30s.
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-[11px] text-amber-100 font-mono break-all">{revealed}</code>
            <CopyButton value={revealed} title="Copy private key" />
          </div>
        </div>
      )}
    </div>
  );
}
