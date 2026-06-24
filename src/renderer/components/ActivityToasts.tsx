import React, { useEffect, useRef, useState } from 'react';
import type { TrackedActivity } from '../../shared/types';
import { appendActivity } from '../lib/activityHistory';

interface Toast extends TrackedActivity {
  key: string;
}

const DISMISS_MS = 12_000;
const MAX_TOASTS = 5;

function shortMint(a: string): string {
  return a.length <= 12 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  if (Math.abs(n) >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

// Pop-up notifications at the top of the app when a tracked wallet buys or sells.
export default function ActivityToasts({ onClickContract }: { onClickContract: (mint: string) => void }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Record<string, number>>({});

  useEffect(() => {
    const off = window.api.onTrackedActivity((a) => {
      appendActivity(a); // persist to the Tracked Wallets activity history
      const key = `${a.id}-${Date.now()}`;
      setToasts((prev) => [{ ...a, key }, ...prev].slice(0, MAX_TOASTS));
      timers.current[key] = window.setTimeout(() => dismiss(key), DISMISS_MS);
    });
    return () => {
      off();
      Object.values(timers.current).forEach((t) => window.clearTimeout(t));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function dismiss(key: string) {
    setToasts((prev) => prev.filter((t) => t.key !== key));
    const t = timers.current[key];
    if (t) {
      window.clearTimeout(t);
      delete timers.current[key];
    }
  }

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[60] w-[380px] max-w-[90vw] space-y-2 pointer-events-none">
      {toasts.map((t) => {
        const buy = t.action === 'buy';
        const token = t.tokenSymbol || shortMint(t.tokenMint);
        const native = t.nativeAmount !== null ? `${fmt(t.nativeAmount)} ${t.nativeSymbol}` : null;
        const amt = t.tokenAmount !== null ? fmt(t.tokenAmount) : null;
        return (
          <div
            key={t.key}
            onClick={() => onClickContract(t.tokenMint)}
            title="Look up this token"
            className={`pointer-events-auto cursor-pointer rounded border bg-slate-900/95 backdrop-blur px-3 py-2 shadow-lg shadow-black/40 ${
              buy ? 'border-emerald-600/70' : 'border-rose-600/70'
            }`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                  buy ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'
                }`}
              >
                {buy ? 'Buy' : 'Sell'}
              </span>
              <span className="text-sm text-slate-100 font-medium truncate">{t.label}</span>
              <span className="text-xs text-slate-500" title={t.chain}>
                {t.chain === 'solana' ? '◎' : 'Ξ'}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  dismiss(t.key);
                }}
                className="ml-auto text-slate-600 hover:text-slate-300 text-sm leading-none"
              >
                ✕
              </button>
            </div>
            <div className="mt-0.5 text-xs text-slate-300">
              {buy ? 'bought' : 'sold'} <span className="font-semibold text-slate-100">{token}</span>
              {amt && <span className="text-slate-500"> · {amt}</span>}
              {native && <span className="text-slate-500"> for {native}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
