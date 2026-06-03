import React, { useEffect, useState } from 'react';
import type { AppSettings } from '../../shared/types';

const DEFAULTS: AppSettings = {
  alchemyKey: '',
  heliusKey: '',
  etherscanKey: '',
  cieloKey: '',
  defaultBuyers: 50,
  feedV2Enabled: true,
  feedVerifiedEnabled: true,
  feedTrendingEnabled: true,
  trendingRefreshSec: 30,
  trendingMaxFdvUsd: 0,
  trendingMinLiqUsd: 0,
  launchOnStartup: false,
  notifyVerified: false
};

export default function SettingsModal({
  open,
  onClose,
  onSaved
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [s, setS] = useState<AppSettings>(DEFAULTS);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState('');
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!open) return;
    window.api.getSettings().then((loaded) => setS({ ...DEFAULTS, ...loaded }));
    window.api.appVersion().then(setVersion).catch(() => setVersion(''));
  }, [open]);

  if (!open) return null;

  async function checkUpdates() {
    setChecking(true);
    try {
      await window.api.checkForUpdates();
    } finally {
      setChecking(false);
    }
  }

  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setS((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    setSaving(true);
    try {
      await window.api.saveSettings(s);
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-700 rounded-lg w-full max-w-lg max-h-[88vh] overflow-y-auto p-6 space-y-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 pb-4 border-b border-slate-800">
          <div>
            <h1 className="text-base font-semibold text-slate-100">Settings</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              {version ? `Wallet Lookup v${version}` : 'Wallet Lookup'}
            </p>
          </div>
          <button
            onClick={checkUpdates}
            disabled={checking}
            className="px-3 py-1.5 rounded text-sm border border-slate-700 text-slate-200 hover:border-emerald-600 hover:text-emerald-300 disabled:opacity-50 disabled:hover:border-slate-700 disabled:hover:text-slate-200"
          >
            {checking ? 'Checking…' : 'Check for updates'}
          </button>
        </div>

        <Section title="API Keys" subtitle="Stored encrypted on this machine via the OS keychain. Never sent anywhere except the providers themselves.">
          <Field
            label="Alchemy API Key"
            value={s.alchemyKey}
            onChange={(v) => set('alchemyKey', v)}
            placeholder="e.g. g3c2fHpFBZ…"
            help={
              <>
                Used for Ethereum lookups. Free key at{' '}
                <a href="https://dashboard.alchemy.com" target="_blank" rel="noreferrer" className="text-emerald-400 hover:underline">dashboard.alchemy.com</a>.
              </>
            }
          />
          <Field
            label="Helius API Key"
            value={s.heliusKey}
            onChange={(v) => set('heliusKey', v)}
            placeholder="e.g. 822ebb92-11e0-…"
            help={
              <>
                Used for Solana lookups. Free key at{' '}
                <a href="https://dev.helius.xyz" target="_blank" rel="noreferrer" className="text-emerald-400 hover:underline">dev.helius.xyz</a>.
              </>
            }
          />
          <Field
            label="Etherscan API Key (optional)"
            value={s.etherscanKey}
            onChange={(v) => set('etherscanKey', v)}
            placeholder="e.g. ABCD1234…"
            help={
              <>
                Powers the "Verified Launches" feed. Free key at{' '}
                <a href="https://etherscan.io/myapikey" target="_blank" rel="noreferrer" className="text-emerald-400 hover:underline">etherscan.io/myapikey</a>.
              </>
            }
          />
          <Field
            label="Cielo API Key (optional)"
            value={s.cieloKey}
            onChange={(v) => set('cieloKey', v)}
            placeholder="e.g. cielo_…"
            help={
              <>
                Adds smart-money PnL & win-rate to the wallet Score column. Get one at{' '}
                <a href="https://app.cielo.finance" target="_blank" rel="noreferrer" className="text-emerald-400 hover:underline">app.cielo.finance</a>.
              </>
            }
          />
        </Section>

        <Section title="Lookup">
          <div>
            <label className="text-xs uppercase tracking-wider text-slate-400">Default buyers to fetch</label>
            <div className="mt-1.5 flex gap-2">
              {[50, 100, 200].map((n) => (
                <button
                  key={n}
                  onClick={() => set('defaultBuyers', n)}
                  className={`px-3 py-1.5 rounded text-sm border ${
                    s.defaultBuyers === n
                      ? 'border-emerald-500 text-emerald-300 bg-emerald-500/10'
                      : 'border-slate-700 text-slate-400 hover:border-slate-500'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-500 mt-1">How many recent buyers each lookup pulls. Higher = slower.</p>
          </div>
        </Section>

        <Section title="Live Feeds">
          <Toggle label="V2 Deploys feed" checked={s.feedV2Enabled} onChange={(v) => set('feedV2Enabled', v)} />
          <Toggle label="Verified Launches feed" checked={s.feedVerifiedEnabled} onChange={(v) => set('feedVerifiedEnabled', v)} help="Requires an Etherscan key." />
          <Toggle label="Hot Tokens (trending) panel" checked={s.feedTrendingEnabled} onChange={(v) => set('feedTrendingEnabled', v)} />
          <NumField
            label="Trending refresh (seconds)"
            value={s.trendingRefreshSec}
            onChange={(v) => set('trendingRefreshSec', v)}
            min={10}
            max={300}
            help="How often the Hot Tokens panel reloads (10–300s)."
          />
        </Section>

        <Section title="Trending low-cap filter" subtitle="Hide tokens outside your range. Set 0 to disable a limit.">
          <NumField
            label="Max FDV (USD)"
            value={s.trendingMaxFdvUsd}
            onChange={(v) => set('trendingMaxFdvUsd', v)}
            min={0}
            placeholder="0 = no cap"
            help="Hide tokens with fully-diluted valuation above this."
          />
          <NumField
            label="Min liquidity (USD)"
            value={s.trendingMinLiqUsd}
            onChange={(v) => set('trendingMinLiqUsd', v)}
            min={0}
            placeholder="0 = no floor"
            help="Hide tokens with liquidity below this."
          />
        </Section>

        <Section title="System">
          <Toggle label="Launch on system startup" checked={s.launchOnStartup} onChange={(v) => set('launchOnStartup', v)} />
          <Toggle label="Desktop notification on new verified launch" checked={s.notifyVerified} onChange={(v) => set('notifyVerified', v)} />
        </Section>

        <div className="flex justify-end gap-2 pt-2 sticky bottom-0 bg-slate-900">
          <button onClick={onClose} className="px-4 py-2 rounded text-sm text-slate-300 hover:bg-slate-800">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 rounded text-sm font-medium bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-700 text-white"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-200">{title}</h2>
        {subtitle && <p className="text-xs text-slate-400 mt-1">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  help
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  help: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs uppercase tracking-wider text-slate-400">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mono mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm placeholder-slate-600 focus:outline-none focus:border-emerald-600"
      />
      <p className="text-xs text-slate-500 mt-1">{help}</p>
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
  min,
  max,
  placeholder,
  help
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  placeholder?: string;
  help?: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-xs uppercase tracking-wider text-slate-400">{label}</label>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
        placeholder={placeholder}
        className="mono mt-1 w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm placeholder-slate-600 focus:outline-none focus:border-emerald-600"
      />
      {help && <p className="text-xs text-slate-500 mt-1">{help}</p>}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  help
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  help?: string;
}) {
  return (
    <div>
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          onClick={() => onChange(!checked)}
          className={`relative w-9 h-5 rounded-full transition-colors ${checked ? 'bg-emerald-600' : 'bg-slate-700'}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : ''}`}
          />
        </button>
        <span className="text-sm text-slate-200">{label}</span>
      </label>
      {help && <p className="text-xs text-slate-500 mt-1 ml-11">{help}</p>}
    </div>
  );
}
