import React, { useEffect, useRef, useState } from 'react';
import type { AppSettings, LiveFeedItem, LiveFeedSnapshot } from '../../shared/types';
import TrendingPanel from './TrendingPanel';
import CopyButton from './CopyButton';

const MAX_ITEMS = 50;

interface Props {
  onClickContract?: (contract: string) => void;
  hasEtherscanKey: boolean;
  settings: AppSettings | null;
}

// Static class strings (so Tailwind doesn't purge them) keyed by visible-panel count.
const GRID_COLS: Record<number, string> = {
  1: 'md:grid-cols-1 lg:grid-cols-1',
  2: 'md:grid-cols-2 lg:grid-cols-2',
  3: 'md:grid-cols-2 lg:grid-cols-3'
};

export default function LiveFeeds({ onClickContract, hasEtherscanKey, settings }: Props) {
  const [v2Items, setV2Items] = useState<LiveFeedItem[]>([]);
  const [verifiedItems, setVerifiedItems] = useState<LiveFeedItem[]>([]);
  const [v2Status, setV2Status] = useState<string>('idle');
  const [verifiedStatus, setVerifiedStatus] = useState<string>('idle');
  const v2KeysRef = useRef(new Set<string>());

  useEffect(() => {
    window.api.startFeeds();

    // Merge a snapshot of the main-process rolling buffers into local state so
    // the panels show recent history without starting blank. Merge (rather than
    // overwrite) so any live event that arrived in between isn't lost; existing
    // items are newest so they stay on top.
    const applySnapshot = (snap: LiveFeedSnapshot) => {
      setV2Items((prev) => {
        const seen = new Set<string>();
        const merged: LiveFeedItem[] = [];
        for (const it of [...prev, ...snap.v2]) {
          const k = it.pair.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          merged.push(it);
        }
        v2KeysRef.current = seen;
        return merged.slice(0, MAX_ITEMS);
      });
      setVerifiedItems((prev) => {
        const seen = new Set<string>();
        const merged: LiveFeedItem[] = [];
        for (const it of [...prev, ...snap.verified]) {
          const k = it.contract.toLowerCase();
          if (seen.has(k)) continue;
          seen.add(k);
          merged.push(it);
        }
        return merged.slice(0, MAX_ITEMS);
      });
      if (snap.v2Status) setV2Status((s) => (s === 'idle' ? snap.v2Status : s));
      if (snap.verifiedStatus) setVerifiedStatus((s) => (s === 'idle' ? snap.verifiedStatus : s));
    };

    // Pull the current buffer on mount...
    window.api.feedsSnapshot().then(applySnapshot).catch(() => { /* live events will fill in */ });
    // ...and accept pushes from the main process (e.g. when the cold-start
    // backfill finishes after this initial pull already returned an empty buffer).
    const offSnapshot = window.api.onFeedsSnapshot(applySnapshot);

    const offDeploy = window.api.onV2Deploy((item) => {
      const key = item.pair.toLowerCase();
      if (v2KeysRef.current.has(key)) return;
      v2KeysRef.current.add(key);
      setV2Items((prev) => [item, ...prev].slice(0, MAX_ITEMS));
    });

    const offUpdate = window.api.onV2DeployUpdate((item) => {
      setV2Items((prev) =>
        prev.map((p) => (p.pair.toLowerCase() === item.pair.toLowerCase() ? { ...p, ...item } : p))
      );
    });

    const offStatus = window.api.onV2Status((s) => setV2Status(s));
    const offVerifiedStatus = window.api.onVerifiedStatus((s) => setVerifiedStatus(s));

    const offVerified = window.api.onVerifiedLaunch((item) => {
      setVerifiedItems((prev) => {
        if (prev.some((p) => p.contract.toLowerCase() === item.contract.toLowerCase())) return prev;
        return [item, ...prev].slice(0, MAX_ITEMS);
      });
    });

    return () => {
      offSnapshot();
      offDeploy();
      offUpdate();
      offStatus();
      offVerifiedStatus();
      offVerified();
    };
  }, []);

  // Default everything on until settings load.
  const showVerified = settings ? settings.feedVerifiedEnabled : true;
  const showV2 = settings ? settings.feedV2Enabled : true;
  const showTrending = settings ? settings.feedTrendingEnabled : true;
  const visibleCount = [showVerified, showV2, showTrending].filter(Boolean).length;

  if (visibleCount === 0) {
    return (
      <div className="rounded border border-slate-800 bg-slate-900/40 px-4 py-3 text-xs text-slate-500">
        All live feeds are disabled. Enable them in Settings.
      </div>
    );
  }

  return (
    <div className={`grid grid-cols-1 ${GRID_COLS[visibleCount] ?? GRID_COLS[3]} gap-3`}>
      {showVerified && (
        <FeedPanel
          title="Verified Launches"
          subtitle="ERC-20 with verified source"
          items={verifiedItems}
          status={!hasEtherscanKey ? 'no-key' : normalizeStatus(verifiedStatus)}
          accent="emerald"
          onClickContract={onClickContract}
          showVerifiedTime
        />
      )}
      {showV2 && (
        <FeedPanel
          title="V2 Deploys"
          subtitle="Live Uniswap V2 PairCreated"
          items={v2Items}
          status={normalizeStatus(v2Status)}
          accent="sky"
          onClickContract={onClickContract}
        />
      )}
      {showTrending && (
        <TrendingPanel
          onClickContract={onClickContract}
          refreshSec={settings?.trendingRefreshSec ?? 30}
          maxFdvUsd={settings?.trendingMaxFdvUsd ?? 0}
          minLiqUsd={settings?.trendingMinLiqUsd ?? 0}
        />
      )}
    </div>
  );
}

function FeedPanel({
  title,
  subtitle,
  items,
  status,
  accent,
  onClickContract,
  showVerifiedTime
}: {
  title: string;
  subtitle: string;
  items: LiveFeedItem[];
  status: string;
  accent: 'emerald' | 'sky';
  onClickContract?: (contract: string) => void;
  showVerifiedTime?: boolean;
}) {
  const dotColor =
    status === 'live' ? `bg-${accent}-400`
    : status === 'reconnecting' || status === 'connecting' ? 'bg-amber-400'
    : status === 'no-key' ? 'bg-slate-600'
    : 'bg-red-500';

  return (
    <div className="rounded border border-slate-800 bg-slate-900/40 flex flex-col" style={{ height: 280 }}>
      <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-100">{title}</div>
          <div className="text-[11px] text-slate-500">{subtitle}</div>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-slate-400">
          <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
          {status === 'no-key' ? 'add etherscan key' : status}
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {items.length === 0 ? (
          <div className="text-xs text-slate-500 px-3 py-6 text-center">
            {status === 'no-key'
              ? 'Add an Etherscan API key in Settings to enable this feed.'
              : 'Waiting for the next deploy…'}
          </div>
        ) : (
          <ul className="divide-y divide-slate-800/60">
            {items.map((item) => (
              <FeedRow
                key={item.pair || item.contract}
                item={item}
                onClickContract={onClickContract}
                showVerifiedTime={showVerifiedTime}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FeedRow({
  item,
  onClickContract,
  showVerifiedTime
}: {
  item: LiveFeedItem;
  onClickContract?: (contract: string) => void;
  showVerifiedTime?: boolean;
}) {
  // Always show the launch (deploy) time so it's accurate for backfilled items;
  // the ✓ marks that the source is verified. Using verifiedAt here would show
  // "just now" for tokens that launched hours ago but were only checked on startup.
  const stamp = item.blockTime;
  const verified = !!(showVerifiedTime && item.verifiedAt);

  return (
    <li
      className="px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-slate-800/40 cursor-pointer"
      onClick={() => onClickContract?.(item.contract)}
      title="Click to look up buyers for this token"
    >
      <span className="text-slate-200 font-medium truncate max-w-[26%]">
        {item.symbol ?? '…'}
      </span>
      <CopyButton value={item.contract} />
      <span className="text-slate-500 truncate max-w-[30%]">
        {item.name ?? ''}
      </span>
      <span className="ml-auto mono text-slate-500">{shortAddr(item.contract)}</span>
      <span className="text-slate-500 w-16 text-right">{timeAgo(stamp)} {verified ? '✓' : ''}</span>
    </li>
  );
}

function normalizeStatus(s: string): string {
  if (s === 'connected') return 'live';
  if (s === 'disconnected') return 'reconnecting';
  if (s === 'idle') return 'starting';
  return s;
}

function shortAddr(a: string): string {
  if (a.length <= 10) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function timeAgo(unixSeconds: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}
