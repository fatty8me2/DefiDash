import { app, BrowserWindow, ipcMain, shell, Notification } from 'electron';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { detectChain } from './chains/detect';
import { fetchEthereumBuyers } from './chains/ethereum';
import { fetchSolanaBuyers } from './chains/solana';
import { getWalletStats, getStillHoldingPct, computeSmartScore } from './enrichment/walletStats';
import { getCieloStats } from './enrichment/cielo';
import { getWalletDetail } from './enrichment/walletDetail';
import { checkHoneypot } from './enrichment/honeypot';
import { getDevWalletInfo } from './enrichment/devWallet';
import { loadSettings, saveSettings, type Settings } from './settings';
import { loadTracked, addTracked, removeTracked, renameTracked } from './trackedWallets';
import { V2Feed } from './feeds/v2Feed';
import { VerifiedFeed } from './feeds/verifiedFeed';
import { TrackedActivityFeed } from './feeds/trackedActivity';
import { PumpFlowFeed } from './feeds/pumpFlow';
import { EvmFlowFeed } from './feeds/evmFlow';
import { initAutoUpdates, checkForUpdatesManual } from './updater';
import { fetchTrending } from './feeds/trending';
import { analyzeLaunch } from './enrichment/launch';
import { installApiUsageTracking, snapshot as apiUsageSnapshot } from './apiUsage';
import { DaleFeed } from './dale';
import { AccessGate } from './accessGate';
import { generateWallet, importWallet, removeWallet, getPublicKey, exportSecret, listWallets, selectWallet } from './trading/wallet';
import { getQuote, executeSwap, getWalletInfo, getTokenBalance, getWalletTokens, getTokenTrades } from './trading/jupiter';
import type { TokenTrade, TradeHolding, TradeQuote, TradeResult, TradeSide, TradeSpeed, TradeTokenBalance, TradeWalletInfo, TradeWalletSummary } from '../shared/types';
import type { AccessState, BuyerRow, Chain, DaleSnapshot, DevWalletInfo, EvmFlowChain, EvmFlowSnapshot, FlowSnapshot, HoneypotReport, LiveFeedItem, LiveFeedSnapshot, LookupResult, TrackedActivity, TrackedWallet, TrendingList, WalletDetail } from '../shared/types';

dotenv.config();

// Meter every outbound API call (by host) so the "API Usage" page can show how
// much of each provider's quota we've used. Installed before any fetch runs.
installApiUsageTracking();

// Data-folder recovery. The 2.2.0 rename ("Wallet Lookup" → "Defi Dashboard")
// shipped a bad userData pin that pointed at an empty folder, so settings + the
// encrypted trade wallet looked "gone". They were never deleted — they live in
// the original folder. Here we point userData at whichever candidate folder
// actually holds the data, preferring the one with the encrypted trade wallet so
// funds are never stranded.
(function recoverUserDataFolder() {
  try {
    const appData = app.getPath('appData');
    const current = app.getPath('userData');
    const candidates = [
      current,
      path.join(appData, 'walletlookup'),   // Electron default from package `name` (all pre-2.2 versions)
      path.join(appData, 'Wallet Lookup'),  // the bad 2.2.0 pin wrote re-entered keys here
      path.join(appData, 'Defi Dashboard')  // possible default if productName ever applied
    ].filter((d, i, a) => a.indexOf(d) === i);
    const has = (dir: string, file: string): boolean => {
      try { return fs.existsSync(path.join(dir, file)); } catch { return false; }
    };
    // 1) Prefer a folder that still has the encrypted trade wallet.
    let target = candidates.find((d) => has(d, 'trade-wallet.bin'));
    // 2) Otherwise a folder with saved settings / tracked wallets.
    if (!target) target = candidates.find((d) => has(d, 'settings.bin') || has(d, 'tracked-wallets.json'));
    if (target && target !== current) {
      app.setPath('userData', target);
      console.log(`[main] using existing data folder: ${target}`);
    }
  } catch {
    // non-fatal — falls back to the default userData path
  }
})();

let cachedSettings: Settings | null = null;
function getPrefs(): Settings {
  if (!cachedSettings) cachedSettings = loadSettings();
  return cachedSettings;
}
function getKeys() {
  const s = getPrefs();
  return {
    alchemyKey: s.alchemyKey,
    heliusKey: s.heliusKey,
    etherscanKey: s.etherscanKey,
    cieloKey: s.cieloKey
  };
}

const v2Feed = new V2Feed();
const verifiedFeed = new VerifiedFeed();
const trackedActivityFeed = new TrackedActivityFeed();
const pumpFlowFeed = new PumpFlowFeed();
const evmFlowFeed = new EvmFlowFeed();
let mainWindow: BrowserWindow | null = null;
let feedsStarted = false;
let flowStarted = false;
// Reference-counted Pump Flow stream: it runs while any watchlist view (Pump
// Flow page or the Trade watchlist rail) is mounted, and auto-pauses ~1 min
// after the last one closes — so it doesn't burn API while idle on other pages.
let flowConsumers = 0;
let flowPauseTimer: NodeJS.Timeout | null = null;
const FLOW_PAUSE_GRACE_MS = 60_000;
let evmFlowStarted = false;
let evmFlowChain: EvmFlowChain = 'ethereum';

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// Rolling buffers of the most recent feed items, kept in the main process so the
// feeds can run continuously in the background (from app launch) and the
// Dashboard can repopulate instantly when it mounts — instead of starting blank
// each time the tab is opened. Most-recent-first, capped to FEED_BUFFER_MAX.
const FEED_BUFFER_MAX = 50;
let v2Buffer: LiveFeedItem[] = [];
let verifiedBuffer: LiveFeedItem[] = [];
let lastV2Status = 'idle';
let lastVerifiedStatus = 'idle';

v2Feed.on('deploy', (item: LiveFeedItem) => {
  // Dedup by pair (matches the renderer's keying) and cap the buffer.
  const key = item.pair.toLowerCase();
  if (!v2Buffer.some((p) => p.pair.toLowerCase() === key)) {
    v2Buffer = [item, ...v2Buffer].slice(0, FEED_BUFFER_MAX);
  }
  broadcast('feed:v2deploy', item);
  verifiedFeed.enqueue(item);
});
v2Feed.on('deploy:update', (item: LiveFeedItem) => {
  // Merge metadata into the buffered copy so a late-arriving symbol/name sticks.
  const key = item.pair.toLowerCase();
  v2Buffer = v2Buffer.map((p) => (p.pair.toLowerCase() === key ? { ...p, ...item } : p));
  broadcast('feed:v2deploy:update', item);
  verifiedFeed.updateMetadata(item);
});
v2Feed.on('status', (s: string) => { lastV2Status = s; broadcast('feed:v2status', s); });
// The historical backfill runs in the main process at launch and finishes a few
// RPC round-trips later — likely after the renderer already pulled the (empty)
// snapshot. Push the now-populated buffer so the panels seed without a reload.
v2Feed.on('backfill', () => {
  broadcast('feed:snapshot', {
    v2: v2Buffer,
    verified: verifiedBuffer,
    v2Status: lastV2Status,
    verifiedStatus: lastVerifiedStatus
  } as LiveFeedSnapshot);
});
verifiedFeed.on('verified', (item: LiveFeedItem) => {
  const key = item.contract.toLowerCase();
  if (!verifiedBuffer.some((p) => p.contract.toLowerCase() === key)) {
    verifiedBuffer = [item, ...verifiedBuffer].slice(0, FEED_BUFFER_MAX);
  }
  broadcast('feed:verified', item);
  if (getPrefs().notifyVerified && Notification.isSupported()) {
    try {
      const n = new Notification({
        title: 'New verified launch',
        body: `${item.symbol ?? 'Token'}${item.name ? ` — ${item.name}` : ''}\n${item.contract}`
      });
      n.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
          broadcast('feed:notify-open', item.contract);
        }
      });
      n.show();
    } catch {
      // notifications are best-effort
    }
  }
});
verifiedFeed.on('status', (s: string) => { lastVerifiedStatus = s; broadcast('feed:verifiedstatus', s); });

trackedActivityFeed.on('activity', (a: TrackedActivity) => broadcast('tracked:activity', a));

// Cache the latest Pump Flow snapshot so a freshly-mounted watchlist rail can be
// seeded instantly (instead of waiting for the next push) — keeps watchlist
// cards live across page navigation.
let lastFlowSnap: FlowSnapshot | null = null;
pumpFlowFeed.on('update', (snap: FlowSnapshot) => { lastFlowSnap = snap; broadcast('flow:update', snap); });
pumpFlowFeed.on('status', (s: string) => broadcast('flow:status', s));

evmFlowFeed.on('update', (snap: EvmFlowSnapshot) => broadcast('evmflow:update', snap));
evmFlowFeed.on('status', (s: string) => broadcast('evmflow:status', s));

// Dale: shared charts ledger (Firebase Realtime DB). Streams in the background so
// other clients' adds/removes show up live; config comes from settings.
const daleFeed = new DaleFeed();
daleFeed.on('update', (snap: DaleSnapshot) => broadcast('dale:update', snap));
function startDale(): void {
  const s = getPrefs();
  daleFeed.configure(s.daleFirebaseUrl, s.daleFirebaseSecret);
  daleFeed.start();
}

// Whole-app access gate (operator-controlled allowlist). The renderer blocks the
// UI until status is 'allowed'; trade IPCs also refuse when not allowed.
const accessGate = new AccessGate();
accessGate.on('update', (s: AccessState) => broadcast('access:update', s));
function startAccessGate(): void {
  accessGate.setCode(getPrefs().accessCode);
  accessGate.start();
}
function accessAllowed(): boolean {
  return accessGate.current().status === 'allowed';
}

console.log('[main] feed modules initialized');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Enables the <webview> tag used by the Charts tab to embed live Photon charts.
      webviewTag: true
    }
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.on('console-message', (_e, level, message, line, source) => {
    const tag = ['LOG', 'WARN', 'ERR', 'DBG'][level] ?? 'LOG';
    console.log(`[renderer:${tag}] ${message}  (${source}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[renderer:FAIL] ${code} ${desc} url=${url}`);
  });

  // Open external links in the user's default browser instead of a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

ipcMain.handle('lookup:buyers', async (_e, contract: string, limit?: number): Promise<LookupResult> => {
  const chain = detectChain(contract);
  if (!chain) throw new Error('Could not detect chain. Provide an ETH (0x…) or Solana address.');
  const { alchemyKey, heliusKey } = getKeys();
  const n = limit && limit > 0 ? Math.min(limit, 500) : 50;
  return chain === 'ethereum'
    ? fetchEthereumBuyers(contract, alchemyKey, n)
    : fetchSolanaBuyers(contract, heliusKey, n);
});

ipcMain.handle(
  'lookup:enrich',
  async (
    _e,
    payload: { chain: Chain; wallet: string; tokenContract: string; boughtAmount: number }
  ): Promise<Partial<BuyerRow>> => {
    const keys = getKeys();
    const [stats, holdPct, cielo] = await Promise.all([
      getWalletStats(payload.chain, payload.wallet, keys),
      getStillHoldingPct(payload.chain, payload.wallet, payload.tokenContract, payload.boughtAmount, keys),
      getCieloStats(payload.chain, payload.wallet, keys.cieloKey)
    ]);

    const localScore = computeSmartScore({
      ageDays: stats.ageDays,
      txCount: stats.txCount,
      nativeBalance: stats.nativeBalance,
      tokenCount: stats.tokenCount,
      stillHoldingPct: holdPct,
      isContract: stats.isContract
    });

    // Prefer Cielo's PnL-derived score when a key is configured and it returns data.
    const smartScore = cielo.smartScore ?? localScore;

    return {
      walletAgeDays: stats.ageDays,
      walletTxCount: stats.txCount,
      nativeBalance: stats.nativeBalance,
      tokenCount: stats.tokenCount,
      stillHoldingPct: holdPct,
      isContract: stats.isContract,
      smartScore,
      cieloPnlUsd: cielo.realizedPnlUsd,
      cieloWinRatePct: cielo.winRatePct
    };
  }
);

ipcMain.handle(
  'lookup:detail',
  async (_e, payload: { chain: Chain; wallet: string }): Promise<WalletDetail> => {
    return getWalletDetail(payload.chain, payload.wallet, getKeys());
  }
);

ipcMain.handle(
  'lookup:honeypot',
  async (_e, payload: { chain: Chain; contract: string }): Promise<HoneypotReport> => {
    return checkHoneypot(payload.chain, payload.contract);
  }
);

// --- Tracked wallets (persisted pin list for the Tracked dashboard) ---
ipcMain.handle('tracked:list', (): TrackedWallet[] => loadTracked());
ipcMain.handle(
  'tracked:add',
  (_e, p: { chain: Chain; address: string; label: string }): TrackedWallet[] =>
    addTracked(p.chain, p.address, p.label ?? '')
);
ipcMain.handle(
  'tracked:remove',
  (_e, p: { chain: Chain; address: string }): TrackedWallet[] =>
    removeTracked(p.chain, p.address)
);
ipcMain.handle(
  'tracked:rename',
  (_e, p: { chain: Chain; address: string; label: string }): TrackedWallet[] =>
    renameTracked(p.chain, p.address, p.label ?? '')
);

ipcMain.handle(
  'lookup:dev',
  async (
    _e,
    payload: { chain: Chain; contract: string; creatorHint: string | null }
  ): Promise<DevWalletInfo | null> => {
    return getDevWalletInfo(payload.chain, payload.contract, payload.creatorHint, getKeys());
  }
);

ipcMain.handle('config:status', () => {
  const k = getKeys();
  return {
    hasAlchemy: !!k.alchemyKey,
    hasHelius: !!k.heliusKey,
    hasEtherscan: !!k.etherscanKey,
    hasCielo: !!k.cieloKey
  };
});

ipcMain.handle('apiUsage:get', () => apiUsageSnapshot(getKeys()));

ipcMain.handle('settings:get', (): Settings => getPrefs());

ipcMain.handle('settings:save', (_e, s: Settings) => {
  saveSettings(s);
  // Re-read from disk so the cache reflects the same coercion/clamping saveSettings applied.
  cachedSettings = loadSettings();
  applyLoginItemSettings();
  // Restart feeds so new keys / toggles take effect.
  v2Feed.stop();
  verifiedFeed.stop();
  trackedActivityFeed.stop();
  feedsStarted = false;
  startFeeds();
  // If the Pump Flow stream is live, restart it so a new Helius key applies.
  if (flowStarted) {
    stopFlow();
    startFlow();
  }
  // Same for the EVM flow stream — preserve the current chain selection.
  if (evmFlowStarted) {
    const chain = evmFlowChain;
    stopEvmFlow();
    startEvmFlow(chain);
  }
  // Reconnect the Dale stream with the new URL/secret/name.
  startDale();
  // Re-verify access if the code changed in Settings.
  accessGate.setCode(cachedSettings.accessCode);
  void accessGate.check();
});

// Access gate
ipcMain.handle('access:get', (): AccessState => accessGate.current());
ipcMain.handle('access:recheck', (): Promise<AccessState> => accessGate.check());
ipcMain.handle('access:setCode', (_e, code: string): Promise<AccessState> => {
  const prefs = getPrefs();
  saveSettings({ ...prefs, accessCode: (code || '').trim() });
  cachedSettings = loadSettings();
  accessGate.setCode(cachedSettings.accessCode);
  return accessGate.check();
});

ipcMain.handle('dale:list', (): DaleSnapshot => daleFeed.current());
ipcMain.handle('dale:add', (_e, address: string): Promise<DaleSnapshot> =>
  daleFeed.add(address, getPrefs().displayName));
ipcMain.handle('dale:remove', (_e, id: string): Promise<DaleSnapshot> => daleFeed.remove(id));

function startFeeds(): void {
  if (feedsStarted) return;
  const s = getPrefs();
  if (s.feedV2Enabled) v2Feed.start(s.alchemyKey);
  if (s.feedVerifiedEnabled && s.etherscanKey) verifiedFeed.start(s.etherscanKey);
  // Monitor tracked wallets for buys/sells (reads the pin list each poll).
  trackedActivityFeed.start({ heliusKey: s.heliusKey, alchemyKey: s.alchemyKey });
  feedsStarted = true;
}

function applyLoginItemSettings(): void {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    try {
      app.setLoginItemSettings({ openAtLogin: getPrefs().launchOnStartup });
    } catch {
      // not fatal
    }
  }
}

ipcMain.handle('feeds:start', () => { startFeeds(); });
ipcMain.handle('feeds:stop', () => {
  v2Feed.stop();
  verifiedFeed.stop();
  trackedActivityFeed.stop();
  feedsStarted = false;
});
// Hand the renderer the current rolling buffers so the Dashboard panels show
// recent history immediately on mount instead of waiting for the next event.
ipcMain.handle('feeds:snapshot', (): LiveFeedSnapshot => ({
  v2: v2Buffer,
  verified: verifiedBuffer,
  v2Status: lastV2Status,
  verifiedStatus: lastVerifiedStatus
}));

function startFlow(): void {
  if (flowStarted) return;
  // Pump Flow now streams directly from Helius (logsSubscribe on the pump.fun
  // program) and decodes trades locally — no Bitquery quota involved.
  const heliusKey = getKeys().heliusKey;
  pumpFlowFeed.start(heliusKey);
  flowStarted = true;
}
function stopFlow(): void {
  pumpFlowFeed.stop();
  flowStarted = false;
  lastFlowSnap = null;
}

// A watchlist view mounted → keep the stream alive (cancel any pending pause).
function acquireFlow(): void {
  flowConsumers += 1;
  if (flowPauseTimer) { clearTimeout(flowPauseTimer); flowPauseTimer = null; }
  startFlow();
}
// A watchlist view unmounted → if none remain, pause after a grace period (so
// quick Pump Flow ↔ Trade ↔ Charts navigation doesn't tear the stream down).
function releaseFlow(): void {
  flowConsumers = Math.max(0, flowConsumers - 1);
  if (flowConsumers === 0 && !flowPauseTimer) {
    flowPauseTimer = setTimeout(() => {
      flowPauseTimer = null;
      if (flowConsumers === 0) {
        console.log('[main] pausing Pump Flow stream (idle)');
        stopFlow();
      }
    }, FLOW_PAUSE_GRACE_MS);
  }
}

// The Pump Flow stream holds an open Helius WebSocket. Reference-counted via
// acquire/release so it runs only while a watchlist view is open and pauses when
// idle. `flow:restart` clears the rolling window (Refresh button) without
// affecting the consumer count.
ipcMain.handle('flow:acquire', () => { acquireFlow(); });
ipcMain.handle('flow:release', () => { releaseFlow(); });
ipcMain.handle('flow:restart', () => { stopFlow(); startFlow(); });
ipcMain.handle('flow:start', () => { startFlow(); });
ipcMain.handle('flow:stop', () => { stopFlow(); });
ipcMain.handle('flow:snapshot', (): FlowSnapshot | null => lastFlowSnap);

function startEvmFlow(chain: EvmFlowChain): void {
  if (evmFlowStarted && chain === evmFlowChain) return;
  // Switching chains: tear down the old stream first.
  if (evmFlowStarted) evmFlowFeed.stop();
  evmFlowChain = chain;
  // EVM Flow now streams directly from Alchemy (eth_subscribe logs on the
  // Uniswap V2 Swap topic) and decodes trades locally — no Bitquery involved.
  const alchemyKey = getKeys().alchemyKey;
  evmFlowFeed.start(alchemyKey, chain);
  evmFlowStarted = true;
}
function stopEvmFlow(): void {
  evmFlowFeed.stop();
  evmFlowStarted = false;
}

// Like Pump Flow, the EVM stream holds an open Alchemy WebSocket, so it's
// page-scoped. The renderer passes which chain (ethereum/base) to stream.
ipcMain.handle('evmflow:start', (_e, chain: EvmFlowChain) => { startEvmFlow(chain); });
ipcMain.handle('evmflow:stop', () => { stopEvmFlow(); });

ipcMain.handle('updates:check', () => checkForUpdatesManual());
ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('trending:get', (_e, list: TrendingList) => fetchTrending(list));

// Generic JSON GET proxy for the renderer. Token metadata lives on arbitrary
// third-party hosts (IPFS gateways, project servers) that don't send CORS
// headers, so a renderer fetch is blocked. Fetching from the main process
// (Node, no CORS) sidesteps that. Best-effort: returns null on any failure.
ipcMain.handle('net:fetchJson', async (_e, url: string): Promise<unknown> => {
  try {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
});

ipcMain.handle('launch:analyze', (_e, payload: { chain: Chain; contract: string }) =>
  analyzeLaunch(payload.chain, payload.contract, { alchemyKey: getKeys().alchemyKey })
);

// --- Trading (native Jupiter swap terminal, Solana-only) ---
// Wallet management stays in the main process; the renderer only ever gets the
// public address + balances back (never the secret, except the explicit reveal).
ipcMain.handle('trade:walletInfo', (): Promise<TradeWalletInfo> => getWalletInfo(getKeys().heliusKey));
ipcMain.handle('trade:listWallets', (): TradeWalletSummary[] => listWallets());
ipcMain.handle('trade:selectWallet', (_e, address: string): Promise<TradeWalletInfo> => {
  selectWallet(address);
  return getWalletInfo(getKeys().heliusKey);
});
ipcMain.handle('trade:generateWallet', (): Promise<TradeWalletInfo> => {
  generateWallet();
  return getWalletInfo(getKeys().heliusKey);
});
ipcMain.handle('trade:importWallet', (_e, secret: string): Promise<TradeWalletInfo> => {
  importWallet(secret);
  return getWalletInfo(getKeys().heliusKey);
});
ipcMain.handle('trade:removeWallet', (_e, address: string | undefined): Promise<TradeWalletInfo> => {
  removeWallet(address);
  return getWalletInfo(getKeys().heliusKey);
});
ipcMain.handle('trade:revealSecret', (): string | null => exportSecret());
ipcMain.handle('trade:address', (): string | null => getPublicKey());
ipcMain.handle('trade:tokenBalance', (_e, mint: string): Promise<TradeTokenBalance> =>
  getTokenBalance(mint, getKeys().heliusKey)
);
ipcMain.handle('trade:walletTokens', (): Promise<TradeHolding[]> => getWalletTokens(getKeys().heliusKey));
ipcMain.handle('trade:tokenTrades', (_e, mint: string): Promise<TokenTrade[]> => getTokenTrades(mint, getKeys().heliusKey));
ipcMain.handle(
  'trade:quote',
  (_e, p: { side: TradeSide; mint: string; amount: number; slippageBps: number }): Promise<TradeQuote> =>
    getQuote(p.side, p.mint, p.amount, p.slippageBps, getKeys().heliusKey)
);
ipcMain.handle(
  'trade:swap',
  (_e, p: { side: TradeSide; mint: string; amount: number; slippageBps: number; speed?: TradeSpeed; dynamicSlippage?: boolean }): Promise<TradeResult> => {
    if (!accessAllowed()) return Promise.resolve({ ok: false, signature: null, error: 'Access revoked — trading is disabled.' });
    return executeSwap(p.side, p.mint, p.amount, p.slippageBps, getKeys().heliusKey, p.speed ?? 'fast', false, !!p.dynamicSlippage);
  }
);
// Sell the wallet's entire balance of a token (used by the Charts "Sell all" button).
ipcMain.handle(
  'trade:sellAll',
  (_e, p: { mint: string; slippageBps?: number; speed?: TradeSpeed }): Promise<TradeResult> => {
    if (!accessAllowed()) return Promise.resolve({ ok: false, signature: null, error: 'Access revoked — trading is disabled.' });
    return executeSwap('sell', p.mint, 0, p.slippageBps ?? 1000, getKeys().heliusKey, p.speed ?? 'fast', true);
  }
);

app.whenReady().then(() => {
  createWindow();
  applyLoginItemSettings();
  initAutoUpdates();
  // Start the V2 + Verified feeds immediately so they accumulate in the
  // background regardless of which tab is open. The renderer seeds from the
  // rolling buffer via feeds:snapshot when the Dashboard mounts.
  startFeeds();
  // Connect the shared Dale ledger stream (no-op until it's configured in Settings).
  startDale();
  // Begin the whole-app access check (renderer stays gated until 'allowed').
  startAccessGate();
});

app.on('window-all-closed', () => {
  v2Feed.stop();
  verifiedFeed.stop();
  trackedActivityFeed.stop();
  pumpFlowFeed.stop();
  evmFlowFeed.stop();
  daleFeed.stop();
  accessGate.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
