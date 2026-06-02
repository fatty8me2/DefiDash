import React, { useState } from 'react';
import type { BuyerRow, LookupResult, WalletDetail } from '../../shared/types';
import WalletDetailPanel from './WalletDetailPanel';
import { isFreshWallet } from '../lib/freshWallet';

function short(addr: string) {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function fmtNum(n: number, digits = 4) {
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(2) + 'K';
  if (Math.abs(n) < 0.0001) return n.toExponential(2);
  return n.toFixed(digits);
}

function fmtUsd(n: number | null | undefined) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const v = Math.abs(n);
  if (v >= 1_000_000) return `${sign}$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${sign}$${(v / 1_000).toFixed(2)}K`;
  return `${sign}$${v.toFixed(2)}`;
}

function fmtBalance(n: number | null | undefined, sym: string) {
  if (n === null || n === undefined) return '—';
  if (n === 0) return `0 ${sym}`;
  if (n < 0.001) return `<0.001 ${sym}`;
  if (n < 1) return `${n.toFixed(3)} ${sym}`;
  if (n < 1000) return `${n.toFixed(2)} ${sym}`;
  return `${(n / 1000).toFixed(2)}K ${sym}`;
}

function ago(ts: number) {
  const s = Date.now() / 1000 - ts;
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function explorerTxUrl(chain: 'ethereum' | 'solana', hash: string) {
  return chain === 'ethereum' ? `https://etherscan.io/tx/${hash}` : `https://solscan.io/tx/${hash}`;
}

function explorerWalletUrl(chain: 'ethereum' | 'solana', wallet: string) {
  return chain === 'ethereum' ? `https://etherscan.io/address/${wallet}` : `https://solscan.io/account/${wallet}`;
}

// Score → row background tint + dot color
function scoreClasses(score: number | null | undefined): { row: string; dot: string; text: string } {
  if (score === undefined) return { row: '', dot: 'bg-slate-700', text: 'text-slate-600' };
  if (score === null) return { row: '', dot: 'bg-slate-700', text: 'text-slate-600' };
  if (score >= 70) return { row: 'bg-emerald-900/20 hover:bg-emerald-900/30', dot: 'bg-emerald-400', text: 'text-emerald-300' };
  if (score >= 50) return { row: 'bg-amber-900/10 hover:bg-amber-900/20', dot: 'bg-amber-400', text: 'text-amber-300' };
  if (score >= 30) return { row: 'hover:bg-slate-900/40', dot: 'bg-slate-500', text: 'text-slate-300' };
  return { row: 'opacity-60 hover:bg-slate-900/40', dot: 'bg-slate-700', text: 'text-slate-500' };
}

// Tooltip for the Score cell — surfaces Cielo smart-money data when a key is set.
function scoreTooltip(row: BuyerRow): string {
  const hasCielo = row.cieloPnlUsd !== undefined && row.cieloPnlUsd !== null;
  const hasWr = row.cieloWinRatePct !== undefined && row.cieloWinRatePct !== null;
  if (!hasCielo && !hasWr) return 'Smart score (0–100). Add a Cielo API key in Settings for PnL-based scoring.';
  const parts: string[] = ['Cielo smart-money (30d):'];
  if (hasCielo) parts.push(`Realized PnL ${fmtUsd(row.cieloPnlUsd)}`);
  if (hasWr) parts.push(`Win rate ${(row.cieloWinRatePct as number).toFixed(0)}%`);
  return parts.join('\n');
}

function HeldCell({ pct }: { pct: number | null | undefined }) {
  if (pct === undefined) return <span className="text-slate-500">…</span>;
  if (pct === null) return <span className="text-slate-500">—</span>;
  if (pct <= 0) return <span className="text-red-400" title="Sold/transferred everything">0%</span>;
  if (pct < 0.1) return <span className="text-red-400" title={`Holds ${(pct * 100).toFixed(1)}% of this buy`}>{(pct * 100).toFixed(0)}%</span>;
  if (pct < 0.9) return <span className="text-amber-300" title={`Sold ${((1 - pct) * 100).toFixed(0)}% of this buy`}>{(pct * 100).toFixed(0)}%</span>;
  if (pct <= 1.1) return <span className="text-emerald-400" title="Still holding the full buy">✓ 100%</span>;
  // >110% means they added more after this buy (or were already holding)
  const added = Math.round((pct - 1) * 100);
  return (
    <span className="text-cyan-300" title={`Current balance is ${(pct * 100).toFixed(0)}% of this single buy — they accumulated more`}>
      +{added}% more
    </span>
  );
}

export default function BuyersTable({ result }: { result: LookupResult }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, WalletDetail | 'loading' | 'error'>>({});
  const nativeSym = result.chain === 'ethereum' ? 'ETH' : 'SOL';

  function toggleExpand(wallet: string) {
    if (expanded === wallet) {
      setExpanded(null);
      return;
    }
    setExpanded(wallet);
    if (!details[wallet]) {
      setDetails((d) => ({ ...d, [wallet]: 'loading' }));
      window.api
        .walletDetail(result.chain, wallet)
        .then((d) => setDetails((prev) => ({ ...prev, [wallet]: d })))
        .catch(() => setDetails((prev) => ({ ...prev, [wallet]: 'error' })));
    }
  }

  return (
    <div className="overflow-x-auto border border-slate-800 rounded">
      <table className="w-full text-sm">
        <thead className="bg-slate-900/60 text-xs uppercase tracking-wider text-slate-400 sticky top-0">
          <tr>
            <th className="w-6"></th>
            <th className="text-left px-3 py-2">When</th>
            <th className="text-left px-3 py-2">Wallet</th>
            <th className="text-right px-3 py-2">Tokens</th>
            <th className="text-right px-3 py-2">Spent</th>
            <th className="text-right px-3 py-2">USD</th>
            <th className="text-right px-3 py-2">Age</th>
            <th className="text-right px-3 py-2">Txs</th>
            <th className="text-right px-3 py-2">Balance</th>
            <th className="text-right px-3 py-2">#Tokens</th>
            <th className="text-right px-3 py-2" title="Current token balance vs the amount they bought in this tx. 100% = still holds. >100% = added more later. <100% = sold some.">Held*</th>
            <th className="text-right px-3 py-2">Score</th>
            <th className="text-left px-3 py-2">Tx</th>
          </tr>
        </thead>
        <tbody>
          {result.buyers.map((row, i) => {
            const sc = scoreClasses(row.smartScore);
            const isOpen = expanded === row.wallet;
            return (
              <React.Fragment key={`${row.txHash}-${i}`}>
                <tr
                  className={`border-t border-slate-800 cursor-pointer ${sc.row}`}
                  onClick={() => toggleExpand(row.wallet)}
                >
                  <td className="pl-3 pr-1">
                    <span className={`inline-block w-2 h-2 rounded-full ${sc.dot}`} />
                  </td>
                  <td className="px-3 py-2 text-slate-400">{ago(row.blockTime)}</td>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <span className="text-slate-500">{isOpen ? '▾' : '▸'}</span>
                      <a
                        href={explorerWalletUrl(result.chain, row.wallet)}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="mono text-slate-200 hover:text-emerald-400"
                      >
                        {short(row.wallet)}
                      </a>
                      {isFreshWallet(row.walletAgeDays, row.walletTxCount) && (
                        <span
                          className="text-base leading-none"
                          title={`Fresh wallet — age ${row.walletAgeDays}d, ${row.walletTxCount} txs. Likely a sniper/burner.`}
                        >
                          🌱
                        </span>
                      )}
                      {row.isContract && <span className="text-[10px] text-amber-400 uppercase">contract</span>}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right mono">{fmtNum(row.tokenAmount)}</td>
                  <td className="px-3 py-2 text-right mono text-slate-300">
                    {fmtNum(row.spentAmount)} <span className="text-slate-500 text-xs">{row.spentSymbol}</span>
                  </td>
                  <td className="px-3 py-2 text-right mono">{fmtUsd(row.usdValue)}</td>
                  <td className="px-3 py-2 text-right text-slate-400">
                    {row.walletAgeDays === undefined ? '…' : row.walletAgeDays === null ? '—' : `${row.walletAgeDays}d`}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-400">
                    {row.walletTxCount === undefined ? '…' : row.walletTxCount === null ? '—' : row.walletTxCount.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right mono text-slate-300">
                    {row.nativeBalance === undefined ? '…' : fmtBalance(row.nativeBalance, nativeSym)}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-300">
                    {row.tokenCount === undefined ? '…' : row.tokenCount === null ? '—' : row.tokenCount}
                  </td>
                  <td className="px-3 py-2 text-right mono">
                    <HeldCell pct={row.stillHoldingPct} />
                  </td>
                  <td className={`px-3 py-2 text-right font-semibold ${sc.text}`} title={scoreTooltip(row)}>
                    {row.smartScore === undefined ? '…' : row.smartScore === null ? '—' : row.smartScore}
                  </td>
                  <td className="px-3 py-2">
                    <a
                      href={explorerTxUrl(result.chain, row.txHash)}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="mono text-xs text-slate-500 hover:text-emerald-400"
                    >
                      {short(row.txHash)}
                    </a>
                  </td>
                </tr>
                {isOpen && (
                  <tr className="border-t border-slate-800 bg-slate-900/40">
                    <td colSpan={13} className="px-6 py-4">
                      <WalletDetailPanel detail={details[row.wallet]} chain={result.chain} wallet={row.wallet} />
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
