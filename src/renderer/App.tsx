import React, { useEffect, useState } from 'react';
import SearchBar from './components/SearchBar';
import BuyersTable from './components/BuyersTable';
import SettingsModal from './components/SettingsModal';
import HoneypotBanner from './components/HoneypotBanner';
import DevWalletPanel from './components/DevWalletPanel';
import LiveFeeds from './components/LiveFeeds';
import LaunchAnalysisPanel from './components/LaunchAnalysisPanel';
import PumpFlowPage from './components/PumpFlowPage';
import EvmFlowPage from './components/EvmFlowPage';
import CopyButton from './components/CopyButton';
import DexScreenerButton from './components/DexScreenerButton';
import type { AppSettings, BuyerRow, DevWalletInfo, HoneypotReport, LookupResult } from '../shared/types';
import { isFreshWallet } from './lib/freshWallet';

interface ConfigStatus {
  hasAlchemy: boolean;
  hasHelius: boolean;
  hasEtherscan: boolean;
  hasCielo: boolean;
  hasBitquery: boolean;
}

type View = 'dashboard' | 'flow' | 'evmflow';

export default function App() {
  const [result, setResult] = useState<LookupResult | null>(null);
  const [honeypot, setHoneypot] = useState<HoneypotReport | 'loading' | null>(null);
  const [devInfo, setDevInfo] = useState<DevWalletInfo | 'loading' | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<ConfigStatus | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<View>('dashboard');

  function refreshConfig() {
    window.api.configStatus().then(setConfig);
    window.api.getSettings().then(setSettings);
  }

  useEffect(() => {
    refreshConfig();
    // Clicking a "new verified launch" desktop notification jumps straight to a lookup.
    const off = window.api.onNotifyOpen((contract) => runLookup(contract));
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runLookup(contract: string, limit?: number) {
    const effectiveLimit = limit ?? settings?.defaultBuyers;
    setLoading(true);
    setError(null);
    setResult(null);
    setHoneypot(null);
    setDevInfo(null);
    try {
      const res = await window.api.lookupBuyers(contract, effectiveLimit);
      setResult(res);
      setHoneypot('loading');
      setDevInfo('loading');
      window.api
        .honeypotCheck(res.chain, res.contract)
        .then((report) => {
          setHoneypot(report);
          // Fire the dev lookup once we know the creator (or directly for Solana via DAS).
          window.api
            .devWalletInfo(res.chain, res.contract, report.creatorAddress)
            .then(setDevInfo)
            .catch(() => setDevInfo(null));
        })
        .catch(() => {
          setHoneypot(null);
          setDevInfo(null);
        });
      res.buyers.forEach((buyer, idx) => {
        setTimeout(() => {
          window.api.enrichWallet(res.chain, buyer.wallet, res.contract, buyer.tokenAmount).then((enrichment) => {
            setResult((prev) => {
              if (!prev) return prev;
              const next = [...prev.buyers];
              next[idx] = { ...next[idx], ...enrichment } as BuyerRow;
              return { ...prev, buyers: next };
            });
          });
        }, idx * 40);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const keysMissing = config !== null && (!config.hasAlchemy || !config.hasHelius);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-5">
          <div>
            <h1 className="text-lg font-semibold">Defi Dashboard</h1>
            <p className="text-xs text-slate-400">Last 50 buyers of any ERC-20 or SPL token · click a row to inspect the wallet</p>
          </div>
          <nav className="flex gap-1">
            <NavTab label="Dashboard" active={view === 'dashboard'} onClick={() => setView('dashboard')} />
            <NavTab label="Pump Flow" active={view === 'flow'} onClick={() => setView('flow')} />
            <NavTab label="ETH Flow" active={view === 'evmflow'} onClick={() => setView('evmflow')} />
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {config && <ConfigBadge config={config} />}
          <button
            onClick={() => setSettingsOpen(true)}
            className="text-xs px-3 py-1.5 rounded border border-slate-700 hover:border-slate-500 text-slate-300"
          >
            ⚙ Settings
          </button>
        </div>
      </header>

      {view === 'dashboard' && (
        <div className="px-6 py-4 border-b border-slate-800">
          <SearchBar onSubmit={runLookup} loading={loading || keysMissing} />
        </div>
      )}

      <main className="flex-1 overflow-auto px-6 py-4 space-y-4">
        {view === 'flow' ? (
          <PumpFlowPage
            hasBitqueryToken={!!config?.hasBitquery}
            onClickContract={(mint) => {
              setView('dashboard');
              runLookup(mint);
            }}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : view === 'evmflow' ? (
          <EvmFlowPage
            hasBitqueryToken={!!config?.hasBitquery}
            onClickContract={(addr) => {
              setView('dashboard');
              runLookup(addr);
            }}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        ) : (
          <>
            {keysMissing && !result && <Welcome onOpenSettings={() => setSettingsOpen(true)} />}

            {!keysMissing && config?.hasAlchemy && (
              <LiveFeeds
                hasEtherscanKey={!!config.hasEtherscan}
                onClickContract={(c) => runLookup(c)}
                settings={settings}
              />
            )}

            {error && (
              <div className="rounded border border-red-700 bg-red-900/30 px-4 py-3 text-sm text-red-200">
                {error}
              </div>
            )}

            {!keysMissing && !error && !result && !loading && (
              <div className="text-slate-500 text-sm">
                Paste a token contract above, or click a row in the live feeds. ETH addresses
                (<span className="mono">0x…</span>) and Solana mints are auto-detected.
              </div>
            )}

            {loading && <div className="text-slate-400 text-sm">Fetching buyers…</div>}

            {result && (
              <div className="space-y-4">
                <ResultsHeader
                  result={result}
                  onExpand={() => runLookup(result.contract, 200)}
                />
                <HoneypotBanner report={honeypot} />
                <DevWalletPanel info={devInfo} chain={result.chain} />
                <LaunchAnalysisPanel key={result.contract} chain={result.chain} contract={result.contract} />
                <BuyersTable result={result} />
              </div>
            )}
          </>
        )}
      </main>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={refreshConfig}
      />
    </div>
  );
}

function NavTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded text-sm border ${
        active
          ? 'border-emerald-500 text-emerald-300 bg-emerald-500/10'
          : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-700'
      }`}
    >
      {label}
    </button>
  );
}

function Welcome({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="max-w-2xl mx-auto mt-12 border border-slate-800 rounded-lg p-6 bg-slate-900/40">
      <h2 className="text-lg font-semibold text-slate-100">Welcome 👋</h2>
      <p className="text-sm text-slate-300 mt-2">
        Before you can look up tokens, you need free API keys for the two chain providers this app uses.
      </p>
      <ol className="text-sm text-slate-300 mt-4 space-y-2 list-decimal pl-5">
        <li>
          Grab a free <a className="text-emerald-400 hover:underline" href="https://dashboard.alchemy.com" target="_blank" rel="noreferrer">Alchemy</a> key
          (for Ethereum lookups). Sign up → New App → copy the API key.
        </li>
        <li>
          Grab a free <a className="text-emerald-400 hover:underline" href="https://dev.helius.xyz" target="_blank" rel="noreferrer">Helius</a> key
          (for Solana lookups). Sign up → API Keys → copy.
        </li>
        <li>
          Paste both into <button onClick={onOpenSettings} className="underline text-emerald-400 hover:text-emerald-300">Settings</button> and hit Save.
        </li>
      </ol>
      <p className="text-xs text-slate-500 mt-4">
        Both free tiers are generous and cover normal personal use. Keys are stored encrypted on this machine using
        your OS keychain — they never leave your computer except to call the chain providers directly.
      </p>
    </div>
  );
}

function ResultsHeader({ result, onExpand }: { result: LookupResult; onExpand: () => void }) {
  const enriched = result.buyers.filter((b) => b.walletAgeDays !== undefined).length;
  const fresh = result.buyers.filter((b) => isFreshWallet(b.walletAgeDays, b.walletTxCount) === true).length;
  const established = result.buyers.filter((b) => isFreshWallet(b.walletAgeDays, b.walletTxCount) === false).length;
  const pending = result.buyers.length - enriched;
  const canExpand = result.buyers.length <= 50;

  return (
    <div className="text-sm text-slate-300 flex items-center gap-2 flex-wrap">
      <span className="text-slate-100 font-medium">{result.tokenName ?? '—'}</span>
      <span className="text-slate-500">({result.tokenSymbol ?? '?'})</span>
      <CopyButton value={result.contract} title="Copy token contract" />
      <DexScreenerButton address={result.contract} chain={result.chain} title="Open on DexScreener" />
      <span className="text-slate-600">·</span>
      <span className="uppercase text-xs tracking-wider text-slate-400">{result.chain}</span>
      <span className="text-slate-600">·</span>
      <span className="text-slate-500">{result.buyers.length} buys</span>
      {canExpand && (
        <button
          onClick={onExpand}
          title="Load up to 200 buyers (slower)"
          className="ml-0.5 inline-flex items-center justify-center w-5 h-5 rounded border border-slate-700 hover:border-emerald-500 hover:text-emerald-400 text-slate-400 text-xs leading-none"
        >
          +
        </button>
      )}
      <span className="text-slate-600">·</span>
      <span
        className="px-2 py-0.5 rounded bg-amber-900/30 text-amber-300 text-xs"
        title="Wallets ≤3 days old OR ≤10 txs in first 2 weeks. Usually sniper bots / burners."
      >
        🌱 {fresh} fresh
      </span>
      <span
        className="px-2 py-0.5 rounded bg-emerald-900/30 text-emerald-300 text-xs"
        title="Wallets older than 3 days with more than 10 transactions."
      >
        {established} established
      </span>
      {pending > 0 && <span className="text-slate-500 text-xs">· {pending} enriching…</span>}
    </div>
  );
}

function ConfigBadge({ config }: { config: ConfigStatus }) {
  const Item = ({ ok, label }: { ok: boolean; label: string }) => (
    <span className={`px-2 py-0.5 rounded text-[10px] uppercase tracking-wider ${ok ? 'bg-emerald-900/40 text-emerald-300' : 'bg-slate-800 text-slate-500'}`}>
      {label} {ok ? 'ok' : 'off'}
    </span>
  );
  return (
    <div className="flex items-center gap-2">
      <Item ok={config.hasAlchemy} label="Alchemy" />
      <Item ok={config.hasHelius} label="Helius" />
      <Item ok={config.hasEtherscan} label="Etherscan" />
    </div>
  );
}
