import React, { useState } from 'react';
import type { AccessState } from '../../shared/types';

// Full-screen gate shown until the app verifies this install is on the operator's
// allowlist. Lets a new user enter their access code, and shows a clear locked
// state when revoked or offline-too-long.
export default function AccessGate({
  state,
  onSubmitCode,
  onRetry
}: {
  state: AccessState | null;
  onSubmitCode: (code: string) => Promise<void>;
  onRetry: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const status = state?.status ?? 'checking';

  async function submit() {
    const c = code.trim();
    if (!c || busy) return;
    setBusy(true);
    try {
      await onSubmitCode(c);
    } finally {
      setBusy(false);
    }
  }

  const showEntry = status === 'unconfigured' || status === 'revoked';

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 px-6">
      <div className="w-full max-w-md rounded-lg border border-slate-800 bg-slate-900/60 p-8 space-y-5">
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold text-slate-100">Defi Dashboard</h1>
          <StatusLine status={status} message={state?.message} />
        </div>

        {status === 'checking' && (
          <div className="flex flex-col items-center gap-3 py-2">
            <div className="h-6 w-6 rounded-full border-2 border-slate-700 border-t-emerald-500 animate-spin" />
            <button onClick={onRetry} className="text-xs text-slate-500 hover:text-slate-300 underline">Retry now</button>
          </div>
        )}

        {status === 'stale' && (
          <div className="flex justify-center">
            <button
              onClick={onRetry}
              className="px-4 py-2 rounded text-sm bg-emerald-600 hover:bg-emerald-500 text-white"
            >
              Re-check access
            </button>
          </div>
        )}

        {showEntry && (
          <div className="space-y-2">
            <label className="text-[11px] uppercase tracking-wider text-slate-500">Access code</label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              placeholder="Paste the code you were given"
              spellCheck={false}
              autoFocus
              className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm text-slate-200 font-mono focus:border-emerald-500 outline-none"
            />
            <button
              onClick={submit}
              disabled={busy || !code.trim()}
              className="w-full px-4 py-2 rounded text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40"
            >
              {busy ? 'Verifying…' : status === 'revoked' ? 'Try a different code' : 'Activate'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusLine({ status, message }: { status: AccessState['status']; message?: string }) {
  if (message) return <p className="text-sm text-slate-400">{message}</p>;
  switch (status) {
    case 'checking':
      return <p className="text-sm text-slate-400">Verifying access…</p>;
    case 'unconfigured':
      return <p className="text-sm text-slate-400">Enter your access code to activate this device.</p>;
    case 'revoked':
      return <p className="text-sm text-rose-300">Access to this app has been revoked. Contact the owner for a code.</p>;
    case 'stale':
      return <p className="text-sm text-amber-300">Couldn’t verify access (offline too long). Reconnect to continue.</p>;
    default:
      return null;
  }
}
