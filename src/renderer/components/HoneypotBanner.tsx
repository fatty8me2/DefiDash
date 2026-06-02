import React from 'react';
import type { HoneypotReport } from '../../shared/types';

export default function HoneypotBanner({ report }: { report: HoneypotReport | 'loading' | null }) {
  if (report === null) return null;
  if (report === 'loading') {
    return (
      <div className="rounded border border-slate-800 bg-slate-900/40 px-4 py-2 text-xs text-slate-500">
        Checking contract safety…
      </div>
    );
  }

  const palette = {
    safe: { bg: 'bg-emerald-900/25 border-emerald-700/60', text: 'text-emerald-300', icon: '✓', label: 'Looks safe' },
    caution: { bg: 'bg-amber-900/25 border-amber-700/60', text: 'text-amber-300', icon: '⚠', label: 'Caution' },
    danger: { bg: 'bg-red-900/30 border-red-700/60', text: 'text-red-300', icon: '🚨', label: 'High risk' },
    unknown: { bg: 'bg-slate-900/40 border-slate-700', text: 'text-slate-400', icon: '?', label: 'Unknown' }
  }[report.verdict];

  return (
    <div className={`rounded border ${palette.bg} px-4 py-3 text-sm space-y-3`}>
      {/* Header row */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`font-semibold ${palette.text}`}>
          {palette.icon} {palette.label}
        </span>
        {report.isHoneypot && (
          <span className="px-2 py-0.5 rounded bg-red-900/50 text-red-200 text-xs font-medium">HONEYPOT</span>
        )}
        {report.trustList === true && (
          <span
            className="px-2 py-0.5 rounded bg-emerald-900/50 text-emerald-200 text-xs font-medium"
            title="GoPlus-curated established token (USDC, USDT, WETH, etc.). Proxy / blacklist / freeze functions here are expected for compliance."
          >
            ⭐ TRUSTED
          </span>
        )}
        <span
          className="text-slate-400 text-xs"
          title="Weighted risk score. ≥100 = danger, ≥30 = caution, otherwise safe."
        >
          risk <span className="mono">{report.riskScore}</span>
        </span>
        <span className="text-slate-500 text-xs ml-auto">via {report.source}</span>
      </div>

      {/* Numeric stats */}
      <div className="flex items-center gap-x-5 gap-y-1 flex-wrap text-xs">
        <LiquidityStat value={report.liquidityUsd} />
        {report.volume24hUsd !== null && (
          <span>
            <span className="text-slate-500">24h vol: </span>
            <span className="mono text-slate-200">{fmtUsd(report.volume24hUsd)}</span>
          </span>
        )}
        {report.mainPairLabel && (
          <span className="text-slate-500 text-xs">
            via <span className="text-slate-300">{report.mainPairLabel}</span>
            {report.pairAgeDays !== null && (
              <span className="text-slate-500"> · {report.pairAgeDays}d old</span>
            )}
          </span>
        )}
        {report.chain === 'ethereum' && (
          <>
            <NumStat label="Buy tax" value={report.buyTaxPct} suffix="%" warnAt={10} dangerAt={25} />
            <NumStat label="Sell tax" value={report.sellTaxPct} suffix="%" warnAt={10} dangerAt={25} />
          </>
        )}
        {report.chain === 'solana' && report.transferTaxPct !== null && (
          <NumStat label="Transfer fee" value={report.transferTaxPct} suffix="%" warnAt={1} dangerAt={10} />
        )}
        <NumStat label="Top wallet" value={report.topHolderPct} suffix="%" warnAt={25} dangerAt={50} />
        {report.holderCount !== null && (
          <span>
            <span className="text-slate-500">Holders: </span>
            <span className={`mono ${report.holderCount < 50 ? 'text-amber-300' : 'text-slate-200'}`}>
              {report.holderCount.toLocaleString()}
            </span>
          </span>
        )}
      </div>

      {/* Signal chips */}
      <div className="flex flex-wrap gap-1.5">
        {report.chain === 'ethereum' && (
          <>
            <Chip label="Verified" state={polarityGood(report.contractVerified)} />
            <Chip label="Ownership renounced" state={polarityGood(report.ownershipRenounced)} />
            <Chip label="LP locked" state={polarityGood(report.liquidityLocked)} />
            <Chip label="Mintable" state={polarityBad(report.isMintable)} />
            <Chip label="Proxy" state={polarityBad(report.isProxy)} />
            <Chip label="Pausable" state={polarityBad(report.transferPausable)} />
            <Chip label="Blacklist" state={polarityBad(report.hasBlacklist)} />
            <Chip label="Modifiable tax" state={polarityBad(report.taxModifiable)} />
            <Chip label="Per-wallet tax" state={polarityBad(report.perWalletTaxModifiable)} />
            <Chip label="Hidden owner" state={polarityBad(report.hiddenOwner)} />
            <Chip label="Self-destruct" state={polarityBad(report.canSelfDestruct)} />
            <Chip label="Reclaimable ownership" state={polarityBad(report.canTakeBackOwnership)} />
            <Chip label="Owner can edit balances" state={polarityBad(report.ownerChangeBalance)} />
            <Chip label="Trading cooldown" state={polarityBad(report.tradingCooldown)} />
            <Chip label="Cannot buy" state={polarityBad(report.cannotBuy)} />
            <Chip label="Cannot sell all" state={polarityBad(report.cannotSellAll)} />
          </>
        )}
        {report.chain === 'solana' && (
          <>
            <Chip label="Mint authority renounced" state={polarityGood(invert(report.mintAuthorityActive))} />
            <Chip label="Freeze authority renounced" state={polarityGood(invert(report.freezeAuthorityActive))} />
            <Chip label="Transfer fee upgradable" state={polarityBad(report.transferFeeUpgradable)} />
          </>
        )}
      </div>

      {/* Bullet list of risk flags */}
      {report.flags.length > 0 && (
        <ul className="space-y-1 text-xs text-slate-300 pt-1 border-t border-slate-800">
          {report.flags.map((f, i) => (
            <li key={i} className={`pl-3 border-l-2 ${report.verdict === 'danger' ? 'border-red-500' : 'border-amber-500'}`}>
              {f}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// "state" semantics for a chip:
//   'good'    = green dot + label
//   'bad'     = red dot + label
//   'unknown' = gray dot + label (faded)
type ChipState = 'good' | 'bad' | 'unknown';

// For fields where true = good (e.g. "Verified: true" is good).
function polarityGood(v: boolean | null): ChipState {
  if (v === true) return 'good';
  if (v === false) return 'bad';
  return 'unknown';
}

// For fields where true = bad (e.g. "Mintable: true" is bad).
function polarityBad(v: boolean | null): ChipState {
  if (v === true) return 'bad';
  if (v === false) return 'good';
  return 'unknown';
}

function invert(v: boolean | null): boolean | null {
  if (v === null) return null;
  return !v;
}

function Chip({ label, state }: { label: string; state: ChipState }) {
  const dot = {
    good: 'bg-emerald-400',
    bad: 'bg-red-400',
    unknown: 'bg-slate-600'
  }[state];
  const text = {
    good: 'text-slate-200',
    bad: 'text-red-300',
    unknown: 'text-slate-500'
  }[state];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-slate-800 bg-slate-900/60 text-[11px] ${text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const v = Math.abs(n);
  if (v >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (v < 1) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString()}`;
}

function LiquidityStat({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <span>
        <span className="text-slate-500">Liquidity: </span>
        <span className="mono text-slate-500">—</span>
      </span>
    );
  }
  const color =
    value < 2_000 ? 'text-red-300' :
    value < 5_000 ? 'text-amber-300' :
    'text-emerald-300';
  return (
    <span>
      <span className="text-slate-500">Liquidity: </span>
      <span className={`mono font-medium ${color}`}>{fmtUsd(value)}</span>
    </span>
  );
}

function NumStat({
  label,
  value,
  suffix,
  warnAt,
  dangerAt
}: {
  label: string;
  value: number | null;
  suffix: string;
  warnAt: number;
  dangerAt: number;
}) {
  if (value === null) return null;
  const color =
    value >= dangerAt ? 'text-red-300' : value >= warnAt ? 'text-amber-300' : 'text-slate-200';
  return (
    <span>
      <span className="text-slate-500">{label}: </span>
      <span className={`mono ${color}`}>
        {value.toFixed(value < 1 && value > 0 ? 2 : 0)}
        {suffix}
      </span>
    </span>
  );
}
