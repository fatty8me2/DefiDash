import React from 'react';
import type { ChangelogEntry } from '../lib/changelog';

interface Props {
  version: string;
  entries: ChangelogEntry[];
  onClose: () => void;
}

export default function WhatsNewModal({ version, entries, onClose }: Props) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md max-h-[80vh] flex flex-col rounded-lg border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">🎉 What&apos;s new</h2>
            <p className="text-xs text-slate-500 mt-0.5">Defi Dashboard v{version}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-200 text-xl leading-none px-1">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {entries.map((e) => (
            <div key={e.version}>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400 mb-1.5">v{e.version}</div>
              <ul className="space-y-1.5">
                {e.highlights.map((h, i) => (
                  <li key={i} className="flex gap-2 text-sm text-slate-300">
                    <span className="text-emerald-500 shrink-0">•</span>
                    <span>{h}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-slate-800 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
