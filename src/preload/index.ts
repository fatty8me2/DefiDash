import { contextBridge, ipcRenderer } from 'electron';
import type { AccessState, ApiUsageSnapshot, AppSettings, BundleAnalysis, BuyerRow, Chain, DaleSnapshot, DevWalletInfo, EvmFlowChain, EvmFlowSnapshot, FlowSnapshot, HoneypotReport, LiveFeedItem, LiveFeedSnapshot, LookupResult, SniperAnalysis, TokenTrade, TradeHolding, TradeQuote, TradeResult, TradeSide, TradeSpeed, TradeTokenBalance, TradeWalletInfo, TradeWalletSummary, TrackedActivity, TrackedWallet, TrendingList, TrendingToken, WalletDetail } from '../shared/types';

export type SettingsShape = AppSettings;

type Unsubscribe = () => void;

function onChannel<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: unknown, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  lookupBuyers: (contract: string, limit?: number): Promise<LookupResult> =>
    ipcRenderer.invoke('lookup:buyers', contract, limit),
  enrichWallet: (
    chain: Chain,
    wallet: string,
    tokenContract: string,
    boughtAmount: number
  ): Promise<Partial<BuyerRow>> =>
    ipcRenderer.invoke('lookup:enrich', { chain, wallet, tokenContract, boughtAmount }),
  walletDetail: (chain: Chain, wallet: string): Promise<WalletDetail> =>
    ipcRenderer.invoke('lookup:detail', { chain, wallet }),

  // Tracked wallets (persisted pin list for the Tracked dashboard)
  trackedList: (): Promise<TrackedWallet[]> => ipcRenderer.invoke('tracked:list'),
  trackedAdd: (chain: Chain, address: string, label: string): Promise<TrackedWallet[]> =>
    ipcRenderer.invoke('tracked:add', { chain, address, label }),
  trackedRemove: (chain: Chain, address: string): Promise<TrackedWallet[]> =>
    ipcRenderer.invoke('tracked:remove', { chain, address }),
  trackedRename: (chain: Chain, address: string, label: string): Promise<TrackedWallet[]> =>
    ipcRenderer.invoke('tracked:rename', { chain, address, label }),
  onTrackedActivity: (cb: (a: TrackedActivity) => void): Unsubscribe => onChannel('tracked:activity', cb),
  honeypotCheck: (chain: Chain, contract: string): Promise<HoneypotReport> =>
    ipcRenderer.invoke('lookup:honeypot', { chain, contract }),
  devWalletInfo: (chain: Chain, contract: string, creatorHint: string | null): Promise<DevWalletInfo | null> =>
    ipcRenderer.invoke('lookup:dev', { chain, contract, creatorHint }),
  configStatus: (): Promise<{ hasAlchemy: boolean; hasHelius: boolean; hasEtherscan: boolean; hasCielo: boolean }> =>
    ipcRenderer.invoke('config:status'),
  apiUsage: (): Promise<ApiUsageSnapshot> => ipcRenderer.invoke('apiUsage:get'),

  // Whole-app access gate
  accessStatus: (): Promise<AccessState> => ipcRenderer.invoke('access:get'),
  accessRecheck: (): Promise<AccessState> => ipcRenderer.invoke('access:recheck'),
  accessSetCode: (code: string): Promise<AccessState> => ipcRenderer.invoke('access:setCode', code),
  onAccessUpdate: (cb: (s: AccessState) => void): Unsubscribe => onChannel('access:update', cb),
  getSettings: (): Promise<SettingsShape> => ipcRenderer.invoke('settings:get'),
  saveSettings: (s: SettingsShape): Promise<void> => ipcRenderer.invoke('settings:save', s),

  checkForUpdates: (): Promise<void> => ipcRenderer.invoke('updates:check'),
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),

  getTrending: (list: TrendingList): Promise<TrendingToken[]> =>
    ipcRenderer.invoke('trending:get', list),
  // Fetch arbitrary JSON via the main process (avoids renderer CORS blocks on
  // third-party token-metadata hosts). Returns null on any failure.
  fetchJson: (url: string): Promise<Record<string, unknown> | null> =>
    ipcRenderer.invoke('net:fetchJson', url),
  analyzeLaunch: (
    chain: Chain,
    contract: string
  ): Promise<{ sniper: SniperAnalysis; bundle: BundleAnalysis }> =>
    ipcRenderer.invoke('launch:analyze', { chain, contract }),

  startFeeds: (): Promise<void> => ipcRenderer.invoke('feeds:start'),
  stopFeeds: (): Promise<void> => ipcRenderer.invoke('feeds:stop'),
  feedsSnapshot: (): Promise<LiveFeedSnapshot> => ipcRenderer.invoke('feeds:snapshot'),
  onFeedsSnapshot: (cb: (snap: LiveFeedSnapshot) => void): Unsubscribe => onChannel('feed:snapshot', cb),
  onV2Deploy: (cb: (item: LiveFeedItem) => void): Unsubscribe => onChannel('feed:v2deploy', cb),
  onV2DeployUpdate: (cb: (item: LiveFeedItem) => void): Unsubscribe => onChannel('feed:v2deploy:update', cb),
  onV2Status: (cb: (status: string) => void): Unsubscribe => onChannel('feed:v2status', cb),
  onVerifiedLaunch: (cb: (item: LiveFeedItem) => void): Unsubscribe => onChannel('feed:verified', cb),
  onVerifiedStatus: (cb: (status: string) => void): Unsubscribe => onChannel('feed:verifiedstatus', cb),
  onNotifyOpen: (cb: (contract: string) => void): Unsubscribe => onChannel('feed:notify-open', cb),

  // Pump Flow (live pump.fun net-inflow stream)
  startFlow: (): Promise<void> => ipcRenderer.invoke('flow:start'),
  stopFlow: (): Promise<void> => ipcRenderer.invoke('flow:stop'),
  // Reference-counted lifecycle: acquire while a watchlist view is open, release
  // on unmount (auto-pauses when idle). Restart clears the rolling window.
  flowAcquire: (): Promise<void> => ipcRenderer.invoke('flow:acquire'),
  flowRelease: (): Promise<void> => ipcRenderer.invoke('flow:release'),
  flowRestart: (): Promise<void> => ipcRenderer.invoke('flow:restart'),
  flowSnapshot: (): Promise<FlowSnapshot | null> => ipcRenderer.invoke('flow:snapshot'),
  onFlowUpdate: (cb: (snap: FlowSnapshot) => void): Unsubscribe => onChannel('flow:update', cb),
  onFlowStatus: (cb: (status: string) => void): Unsubscribe => onChannel('flow:status', cb),

  // Dale — shared charts ledger (Firebase Realtime DB), synced across clients
  daleList: (): Promise<DaleSnapshot> => ipcRenderer.invoke('dale:list'),
  daleAdd: (address: string): Promise<DaleSnapshot> => ipcRenderer.invoke('dale:add', address),
  daleRemove: (id: string): Promise<DaleSnapshot> => ipcRenderer.invoke('dale:remove', id),
  onDaleUpdate: (cb: (snap: DaleSnapshot) => void): Unsubscribe => onChannel('dale:update', cb),

  // EVM Flow (live Uniswap V2 net-ETH-inflow stream, ETH + Base)
  startEvmFlow: (chain: EvmFlowChain): Promise<void> => ipcRenderer.invoke('evmflow:start', chain),
  stopEvmFlow: (): Promise<void> => ipcRenderer.invoke('evmflow:stop'),
  onEvmFlowUpdate: (cb: (snap: EvmFlowSnapshot) => void): Unsubscribe => onChannel('evmflow:update', cb),
  onEvmFlowStatus: (cb: (status: string) => void): Unsubscribe => onChannel('evmflow:status', cb),

  // Trading (native Jupiter swap terminal, Solana-only). The private key stays in
  // the main process — these only move the public address, balances, quotes + results.
  tradeWalletInfo: (): Promise<TradeWalletInfo> => ipcRenderer.invoke('trade:walletInfo'),
  tradeListWallets: (): Promise<TradeWalletSummary[]> => ipcRenderer.invoke('trade:listWallets'),
  tradeSelectWallet: (address: string): Promise<TradeWalletInfo> => ipcRenderer.invoke('trade:selectWallet', address),
  tradeGenerateWallet: (): Promise<TradeWalletInfo> => ipcRenderer.invoke('trade:generateWallet'),
  tradeImportWallet: (secret: string): Promise<TradeWalletInfo> => ipcRenderer.invoke('trade:importWallet', secret),
  tradeRemoveWallet: (address?: string): Promise<TradeWalletInfo> => ipcRenderer.invoke('trade:removeWallet', address),
  tradeRevealSecret: (): Promise<string | null> => ipcRenderer.invoke('trade:revealSecret'),
  tradeAddress: (): Promise<string | null> => ipcRenderer.invoke('trade:address'),
  tradeTokenBalance: (mint: string): Promise<TradeTokenBalance> => ipcRenderer.invoke('trade:tokenBalance', mint),
  tradeWalletTokens: (): Promise<TradeHolding[]> => ipcRenderer.invoke('trade:walletTokens'),
  tradeTokenTrades: (mint: string): Promise<TokenTrade[]> => ipcRenderer.invoke('trade:tokenTrades', mint),
  tradeQuote: (p: { side: TradeSide; mint: string; amount: number; slippageBps: number }): Promise<TradeQuote> =>
    ipcRenderer.invoke('trade:quote', p),
  tradeSwap: (p: { side: TradeSide; mint: string; amount: number; slippageBps: number; speed: TradeSpeed; dynamicSlippage?: boolean }): Promise<TradeResult> =>
    ipcRenderer.invoke('trade:swap', p),
  tradeSellAll: (p: { mint: string; slippageBps?: number; speed?: TradeSpeed }): Promise<TradeResult> =>
    ipcRenderer.invoke('trade:sellAll', p)
};

contextBridge.exposeInMainWorld('api', api);

export type WalletLookupApi = typeof api;
