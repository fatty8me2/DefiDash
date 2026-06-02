import { app, BrowserWindow, ipcMain, shell, Notification } from 'electron';
import { fileURLToPath } from 'url';
import path from 'path';
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
import { V2Feed } from './feeds/v2Feed';
import { VerifiedFeed } from './feeds/verifiedFeed';
import { PumpFlowFeed } from './feeds/pumpFlow';
import { EvmFlowFeed } from './feeds/evmFlow';
import { initAutoUpdates, checkForUpdatesManual } from './updater';
import { fetchTrending } from './feeds/trending';
import { analyzeLaunch } from './enrichment/launch';
import type { BuyerRow, Chain, DevWalletInfo, EvmFlowChain, EvmFlowSnapshot, FlowSnapshot, HoneypotReport, LiveFeedItem, LookupResult, TrendingList, WalletDetail } from '../shared/types';

dotenv.config();

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
    cieloKey: s.cieloKey,
    bitqueryToken: s.bitqueryToken
  };
}

const v2Feed = new V2Feed();
const verifiedFeed = new VerifiedFeed();
const pumpFlowFeed = new PumpFlowFeed();
const evmFlowFeed = new EvmFlowFeed();
let mainWindow: BrowserWindow | null = null;
let feedsStarted = false;
let flowStarted = false;
let evmFlowStarted = false;
let evmFlowChain: EvmFlowChain = 'ethereum';

function broadcast(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

v2Feed.on('deploy', (item: LiveFeedItem) => {
  broadcast('feed:v2deploy', item);
  verifiedFeed.enqueue(item);
});
v2Feed.on('deploy:update', (item: LiveFeedItem) => {
  broadcast('feed:v2deploy:update', item);
  verifiedFeed.updateMetadata(item);
});
v2Feed.on('status', (s: string) => broadcast('feed:v2status', s));
verifiedFeed.on('verified', (item: LiveFeedItem) => {
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
verifiedFeed.on('status', (s: string) => broadcast('feed:verifiedstatus', s));

pumpFlowFeed.on('update', (snap: FlowSnapshot) => broadcast('flow:update', snap));
pumpFlowFeed.on('status', (s: string) => broadcast('flow:status', s));

evmFlowFeed.on('update', (snap: EvmFlowSnapshot) => broadcast('evmflow:update', snap));
evmFlowFeed.on('status', (s: string) => broadcast('evmflow:status', s));

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
      nodeIntegration: false
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
    hasCielo: !!k.cieloKey,
    hasBitquery: !!k.bitqueryToken
  };
});

ipcMain.handle('settings:get', (): Settings => getPrefs());

ipcMain.handle('settings:save', (_e, s: Settings) => {
  saveSettings(s);
  // Re-read from disk so the cache reflects the same coercion/clamping saveSettings applied.
  cachedSettings = loadSettings();
  applyLoginItemSettings();
  // Restart feeds so new keys / toggles take effect.
  v2Feed.stop();
  verifiedFeed.stop();
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
});

function startFeeds(): void {
  if (feedsStarted) return;
  const s = getPrefs();
  if (s.feedV2Enabled) v2Feed.start(s.alchemyKey);
  if (s.feedVerifiedEnabled && s.etherscanKey) verifiedFeed.start(s.etherscanKey);
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
  feedsStarted = false;
});

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
}

// The Pump Flow stream holds an open Helius WebSocket, so it runs only while the
// user has the page open — started/stopped from the renderer on view change.
ipcMain.handle('flow:start', () => { startFlow(); });
ipcMain.handle('flow:stop', () => { stopFlow(); });

function startEvmFlow(chain: EvmFlowChain): void {
  if (evmFlowStarted && chain === evmFlowChain) return;
  // Switching chains: tear down the old stream first.
  if (evmFlowStarted) evmFlowFeed.stop();
  evmFlowChain = chain;
  const token = getKeys().bitqueryToken;
  evmFlowFeed.start(token, chain);
  evmFlowStarted = true;
}
function stopEvmFlow(): void {
  evmFlowFeed.stop();
  evmFlowStarted = false;
}

// Like Pump Flow, the EVM stream is page-scoped to conserve Bitquery quota.
// The renderer passes which chain (ethereum/base) to stream.
ipcMain.handle('evmflow:start', (_e, chain: EvmFlowChain) => { startEvmFlow(chain); });
ipcMain.handle('evmflow:stop', () => { stopEvmFlow(); });

ipcMain.handle('updates:check', () => checkForUpdatesManual());
ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('trending:get', (_e, list: TrendingList) => fetchTrending(list));

ipcMain.handle('launch:analyze', (_e, payload: { chain: Chain; contract: string }) =>
  analyzeLaunch(payload.chain, payload.contract, { alchemyKey: getKeys().alchemyKey })
);

app.whenReady().then(() => {
  createWindow();
  applyLoginItemSettings();
  initAutoUpdates();
});

app.on('window-all-closed', () => {
  v2Feed.stop();
  verifiedFeed.stop();
  pumpFlowFeed.stop();
  evmFlowFeed.stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
