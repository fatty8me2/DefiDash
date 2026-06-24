export type Chain = 'ethereum' | 'solana';

// Persisted user settings: API keys + preferences. Saved encrypted on-device.
export interface AppSettings {
  // API keys
  alchemyKey: string;
  heliusKey: string;
  etherscanKey: string;
  cieloKey: string;
  // Lookup
  defaultBuyers: number;          // 50 | 100 | 200 — buyers fetched per lookup
  // Feed controls
  feedV2Enabled: boolean;
  feedVerifiedEnabled: boolean;
  feedTrendingEnabled: boolean;
  trendingRefreshSec: number;     // how often the trending panel refreshes
  // Trending low-cap filter (0 = no limit)
  trendingMaxFdvUsd: number;      // hide tokens with FDV above this
  trendingMinLiqUsd: number;      // hide tokens with liquidity below this
  // System
  launchOnStartup: boolean;
  notifyVerified: boolean;        // desktop notification on new verified launch
  // Dale — shared charts ledger synced across clients via Firebase Realtime DB.
  displayName: string;            // who you are in the shared ledger (e.g. Mickey / Cam)
  daleFirebaseUrl: string;        // Firebase Realtime DB base URL (same for all 3 clients)
  daleFirebaseSecret: string;     // DB auth secret/token (shared); blank = open rules
  // Whole-app access gate — per-person code checked against the operator's allowlist.
  accessCode: string;             // this install's access code (assigned by the operator)
}

// A wallet the user has pinned to the Tracked Wallets dashboard. Persisted
// on-device (plain JSON — these are public addresses + a user label).
export interface TrackedWallet {
  address: string;
  chain: Chain;
  label: string;      // user-given nickname, may be ''
  addedAt: number;    // unix seconds
}

// A buy/sell detected on a tracked wallet — surfaced as an in-app toast.
export interface TrackedActivity {
  id: string;                 // signature (sol) or `${hash}:${token}:${action}` (eth) — for dedup
  chain: Chain;
  wallet: string;
  label: string;              // user label, or short address
  action: 'buy' | 'sell';
  tokenSymbol: string | null;
  tokenMint: string;          // token mint / contract
  tokenAmount: number | null; // human units of the token
  nativeAmount: number | null; // SOL/ETH spent (buy) or received (sell)
  nativeSymbol: string;       // 'SOL' | 'ETH'
  timestamp: number;          // unix seconds
}

export interface BuyerRow {
  chain: Chain;
  wallet: string;
  txHash: string;
  blockTime: number; // unix seconds
  tokenAmount: number;
  spentAmount: number; // ETH for eth chain, SOL for solana
  spentSymbol: string; // 'ETH' or 'SOL' (or 'USDC' if paired vs stable)
  usdValue: number | null;
  // Enrichment (filled in asynchronously)
  walletAgeDays?: number | null;
  walletTxCount?: number | null;
  nativeBalance?: number | null;     // ETH or SOL
  tokenCount?: number | null;        // distinct tokens held
  stillHoldingPct?: number | null;   // 0..1+ of bought amount
  isContract?: boolean | null;       // ETH only
  smartScore?: number | null;
  cieloPnlUsd?: number | null;       // realized 30d PnL from Cielo (if key set)
  cieloWinRatePct?: number | null;   // win rate from Cielo (if key set)
}

export interface WalletHolding {
  symbol: string;
  amount: number;
  contract: string;
  usdValue: number | null;
}

export interface WalletRecentBuy {
  symbol: string;
  amount: number;
  contract: string;
  blockTime: number;
  txHash: string;
  usdValue: number | null;
}

export interface WalletDetail {
  wallet: string;
  chain: Chain;
  fundingSource: string | null;     // address or label (CEX name, Tornado, etc.)
  fundingTime: number | null;
  topHoldings: WalletHolding[];
  recentBuys: WalletRecentBuy[];
}

export interface DevWalletInfo {
  address: string;
  chain: Chain;
  fundingSource: string | null;       // labelled or short address
  fundingTime: number | null;
  ageDays: number | null;
  txCount: number | null;
  nativeBalance: number | null;       // ETH or SOL
  deploysFound: number | null;        // best-effort count of contract creations / mints
  deploysCapped: boolean;             // true if we hit our scan cap (so the real count may be higher)
  currentHoldingPct: number | null;   // % of this token's total supply still held by the dev
}

export interface LookupResult {
  chain: Chain;
  contract: string;
  tokenSymbol?: string;
  tokenName?: string;
  poolAddress?: string;
  buyers: BuyerRow[];
  fetchedAt: number;
}

export interface LookupError {
  error: string;
  details?: string;
}

export interface LiveFeedItem {
  contract: string;            // token contract (the non-WETH side of the new pair)
  pair: string;                // pair contract address
  symbol: string | null;
  name: string | null;
  blockTime: number;           // unix seconds (deploy time, approximated via PairCreated block)
  txHash: string;              // the PairCreated tx
  verifiedAt?: number;         // unix seconds when Etherscan reported it verified
}

// A point-in-time snapshot of the main-process rolling buffers for the V2
// Deploys + Verified Launches feeds. The renderer fetches this when the
// Dashboard mounts so the panels show recent history instead of starting blank.
export interface LiveFeedSnapshot {
  v2: LiveFeedItem[];          // most-recent-first
  verified: LiveFeedItem[];    // most-recent-first
  v2Status: string;
  verifiedStatus: string;
}

export type HoneypotVerdict = 'safe' | 'caution' | 'danger' | 'unknown';

export interface HoneypotReport {
  chain: Chain;
  contract: string;
  verdict: HoneypotVerdict;
  isHoneypot: boolean;          // explicit honeypot detection (ETH only — Solana doesn't have this concept)
  buyTaxPct: number | null;     // ETH
  sellTaxPct: number | null;    // ETH
  transferTaxPct: number | null; // ETH + Solana
  mintAuthorityActive: boolean | null;   // Solana — creator can mint more
  freezeAuthorityActive: boolean | null; // Solana — creator can freeze wallets
  transferFeeUpgradable: boolean | null; // Solana
  topHolderPct: number | null;  // % held by largest wallet
  topHolderLocked: boolean | null; // is the top holder a known lock/contract
  holderCount: number | null;

  // ETH-specific contract signals. true = "is in that state", null = unknown.
  // Polarity (whether true = good or bad) is interpreted in the UI.
  contractVerified: boolean | null;   // true = source verified (good)
  ownershipRenounced: boolean | null; // true = renounced (good)
  isMintable: boolean | null;         // true = mintable (bad)
  isProxy: boolean | null;            // true = proxy / upgradable (bad)
  transferPausable: boolean | null;   // true = owner can pause (bad)
  hasBlacklist: boolean | null;       // true = blacklist function exists (bad)
  taxModifiable: boolean | null;      // true = owner can change tax (bad)
  perWalletTaxModifiable: boolean | null; // true = selective scam vector (bad)
  hiddenOwner: boolean | null;        // true = hidden owner (bad)
  canSelfDestruct: boolean | null;    // true = bad
  canTakeBackOwnership: boolean | null; // true = bad
  ownerChangeBalance: boolean | null; // true = owner can edit any balance (bad)
  tradingCooldown: boolean | null;    // true = bad
  cannotBuy: boolean | null;          // true = bad
  cannotSellAll: boolean | null;      // true = bad
  liquidityLocked: boolean | null;    // true = LP locked or burned (good)
  liquidityUsd: number | null;        // current main-pool liquidity in USD (live, via DexScreener)
  volume24hUsd: number | null;        // 24h volume in USD
  pairAgeDays: number | null;         // age of the main trading pair
  mainPairLabel: string | null;       // e.g. "Uniswap V3 / WETH"
  trustList: boolean | null;          // true = GoPlus-curated trusted token (USDC, USDT, WETH, etc.)
  riskScore: number;                  // 0+ weighted score used to derive the verdict
  creatorAddress: string | null;      // address that deployed the contract / created the mint

  flags: string[];              // human-readable risk flags
  source: string;               // which API gave us the data
}

// --- Trending / discovery (GeckoTerminal, no API key required) ---
export type TrendingList = 'trending' | 'new' | 'volume';

export interface TrendingToken {
  contract: string;             // base token contract address
  pairAddress: string;          // the pool/pair address
  symbol: string | null;
  name: string | null;
  priceUsd: number | null;
  priceChangeH1: number | null;   // % change, 1h
  priceChangeH24: number | null;  // % change, 24h
  volumeH24Usd: number | null;
  liquidityUsd: number | null;    // reserve in USD
  fdvUsd: number | null;
  marketCapUsd: number | null;
  buysH24: number | null;
  sellsH24: number | null;
  poolCreatedAt: number | null;   // unix seconds
  pairLabel: string | null;       // e.g. "PEPE / WETH"
}

// --- Sniper / bundle launch analysis ---
export interface SniperAnalysis {
  pairCreatedAt: number | null;   // unix seconds, pool creation
  windowSeconds: number;          // how wide the "sniper" window is
  totalEarly: number;             // buyers sampled in the early window
  sniperCount: number;            // unique wallets that bought within windowSeconds of creation
  sniperSupplyPct: number | null; // % of sampled early token volume captured by snipers
  freshSniperCount: number;       // snipers that are also fresh wallets
  note: string | null;            // human summary
}

export interface FunderCluster {
  funder: string;                 // shared funding source (address or label)
  funderLabel: string | null;     // CEX name etc. if known
  wallets: string[];              // buyer wallets sharing this funder
}

export interface BundleAnalysis {
  checked: number;                // how many buyer wallets we resolved a funder for
  clusters: FunderCluster[];      // groups of 2+ wallets sharing a non-CEX funder
  note: string | null;
}

// --- Pump Flow (live pump.fun net-inflow tracker via Helius logsSubscribe) ---
export type FlowTab = 'top' | 'early' | 'dipping';

export interface FlowToken {
  mint: string;                   // SPL mint address
  symbol: string | null;
  name: string | null;
  uri: string | null;             // metadata URI (for lazy icon loading)
  netInflowSol: number;           // buy SOL − sell SOL over the window
  buyVolSol: number;              // gross SOL spent buying over the window
  sellVolSol: number;             // gross SOL received selling over the window
  txCount: number;                // trades in the window
  buyCount: number;
  sellCount: number;
  priceUsd: number | null;        // last observed token price
  marketCapUsd: number | null;    // priceUsd × pump.fun fixed supply (1e9)
  firstSeen: number;              // unix sec — earliest trade we observed for this mint
  lastTrade: number;              // unix sec — most recent trade
  spark: number[];                // cumulative net-inflow series across the window (for the chart)
  bundledPct: number | null;      // % of total supply bought in the launch bundle (same slot as creation); null if the launch wasn't observed live
  bundleWallets: number;          // distinct wallets in that launch bundle
}

export interface FlowSnapshot {
  tokens: FlowToken[];            // active mints in the window, unsorted (UI derives Top/Early/Dipping)
  windowMinutes: number;
  solPriceUsd: number | null;     // derived from trade USD values
  updatedAt: number;              // unix sec
}

// --- EVM Flow (live net-native-inflow tracker via Alchemy logs: ETH + Base + BNB) ---
export type EvmFlowChain = 'ethereum' | 'base' | 'bnb';

export interface EvmFlowToken {
  address: string;                // ERC-20 contract address
  symbol: string | null;
  name: string | null;
  netInflowEth: number;           // buy ETH − sell ETH over the window (WETH-paired trades)
  buyVolEth: number;              // gross ETH spent buying over the window
  sellVolEth: number;             // gross ETH received selling over the window
  txCount: number;                // trades in the window
  buyCount: number;
  sellCount: number;
  priceUsd: number | null;        // last observed token price (USD)
  firstSeen: number;              // unix sec — earliest trade we observed
  lastTrade: number;              // unix sec — most recent trade
  spark: number[];                // cumulative net-inflow series across the window
}

export interface EvmFlowSnapshot {
  chain: EvmFlowChain;            // which network this snapshot is for
  tokens: EvmFlowToken[];         // active tokens in the window, unsorted (UI derives tabs)
  windowMinutes: number;
  ethPriceUsd: number | null;     // derived from WETH trade USD values
  updatedAt: number;              // unix sec
}

// --- Trading (native Jupiter swap terminal, Solana-only) ---
// The private key lives ONLY in the main process (encrypted at rest via
// safeStorage); the renderer only ever sees the public address + balances.
export type TradeSide = 'buy' | 'sell';

// Trade speed / priority-fee tier. Higher = pays a bigger priority fee so the
// swap lands faster in congestion (and costs more SOL).
export type TradeSpeed = 'normal' | 'fast' | 'turbo';

export interface TradeWalletInfo {
  exists: boolean;
  address: string | null;        // public key, base58 (safe to expose)
  solBalance: number | null;     // SOL, null until/unless fetched
}

// One wallet in the multi-wallet store (public address + whether it's active).
export interface TradeWalletSummary {
  address: string;
  active: boolean;
}

export interface TradeQuote {
  side: TradeSide;
  mint: string;                  // the SPL token being bought/sold
  inputMint: string;
  outputMint: string;
  inUiAmount: number;            // human units (SOL for buy, token for sell)
  outUiAmount: number;           // human units received
  priceImpactPct: number | null; // 0..1 (e.g. 0.012 = 1.2%)
  slippageBps: number;
  routeLabels: string[];         // AMM labels along the route
  usdValue: number | null;       // Jupiter's swapUsdValue if present
}

export interface TradeResult {
  ok: boolean;
  signature: string | null;
  error: string | null;
}

// Per-mint balance the connected trading wallet holds (for Sell + Max).
export interface TradeTokenBalance {
  mint: string;
  uiAmount: number;              // human units held
  decimals: number;
}

// A recent on-chain swap for a token (for the Charts transactions drawer).
export interface TokenTrade {
  signature: string;
  timestamp: number;          // unix seconds
  action: 'buy' | 'sell';
  tokenAmount: number;        // human units of the token traded
  solAmount: number | null;   // SOL spent (buy) / received (sell); null for non-SOL routes
  trader: string;             // fee payer (the trader)
}

// A fungible SPL token held by the trading wallet (for the holdings list).
export interface TradeHolding {
  mint: string;
  symbol: string | null;
  name: string | null;
  uiAmount: number;              // human units held
  decimals: number;
  usdValue: number | null;       // total USD value if Helius has a price
}

// ── API usage metering (the "API Usage" page) ──────────────────────────────
// Locally-counted requests this app has made to each provider, within the app's
// own rolling windows. See src/main/apiUsage.ts for how these are tallied.
export interface ApiUsageWindow {
  used: number;
  limit: number | null;          // documented free-tier cap, or null when unknown (count only)
}
export interface ApiProviderUsage {
  id: string;
  label: string;
  keyed: boolean;                // provider requires an API key
  configured: boolean;           // key present (always true for keyless providers)
  note?: string;                 // human-readable limit caveat
  docsUrl?: string;              // provider dashboard/docs link
  minute: ApiUsageWindow;        // requests in the last 60s vs soft rate cap
  day: ApiUsageWindow;
  month: ApiUsageWindow;
  total: number;                 // all-time requests since metering began
}
export interface ApiUsageSnapshot {
  resetDay: string;              // 'YYYY-MM-DD' the day counters last reset
  resetMonth: string;            // 'YYYY-MM' the month counters last reset
  providers: ApiProviderUsage[];
}

// ── Dale: shared charts ledger (Firebase Realtime DB) ──────────────────────
// A running list of charts shared live between all configured clients. Anyone
// can add or remove; entries are labeled with who added them.
export interface DaleEntry {
  id: string;        // Firebase push key (stable across clients)
  address: string;   // token mint (Solana) or 0x contract (ETH)
  addedBy: string;   // displayName of whoever added it
  addedAt: number;   // unix ms
}
export interface DaleSnapshot {
  entries: DaleEntry[];   // newest first
  status: DaleStatus;
}
// 'off' = not configured · 'connecting' · 'live' · 'error' (with reason)
export type DaleStatus = 'off' | 'connecting' | 'live' | `error: ${string}`;

// ── Whole-app access gate ──────────────────────────────────────────────────
// The app checks a per-person code against the operator's Firebase allowlist on
// launch + periodically; the operator revokes by flipping the code's `allowed`
// flag. See src/main/accessGate.ts.
//  checking     — verifying (or couldn't reach the server yet)
//  allowed      — code is on the allowlist; app unlocked
//  revoked      — code missing or allowed=false; locked
//  unconfigured — no code entered yet (first run); prompt for one
//  stale        — was allowed but offline past the grace window; locked until online
export type AccessStatus = 'checking' | 'allowed' | 'revoked' | 'unconfigured' | 'stale';
export interface AccessState {
  status: AccessStatus;
  name: string | null;   // display name from the allowlist entry, if any
  message?: string;       // optional human-readable detail (e.g. offline notice)
}
