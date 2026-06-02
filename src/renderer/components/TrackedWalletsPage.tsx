import React, { useEffect, useState } from 'react';
import type { Chain, TrackedWallet, WalletDetail } from '../../shared/types';
import CopyButton from './CopyButton';

interface Props {
  hasAlchemy: boolean;
  hasHelius: boolean;
  onClickContract: (address: string) => void; // jump to a token lookup
  onOpenSettings: () => void;
}

const ETH_RE = /^0x[a-fA-F0-9]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function detectChain(addr: string): Chain | null {
  const t = addr.trim();
  if (ETH_RE.test(t)) return 'ethereum';
  if (SOL_RE.test(t)) return 'solana';
  return null;
}

function keyOf(w: { chain: Chain; address: string }): string {
  return w.chain === 'ethereum' ? `ethereum:${w.address.toLowerCase()}` : `solana:${w.address}`;
}

type DetailState = WalletDetail | 'loading' | 'error';

export default function TrackedWalletsPage({ hasAlchemy, hasHelius, onClickContract, onOpenSettings }: Props) {
  const [wallets, setWallets] = useState<TrackedWallet[]>([]);
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const [input, setInput] = useState('');
  const [label, setLabel] = useState('');
  const [addErr, setAddErr] = useState<string | null>(null);

  async function loadDetail(w: TrackedWallet) {
    const k = keyOf(w);
    setDetails((d) => ({ ...d, [k]: 'loading' }));
    try {
      const det = await window.api.walletDetail(w.chain, w.address);
      setDetails((d) => ({ ...d, [k]: det }));
    } catch {
      setDetails((d) => ({ ...d, [k]: 'error' }));
    }
  }

  // Initial load: pull the persisted list, then fetch each wallet's detail
  // staggered so we don't fire every provider request at once.
  useEffect(() => {
    let cancelled = false;
    window.api.trackedList().then((list) => {
      if (cancelled) return;
      setWallets(list);
      list.forEach((w, i) => setTimeout(() => loadDetail(w), i * 200));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function add() {
    const addr = input.trim();
    const chain = detectChain(addr);
    if (!chain) {
      setAddErr('Not a valid ETH (0x…) or Solana address.');
      return;
    }
    setAddErr(null);
    const list = await window.api.trackedAdd(chain, addr, label.trim());
    setWallets(list);
    setInput('');
    setLabel('');
    const added = list.find((w) => keyOf(w) === keyOf({ chain, address: addr }));
    if (added) loadDetail(added);
  }

  async function remove(w: TrackedWallet) {
    const list = await window.api.trackedRemove(w.chain, w.address);
    setWallets(list);
    setDetails((d) => {
      const next = { ...d };
      delete next[keyOf(w)];
      return next;
    });
  }

  function refreshAll() {
    wallets.forEach((w, i) => setTimeout(() => loadDetail(w), i * 200));
  }

  const noKeys = !hasAlchemy && !hasHelius;

  if (noKeys) {
    return (
      <div className="max-w-2xl mx-auto mt-12 border border-slate-800 rounded-lg p-6 bg-slate-900/40">
        <h2 className="text-lg font-semibold text-slate-100">Tracked Wallets needs an API key</h2>
        <p className="text-sm text-slate-300 mt-2">
          This dashboard pulls each wallet's holdings, funding source, and recent token activity
          from Alchemy (Ethereum) and Helius (Solana). Add at least one key to get started.
        </p>
        <p className="text-sm text-slate-300 mt-4">
          Add your keys in{' '}
          <button onClick={onOpenSettings} className="underline text-emerald-400 hover:text-emerald-300">Settings</button>.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <form
          className="flex items-end gap-2 flex-wrap"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <div>
            <label className="text-[10px] uppercase tracking-wider text-slate-400">Wallet address</label>
            <input
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (addErr) setAddErr(null);
              }}
              placeholder="0xWallet… or Solana address"
              className="mono mt-1 w-72 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm placeholder-slate-600 focus:outline-none focus:border-emerald-600"
            />
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider text-slate-400">Label (optional)</label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Smart money #1"
              className="mt-1 w-44 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm placeholder-slate-600 focus:outline-none focus:border-emerald-600"
            />
          </div>
          <button
            type="submit"
            disabled={!input.trim()}
            className="bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 disabled:text-slate-500 text-white px-4 py-2 rounded text-sm font-medium"
          >
            + Track
          </button>
        </form>
        {wallets.length > 0 && (
          <button
            onClick={refreshAll}
            className="text-xs px-3 py-2 rounded border border-slate-700 hover:border-slate-500 text-slate-300"
          >
            ↻ Refresh all
          </button>
        )}
      </div>

      {addErr && <div className="text-xs text-red-400">{addErr}</div>}

      {wallets.length === 0 ? (
        <div className="text-sm text-slate-500 border border-slate-800 rounded px-4 py-10 text-center">
          No wallets tracked yet. Paste an address above to pin it — you'll see its holdings, funding
          source, and recent buys here. Tip: copy a wallet from any buyers table and track it.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
          {wallets.map((w) => (
            <WalletCard
              key={keyOf(w)}
              wallet={w}
              detail={details[keyOf(w)]}
              onRefresh={() => loadDetail(w)}
              onRemove={() => remove(w)}
              onClickContract={onClickContract}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WalletCard({
  wallet,
  detail,
  onRefresh,
  onRemove,
  onClickContract
}: {
  wallet: TrackedWallet;
  detail: DetailState | undefined;
  onRefresh: () => void;
  onRemove: () => void;
  onClickContract: (address: string) => void;
}) {
  const loading = detail === 'loading' || detail === undefined;
  const errored = detail === 'error';
  const det = detail && detail !== 'loading' && detail !== 'error' ? detail : null;

  const portfolioUsd = det
    ? det.topHoldings.reduce((sum, h) => sum + (h.usdValue ?? 0), 0)
    : null;

  return (
    <div className="rounded border border-slate-800 bg-slate-900/40 p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <ChainBadge chain={wallet.chain} />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-100 truncate">
            {wallet.label || shortAddr(wallet.address)}
          </div>
          {wallet.label && (
            <div className="mono text-[10px] text-slate-500 truncate">{shortAddr(wallet.address)}</div>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <a
            href={explorerUrl(wallet.chain, wallet.address)}
            target="_blank"
            rel="noreferrer"
            title="Open in block explorer"
            className="text-slate-500 hover:text-emerald-400 text-xs px-1"
          >
            ↗
          </a>
          <CopyButton value={wallet.address} title="Copy wallet address" />
          <button
            onClick={onRefresh}
            title="Refresh this wallet"
            className="text-slate-500 hover:text-emerald-400 text-xs px-1"
          >
            ↻
          </button>
          <button
            onClick={onRemove}
            title="Stop tracking"
            className="text-slate-500 hover:text-red-400 text-xs px-1"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 text-[11px] text-slate-400">
        {portfolioUsd !== null && portfolioUsd > 0 && (
          <span className="text-slate-200 font-medium">{fmtUsd(portfolioUsd)}</span>
        )}
        {det?.fundingSource && (
          <span title={det.fundingTime ? `Funded ${ageStr(det.fundingTime)} ago` : undefined}>
            funded via <span className="text-slate-300">{det.fundingSource}</span>
            {det.fundingTime ? ` · ${ageStr(det.fundingTime)} ago` : ''}
          </span>
        )}
      </div>

      {loading && <div className="text-xs text-slate-500 py-3">Loading wallet activity…</div>}
      {errored && (
        <div className="text-xs text-red-400 py-3">
          Couldn't load — check the key for this chain and{' '}
          <button onClick={onRefresh} className="underline hover:text-red-300">retry</button>.
        </div>
      )}

      {det && (
        <>
          <Section title="Recent buys">
            {det.recentBuys.length === 0 ? (
              <Empty>No recent token buys.</Empty>
            ) : (
              <ul className="space-y-1">
                {det.recentBuys.slice(0, 6).map((b) => (
                  <li
                    key={b.txHash + b.contract}
                    onClick={() => onClickContract(b.contract)}
                    title="Look up this token's buyers"
                    className="flex items-center gap-2 text-[11px] cursor-pointer rounded px-1 py-0.5 hover:bg-slate-800/60"
                  >
                    <span className="text-slate-200 font-medium truncate max-w-[40%]">{b.symbol}</span>
                    <span className="text-slate-500">{fmtAmt(b.amount)}</span>
                    <span className="ml-auto text-slate-500">{b.usdValue ? fmtUsd(b.usdValue) : '—'}</span>
                    <span className="text-slate-600 w-8 text-right">{ageStr(b.blockTime)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Top holdings">
            {det.topHoldings.length === 0 ? (
              <Empty>No token holdings found.</Empty>
            ) : (
              <div className="flex flex-wrap gap-1">
                {det.topHoldings.slice(0, 8).map((h) => (
                  <button
                    key={h.contract}
                    onClick={() => onClickContract(h.contract)}
                    title={`${h.symbol}${h.usdValue ? ' · ' + fmtUsd(h.usdValue) : ''} — look up buyers`}
                    className="text-[11px] px-1.5 py-0.5 rounded border border-slate-700 text-slate-300 hover:border-emerald-600 hover:text-emerald-300"
                  >
                    {h.symbol}
                    {h.usdValue ? <span className="text-slate-500"> {fmtUsdShort(h.usdValue)}</span> : null}
                  </button>
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">{title}</div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] text-slate-600">{children}</div>;
}

function ChainBadge({ chain }: { chain: Chain }) {
  const eth = chain === 'ethereum';
  return (
    <span
      className={`shrink-0 w-7 h-7 rounded flex items-center justify-center text-[10px] font-semibold ${
        eth ? 'bg-indigo-500/20 text-indigo-300' : 'bg-purple-500/20 text-purple-300'
      }`}
      title={eth ? 'Ethereum' : 'Solana'}
    >
      {eth ? 'ETH' : 'SOL'}
    </span>
  );
}

function explorerUrl(chain: Chain, address: string): string {
  return chain === 'ethereum'
    ? `https://etherscan.io/address/${address}`
    : `https://solscan.io/account/${address}`;
}

function shortAddr(a: string): string {
  if (a.length <= 14) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function ageStr(unixSec: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function fmtAmt(n: number): string {
  const v = Math.abs(n);
  if (v >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  if (v >= 1) return n.toFixed(2);
  return n.toPrecision(2);
}

function fmtUsd(n: number): string {
  if (n >= 1000) return `$${Math.round(n).toLocaleString()}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(2)}`;
}

function fmtUsdShort(n: number): string {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (n >= 1) return `$${Math.round(n)}`;
  return `$${n.toPrecision(1)}`;
}
