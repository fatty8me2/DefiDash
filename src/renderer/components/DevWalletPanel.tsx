import React from 'react';
import type { Chain, DevWalletInfo } from '../../shared/types';

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

function fmtBal(n: number | null, sym: string) {
  if (n === null) return '—';
  if (n === 0) return `0 ${sym}`;
  if (n < 0.001) return `<0.001 ${sym}`;
  if (n < 1) return `${n.toFixed(3)} ${sym}`;
  if (n < 1000) return `${n.toFixed(2)} ${sym}`;
  return `${(n / 1000).toFixed(2)}K ${sym}`;
}

function explorerUrl(chain: Chain, addr: string) {
  return chain === 'ethereum'
    ? `https://etherscan.io/address/${addr}`
    : `https://solscan.io/account/${addr}`;
}

export default function DevWalletPanel({
  info,
  chain
}: {
  info: DevWalletInfo | 'loading' | null;
  chain: Chain;
}) {
  if (info === null) return null;
  if (info === 'loading') {
    return (
      <div className="rounded border border-slate-800 bg-slate-900/40 px-4 py-2 text-xs text-slate-500">
        Inspecting deployer wallet…
      </div>
    );
  }

  const nativeSym = chain === 'ethereum' ? 'ETH' : 'SOL';

  // Risk signals worth highlighting:
  //   - many prior deploys + young wallet = serial launcher
  //   - funded from Tornado / mixer / brand-new = sketchy
  const isSerialLauncher = info.deploysFound !== null && info.deploysFound >= 5;
  const isFresh = info.ageDays !== null && info.ageDays <= 7;
  const isMixerFunded = !!info.fundingSource?.toLowerCase().includes('tornado');

  return (
    <div className="rounded border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs uppercase tracking-wider text-slate-400">Deployer</span>
        <a
          href={explorerUrl(chain, info.address)}
          target="_blank"
          rel="noreferrer"
          className="mono text-emerald-400 hover:underline"
          title={info.address}
        >
          {short(info.address)}
        </a>
        {isSerialLauncher && (
          <span
            className="px-2 py-0.5 rounded bg-red-900/40 text-red-300 text-[11px]"
            title="This wallet has deployed many contracts — common pattern for serial ruggers / launchpad bots."
          >
            serial launcher
          </span>
        )}
        {isFresh && (
          <span
            className="px-2 py-0.5 rounded bg-amber-900/40 text-amber-300 text-[11px]"
            title="The dev wallet itself was created very recently."
          >
            fresh dev
          </span>
        )}
        {isMixerFunded && (
          <span
            className="px-2 py-0.5 rounded bg-red-900/40 text-red-300 text-[11px]"
            title="Dev was funded from a mixer — they're trying to hide their origin."
          >
            mixer-funded
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 text-xs">
        <Stat label="Funded by" value={info.fundingSource ?? '—'} />
        <Stat
          label="Funded"
          value={info.fundingTime ? `${ago(info.fundingTime)} ago` : '—'}
        />
        <Stat
          label="Wallet age"
          value={info.ageDays === null ? '—' : `${info.ageDays} days`}
        />
        <Stat
          label="Total txs"
          value={info.txCount === null ? '—' : info.txCount.toLocaleString()}
        />
        <Stat label="Balance" value={fmtBal(info.nativeBalance, nativeSym)} />
        <Stat
          label="Contracts deployed"
          value={
            info.deploysFound === null
              ? '—'
              : info.deploysCapped
                ? `${info.deploysFound}+ (scan capped)`
                : info.deploysFound.toLocaleString()
          }
          tone={info.deploysFound !== null && info.deploysFound >= 5 ? 'warn' : 'normal'}
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = 'normal'
}: {
  label: string;
  value: string;
  tone?: 'normal' | 'warn';
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mono mt-0.5 ${tone === 'warn' ? 'text-amber-300' : 'text-slate-200'}`}>{value}</div>
    </div>
  );
}
