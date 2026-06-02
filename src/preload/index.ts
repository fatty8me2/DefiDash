import { contextBridge, ipcRenderer } from 'electron';
import type { AppSettings, BundleAnalysis, BuyerRow, Chain, DevWalletInfo, EvmFlowChain, EvmFlowSnapshot, FlowSnapshot, HoneypotReport, LiveFeedItem, LookupResult, SniperAnalysis, TrendingList, TrendingToken, WalletDetail } from '../shared/types';

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
  honeypotCheck: (chain: Chain, contract: string): Promise<HoneypotReport> =>
    ipcRenderer.invoke('lookup:honeypot', { chain, contract }),
  devWalletInfo: (chain: Chain, contract: string, creatorHint: string | null): Promise<DevWalletInfo | null> =>
    ipcRenderer.invoke('lookup:dev', { chain, contract, creatorHint }),
  configStatus: (): Promise<{ hasAlchemy: boolean; hasHelius: boolean; hasEtherscan: boolean; hasCielo: boolean }> =>
    ipcRenderer.invoke('config:status'),
  getSettings: (): Promise<SettingsShape> => ipcRenderer.invoke('settings:get'),
  saveSettings: (s: SettingsShape): Promise<void> => ipcRenderer.invoke('settings:save', s),

  checkForUpdates: (): Promise<void> => ipcRenderer.invoke('updates:check'),
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),

  getTrending: (list: TrendingList): Promise<TrendingToken[]> =>
    ipcRenderer.invoke('trending:get', list),
  analyzeLaunch: (
    chain: Chain,
    contract: string
  ): Promise<{ sniper: SniperAnalysis; bundle: BundleAnalysis }> =>
    ipcRenderer.invoke('launch:analyze', { chain, contract }),

  startFeeds: (): Promise<void> => ipcRenderer.invoke('feeds:start'),
  stopFeeds: (): Promise<void> => ipcRenderer.invoke('feeds:stop'),
  onV2Deploy: (cb: (item: LiveFeedItem) => void): Unsubscribe => onChannel('feed:v2deploy', cb),
  onV2DeployUpdate: (cb: (item: LiveFeedItem) => void): Unsubscribe => onChannel('feed:v2deploy:update', cb),
  onV2Status: (cb: (status: string) => void): Unsubscribe => onChannel('feed:v2status', cb),
  onVerifiedLaunch: (cb: (item: LiveFeedItem) => void): Unsubscribe => onChannel('feed:verified', cb),
  onVerifiedStatus: (cb: (status: string) => void): Unsubscribe => onChannel('feed:verifiedstatus', cb),
  onNotifyOpen: (cb: (contract: string) => void): Unsubscribe => onChannel('feed:notify-open', cb),

  // Pump Flow (live pump.fun net-inflow stream)
  startFlow: (): Promise<void> => ipcRenderer.invoke('flow:start'),
  stopFlow: (): Promise<void> => ipcRenderer.invoke('flow:stop'),
  onFlowUpdate: (cb: (snap: FlowSnapshot) => void): Unsubscribe => onChannel('flow:update', cb),
  onFlowStatus: (cb: (status: string) => void): Unsubscribe => onChannel('flow:status', cb),

  // EVM Flow (live Uniswap V2 net-ETH-inflow stream, ETH + Base)
  startEvmFlow: (chain: EvmFlowChain): Promise<void> => ipcRenderer.invoke('evmflow:start', chain),
  stopEvmFlow: (): Promise<void> => ipcRenderer.invoke('evmflow:stop'),
  onEvmFlowUpdate: (cb: (snap: EvmFlowSnapshot) => void): Unsubscribe => onChannel('evmflow:update', cb),
  onEvmFlowStatus: (cb: (status: string) => void): Unsubscribe => onChannel('evmflow:status', cb)
};

contextBridge.exposeInMainWorld('api', api);

export type WalletLookupApi = typeof api;
