import React from 'react';
import type { Chain, WalletDetail } from '../../shared/types';

function short(s: string) {
  return s.length <= 12 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function ago(ts: number) {
  const s = Date.now() / 1000 - ts;
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function fmt(n: number) {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(2) + 'K';
  if (Math.abs(n) < 0.001) return n.toExponential(1);
  return n.toFixed(3);
}

function fmtUsd(n: number | null | undefined) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const sign = n < 0 ? '-' : '';
  const v = Math.abs(n);
  if (v >= 1_000_000) return `${sign}$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${sign}$${(v / 1_000).toFixed(2)}K`;
  if (v < 0.01) return `${sign}<$0.01`;
  return `${sign}$${v.toFixed(2)}`;
}

function explorerWalletUrl(chain: Chain, wallet: string) {
  return chain === 'ethereum' ? `https://etherscan.io/address/${wallet}` : `https://solscan.io/account/${wallet}`;
}

function explorerTokenUrl(chain: Chain, contract: string) {
  return chain === 'ethereum'
    ? `https://etherscan.io/token/${contract}`
    : `https://solscan.io/token/${contract}`;
}

function explorerTxUrl(chain: Chain, hash: string) {
  return chain === 'ethereum' ? `https://etherscan.io/tx/${hash}` : `https://solscan.io/tx/${hash}`;
}

function dexUrl(chain: Chain, contract: string) {
  const slug = chain === 'ethereum' ? 'ethereum' : 'solana';
  return `https://dexscreener.com/${slug}/${contract}`;
}

export default function WalletDetailPanel({
  detail,
  chain,
  wallet
}: {
  detail: WalletDetail | 'loading' | 'error' | undefined;
  chain: Chain;
  wallet: string;
}) {
  if (detail === undefined || detail === 'loading') {
    return <div className="text-slate-500 text-xs">Loading wallet detail…</div>;
  }
  if (detail === 'error') {
    return <div className="text-red-400 text-xs">Failed to load wallet detail.</div>;
  }

  return (
    <div className="grid grid-cols-3 gap-6">
      {/* Identity / funding */}
      <div>
        <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">Wallet</div>
        <a
          href={explorerWalletUrl(chain, wallet)}
          target="_blank"
          rel="noreferrer"
          className="mono text-sm text-emerald-400 hover:underline break-all"
        >
          {wallet}
        </a>
        <div className="mt-4 text-xs uppercase tracking-wider text-slate-500 mb-1">Funded by</div>
        {detail.fundingSource ? (
          <div className="text-sm">
            <span className="text-slate-200">{detail.fundingSource}</span>
            {detail.fundingTime && (
              <span className="text-slate-500"> · {ago(detail.fundingTime)} ago</span>
            )}
          </div>
        ) : (
          <div className="text-slate-500 text-sm">—</div>
        )}
      </div>

      {/* Holdings */}
      <div>
        <div className="text-xs uppercase tracking-wider text-slate-500 mb-2 flex items-center justify-between">
          <span>Top holdings ({detail.topHoldings.length})</span>
          {(() => {
            const total = detail.topHoldings.reduce((s, h) => s + (h.usdValue ?? 0), 0);
            return total > 0 ? <span className="text-slate-400 normal-case">≈ {fmtUsd(total)}</span> : null;
          })()}
        </div>
        {detail.topHoldings.length === 0 && <div className="text-slate-500 text-sm">No tokens held</div>}
        <ul className="space-y-1 text-sm">
          {detail.topHoldings.map((h) => {
            const usd = fmtUsd(h.usdValue);
            return (
              <li key={h.contract} className="flex items-center justify-between gap-2">
                <a
                  href={explorerTokenUrl(chain, h.contract)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-slate-200 hover:text-emerald-400 truncate"
                >
                  {h.symbol}
                </a>
                <span className="flex items-baseline gap-2">
                  <span className="mono text-slate-400 text-xs">{fmt(h.amount)}</span>
                  <span className="mono text-emerald-300/80 text-xs w-16 text-right">{usd ?? '—'}</span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Recent buys */}
      <div>
        <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">
          Recent tokens received ({detail.recentBuys.length})
        </div>
        {detail.recentBuys.length === 0 && <div className="text-slate-500 text-sm">No recent activity</div>}
        <ul className="space-y-1 text-sm">
          {detail.recentBuys.map((b) => {
            const usd = fmtUsd(b.usdValue);
            return (
              <li key={b.txHash} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 min-w-0">
                  <a
                    href={dexUrl(chain, b.contract)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-slate-200 hover:text-emerald-400 truncate"
                    title={b.contract}
                  >
                    {b.symbol}
                  </a>
                  <span className="text-slate-500 text-xs">{ago(b.blockTime)}</span>
                </span>
                <span className="flex items-baseline gap-2">
                  <span className="mono text-slate-400 text-xs">{fmt(b.amount)}</span>
                  <span className="mono text-emerald-300/80 text-xs w-16 text-right">{usd ?? '—'}</span>
                  <a
                    href={explorerTxUrl(chain, b.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="mono text-slate-500 hover:text-emerald-400 text-xs"
                  >
                    {short(b.txHash)}
                  </a>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
