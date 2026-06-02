import type { Chain, HoneypotReport, HoneypotVerdict } from '../../shared/types';

const UNKNOWN = (chain: Chain, contract: string, source: string): HoneypotReport => ({
  chain,
  contract,
  verdict: 'unknown',
  isHoneypot: false,
  buyTaxPct: null,
  sellTaxPct: null,
  transferTaxPct: null,
  mintAuthorityActive: null,
  freezeAuthorityActive: null,
  transferFeeUpgradable: null,
  topHolderPct: null,
  topHolderLocked: null,
  holderCount: null,
  liquidityUsd: null,
  volume24hUsd: null,
  pairAgeDays: null,
  mainPairLabel: null,
  trustList: null,
  riskScore: 0,
  creatorAddress: null,
  contractVerified: null,
  ownershipRenounced: null,
  isMintable: null,
  isProxy: null,
  transferPausable: null,
  hasBlacklist: null,
  taxModifiable: null,
  perWalletTaxModifiable: null,
  hiddenOwner: null,
  canSelfDestruct: null,
  canTakeBackOwnership: null,
  ownerChangeBalance: null,
  tradingCooldown: null,
  cannotBuy: null,
  cannotSellAll: null,
  liquidityLocked: null,
  flags: [],
  source
});

// GoPlus returns "0" / "1" strings, but absent for unknown.
// Map to true/false/null so the UI knows when to show a gray "unknown" chip.
function tri(v: string | undefined): boolean | null {
  if (v === '1') return true;
  if (v === '0') return false;
  return null;
}

interface LiquiditySnapshot {
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  pairAgeDays: number | null;
  mainPairLabel: string | null;
}

// Live liquidity check via DexScreener. The most reliable "rug detector": if the
// main pool's USD liquidity is near zero RIGHT NOW, the LP has been pulled
// (or never existed), regardless of what GoPlus's snapshot says about is_locked.
async function getLiquiditySnapshot(chain: Chain, contract: string): Promise<LiquiditySnapshot> {
  const empty: LiquiditySnapshot = {
    liquidityUsd: null, volume24hUsd: null, pairAgeDays: null, mainPairLabel: null
  };
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${contract}`);
    if (!res.ok) return empty;
    const data = await res.json();
    const chainId = chain === 'ethereum' ? 'ethereum' : 'solana';
    const pairs = ((data?.pairs ?? []) as any[]).filter(
      (p) => p.chainId === chainId &&
        (chain === 'ethereum'
          ? p.baseToken?.address?.toLowerCase() === contract.toLowerCase()
          : p.baseToken?.address === contract)
    );
    if (pairs.length === 0) return empty;

    // Main pair = highest current liquidity
    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const top = pairs[0];
    const liquidityUsd = top.liquidity?.usd ?? null;
    const volume24hUsd = top.volume?.h24 ?? null;
    const pairAgeDays = top.pairCreatedAt
      ? Math.floor((Date.now() - Number(top.pairCreatedAt)) / 86400_000)
      : null;
    const dex = top.dexId ?? '?';
    const quote = top.quoteToken?.symbol ?? '?';
    const mainPairLabel = `${dex} / ${quote}`;

    return { liquidityUsd, volume24hUsd, pairAgeDays, mainPairLabel };
  } catch {
    return empty;
  }
}

// Risk weight from current liquidity. Tuned to catch rug-pulled tokens
// (which collapse to <$1k) while not flagging brand-new low-cap launches too hard.
function liquidityRiskScore(snap: LiquiditySnapshot): { score: number; flags: string[] } {
  const flags: string[] = [];
  let score = 0;
  const liq = snap.liquidityUsd;
  const vol = snap.volume24hUsd ?? 0;
  const age = snap.pairAgeDays ?? 0;

  if (liq === null) return { score: 0, flags };

  if (liq < 500) {
    score += 100;
    flags.push(`LIQUIDITY PULLED — only $${liq.toFixed(0)} left in the main pool`);
  } else if (liq < 2_000) {
    score += 50;
    flags.push(`very low liquidity — only $${Math.round(liq).toLocaleString()} in the main pool`);
  } else if (liq < 5_000) {
    score += 20;
    flags.push(`low liquidity — $${Math.round(liq).toLocaleString()} in the main pool`);
  }

  // Dead market on an established pair: pool exists but nobody's trading.
  // (Brand-new pair gets a pass — low volume there is normal.)
  if (age >= 2 && vol < 200 && liq >= 500) {
    score += 25;
    flags.push(`dead market — only $${Math.round(vol).toLocaleString()} traded in 24h`);
  }

  return { score, flags };
}

// --- Ethereum (GoPlus Security) ---
// Docs: https://docs.gopluslabs.io/reference/api-overview-token-risk
// GoPlus returns string fields like "0" / "1" for booleans and decimals like "0.05" for 5%.
interface GoPlusEthEntry {
  is_honeypot?: string;
  cannot_buy?: string;
  cannot_sell_all?: string;
  buy_tax?: string;
  sell_tax?: string;
  is_open_source?: string;
  is_proxy?: string;
  is_mintable?: string;
  can_take_back_ownership?: string;
  hidden_owner?: string;
  selfdestruct?: string;
  slippage_modifiable?: string;
  personal_slippage_modifiable?: string;
  transfer_pausable?: string;
  trading_cooldown?: string;
  is_blacklisted?: string;
  owner_change_balance?: string;
  trust_list?: string;
  creator_address?: string;
  holder_count?: string;
  holders?: { address?: string; tag?: string; percent?: string; is_locked?: number }[];
  lp_holders?: { address?: string; tag?: string; percent?: string; is_locked?: number }[];
}

interface GoPlusEthResponse {
  code?: number;
  message?: string;
  result?: Record<string, GoPlusEthEntry>;
}

function isTrue(v: string | undefined): boolean {
  return v === '1';
}

function parsePct(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // GoPlus returns 0.05 for 5%. Multiply to get a percent number.
  return n * 100;
}

async function checkEthereum(contract: string): Promise<HoneypotReport> {
  try {
    const url = `https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=${contract.toLowerCase()}`;
    const [res, liq] = await Promise.all([
      fetch(url, { headers: { accept: 'application/json' } }),
      getLiquiditySnapshot('ethereum', contract)
    ]);
    if (!res.ok) {
      // Still return a partial report based on liquidity alone if GoPlus is down,
      // since a liquidity-pulled token is still detectable without GoPlus.
      const fallback = UNKNOWN('ethereum', contract, 'gopluslabs');
      Object.assign(fallback, liq);
      const liqRisk = liquidityRiskScore(liq);
      fallback.riskScore = liqRisk.score;
      fallback.flags = liqRisk.flags;
      if (liqRisk.score >= 100) fallback.verdict = 'danger';
      else if (liqRisk.score >= 30) fallback.verdict = 'caution';
      return fallback;
    }
    const data: GoPlusEthResponse = await res.json();
    const entry =
      data.result?.[contract.toLowerCase()] ??
      data.result?.[contract] ??
      (data.result ? Object.values(data.result)[0] : undefined);
    if (!entry) return UNKNOWN('ethereum', contract, 'gopluslabs');

    const isHoneypot = tri(entry.is_honeypot) === true;
    const buyTax = parsePct(entry.buy_tax);
    const sellTax = parsePct(entry.sell_tax);
    const trustList = tri(entry.trust_list);

    const contractVerified = tri(entry.is_open_source);
    const isMintable = tri(entry.is_mintable);
    const isProxy = tri(entry.is_proxy);
    const transferPausable = tri(entry.transfer_pausable);
    const hasBlacklist = tri(entry.is_blacklisted);
    const taxModifiable = tri(entry.slippage_modifiable);
    const perWalletTaxModifiable = tri(entry.personal_slippage_modifiable);
    const hiddenOwner = tri(entry.hidden_owner);
    const canSelfDestruct = tri(entry.selfdestruct);
    const canTakeBackOwnership = tri(entry.can_take_back_ownership);
    const ownerChangeBalance = tri(entry.owner_change_balance);
    const tradingCooldown = tri(entry.trading_cooldown);
    const cannotBuy = tri(entry.cannot_buy);
    const cannotSellAll = tri(entry.cannot_sell_all);

    // Find largest non-LP, non-burn holder for concentration signal.
    const BURN = new Set(['0x000000000000000000000000000000000000dead', '0x0000000000000000000000000000000000000000']);
    const realHolders = (entry.holders ?? []).filter((h) => {
      const a = (h.address ?? '').toLowerCase();
      const tag = (h.tag ?? '').toLowerCase();
      if (!a) return false;
      if (BURN.has(a)) return false;
      if (tag.includes('uniswap') || tag.includes('pancake') || tag.includes('sushiswap') || tag.includes('lp')) return false;
      return true;
    });
    const topHolderPct = realHolders[0]?.percent ? Number(realHolders[0].percent) * 100 : null;
    const topHolderLocked = realHolders[0]?.is_locked === 1;
    const holderCount = entry.holder_count ? parseInt(entry.holder_count, 10) : null;

    // Liquidity locked? Look at LP holders — locked or sent to burn.
    const lp = entry.lp_holders ?? [];
    const liquidityLocked = lp.length > 0
      ? lp.some((h) => {
          const a = (h.address ?? '').toLowerCase();
          return h.is_locked === 1 || BURN.has(a);
        })
      : null;

    // ownershipRenounced isn't a direct GoPlus field — derive from a few signals.
    // If the contract can_take_back_ownership = false AND owner_change_balance = false
    // AND hidden_owner = false, treat ownership as effectively safe.
    // (GoPlus also returns owner_address/balance but inconsistently; this is a reasonable proxy.)
    const ownershipRenounced =
      canTakeBackOwnership === false &&
      ownerChangeBalance === false &&
      hiddenOwner === false
        ? true
        : (canTakeBackOwnership === true || ownerChangeBalance === true || hiddenOwner === true)
          ? false
          : null;

    const flags: string[] = [];
    if (isHoneypot) flags.push('HONEYPOT — sells are blocked');
    if (cannotBuy === true) flags.push("can't buy — contract blocks buys");
    if (cannotSellAll === true) flags.push("can't sell entire balance");
    if (buyTax !== null && buyTax >= 10) flags.push(`high buy tax ${buyTax.toFixed(1)}%`);
    if (sellTax !== null && sellTax >= 10) flags.push(`high sell tax ${sellTax.toFixed(1)}%`);
    if (sellTax !== null && buyTax !== null && sellTax - buyTax >= 10) flags.push('sell tax >> buy tax');
    if (contractVerified === false) flags.push('contract NOT verified (source code hidden)');
    if (isProxy === true) flags.push('proxy contract — logic can be upgraded');
    if (isMintable === true) flags.push('mintable — owner can inflate supply');
    if (hiddenOwner === true) flags.push('hidden owner');
    if (canTakeBackOwnership === true) flags.push('ownership can be reclaimed after renounce');
    if (canSelfDestruct === true) flags.push('contract can self-destruct');
    if (taxModifiable === true) flags.push('owner can change tax/slippage');
    if (perWalletTaxModifiable === true) flags.push('owner can set per-wallet tax (selective scam)');
    if (transferPausable === true) flags.push('owner can pause all transfers');
    if (tradingCooldown === true) flags.push('trading cooldown between txs');
    if (hasBlacklist === true) flags.push('blacklist function exists');
    if (ownerChangeBalance === true) flags.push('owner can modify any balance');
    if (liquidityLocked === false) flags.push('liquidity NOT locked');
    if (topHolderPct !== null && topHolderPct >= 25) flags.push(`top wallet holds ${topHolderPct.toFixed(0)}%`);
    if (holderCount !== null && holderCount < 50) flags.push(`only ${holderCount} holders`);

    // Weighted risk score. Each signal contributes; threshold gives the verdict.
    // Anything ≥100 is treated as immediate danger; a single 100-point signal trips it
    // even with no other red flags. Anything <30 is "safe". Between is "caution".
    let riskScore = 0;
    const add = (n: number) => { riskScore += n; };

    // Hard-stop danger signals (each enough on its own).
    if (isHoneypot) add(100);
    if (cannotBuy === true) add(100);
    if (cannotSellAll === true) add(100);
    if (perWalletTaxModifiable === true) add(100);
    if (hiddenOwner === true) add(100);
    if (canSelfDestruct === true) add(80);

    // Tax tiers.
    if (sellTax !== null) {
      if (sellTax >= 30) add(100);
      else if (sellTax >= 15) add(40);
      else if (sellTax >= 10) add(15);
    }
    if (buyTax !== null) {
      if (buyTax >= 30) add(100);
      else if (buyTax >= 15) add(40);
      else if (buyTax >= 10) add(15);
    }
    if (sellTax !== null && buyTax !== null && sellTax - buyTax >= 10) add(25);

    // Ownership / upgradability concerns — meaningful but not auto-danger.
    if (ownerChangeBalance === true) add(35);
    if (canTakeBackOwnership === true) add(30);
    if (transferPausable === true) add(25);
    if (taxModifiable === true) add(20);
    if (isMintable === true) add(15);
    if (isProxy === true) add(10);
    if (hasBlacklist === true) add(10);
    if (contractVerified === false) add(20);
    if (tradingCooldown === true) add(5);

    // Concentration & liquidity.
    if (topHolderPct !== null) {
      if (topHolderPct >= 70) add(50);
      else if (topHolderPct >= 50) add(30);
      else if (topHolderPct >= 35) add(15);
    }
    if (liquidityLocked === false) add(25);
    if (holderCount !== null && holderCount < 50) add(15);

    // Live liquidity check (catches rug pulls GoPlus's snapshot may have missed).
    const liqRisk = liquidityRiskScore(liq);
    add(liqRisk.score);
    flags.push(...liqRisk.flags);

    // Trusted tokens (Circle's USDC, USDT, WETH, etc.) are EXPECTED to have
    // proxy/blacklist/freeze functions for compliance — override caution.
    let verdict: HoneypotVerdict = 'safe';
    if (riskScore >= 100) verdict = 'danger';
    else if (riskScore >= 30) verdict = 'caution';

    if (trustList === true && verdict === 'caution') verdict = 'safe';

    return {
      chain: 'ethereum',
      contract,
      verdict,
      isHoneypot,
      buyTaxPct: buyTax,
      sellTaxPct: sellTax,
      transferTaxPct: null,
      mintAuthorityActive: null,
      freezeAuthorityActive: null,
      transferFeeUpgradable: null,
      topHolderPct,
      topHolderLocked,
      holderCount,
      liquidityUsd: liq.liquidityUsd,
      volume24hUsd: liq.volume24hUsd,
      pairAgeDays: liq.pairAgeDays,
      mainPairLabel: liq.mainPairLabel,
      trustList,
      riskScore,
      creatorAddress: entry.creator_address ?? null,
      contractVerified,
      ownershipRenounced,
      isMintable,
      isProxy,
      transferPausable,
      hasBlacklist,
      taxModifiable,
      perWalletTaxModifiable,
      hiddenOwner,
      canSelfDestruct,
      canTakeBackOwnership,
      ownerChangeBalance,
      tradingCooldown,
      cannotBuy,
      cannotSellAll,
      liquidityLocked,
      flags,
      source: 'gopluslabs'
    };
  } catch {
    return UNKNOWN('ethereum', contract, 'gopluslabs');
  }
}

// --- Solana (GoPlus) ---
interface GoPlusSolanaResponse {
  code?: number;
  result?: Record<string, {
    mintable?: { status?: string };
    freezable?: { status?: string };
    transfer_fee?: { current_fee_rate?: { fee_rate?: string } };
    transfer_fee_upgradable?: { status?: string };
    holders?: { account?: string; balance?: string; percent?: string }[];
  }>;
}

async function checkSolana(contract: string): Promise<HoneypotReport> {
  try {
    const url = `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${contract}`;
    const [res, liq] = await Promise.all([
      fetch(url, { headers: { accept: 'application/json' } }),
      getLiquiditySnapshot('solana', contract)
    ]);
    if (!res.ok) {
      const fallback = UNKNOWN('solana', contract, 'gopluslabs');
      Object.assign(fallback, liq);
      const liqRisk = liquidityRiskScore(liq);
      fallback.riskScore = liqRisk.score;
      fallback.flags = liqRisk.flags;
      if (liqRisk.score >= 100) fallback.verdict = 'danger';
      else if (liqRisk.score >= 30) fallback.verdict = 'caution';
      return fallback;
    }
    const data: GoPlusSolanaResponse = await res.json();
    const entry =
      data.result?.[contract] ?? data.result?.[contract.toLowerCase()] ?? (data.result ? Object.values(data.result)[0] : undefined);
    if (!entry) return UNKNOWN('solana', contract, 'gopluslabs');

    const mintActive = entry.mintable?.status === '1';
    const freezeActive = entry.freezable?.status === '1';
    const transferFeePctStr = entry.transfer_fee?.current_fee_rate?.fee_rate;
    const transferTax = transferFeePctStr ? Number(transferFeePctStr) : null;
    const transferFeeUpgradable = entry.transfer_fee_upgradable?.status === '1';
    const holders = entry.holders ?? [];
    const topHolderPct = holders[0]?.percent ? Number(holders[0].percent) * 100 : null;

    const flags: string[] = [];
    if (mintActive) flags.push('mint authority active — supply can be inflated');
    if (freezeActive) flags.push('freeze authority active — creator can freeze your wallet');
    if (transferTax !== null && transferTax > 0) flags.push(`transfer fee ${transferTax.toFixed(1)}%`);
    if (transferFeeUpgradable) flags.push('transfer fee is upgradable');
    if (topHolderPct !== null && topHolderPct >= 50) flags.push(`top wallet holds ${topHolderPct.toFixed(0)}%`);

    let riskScore = 0;
    const addSol = (n: number) => { riskScore += n; };

    if (freezeActive) addSol(100);                                  // creator can freeze any wallet
    if (transferTax !== null) {
      if (transferTax >= 10) addSol(100);
      else if (transferTax >= 1) addSol(30);
    }
    if (mintActive) addSol(50);                                     // supply can be inflated
    if (transferFeeUpgradable) addSol(35);                          // fee could become a tax later
    if (topHolderPct !== null) {
      if (topHolderPct >= 70) addSol(50);
      else if (topHolderPct >= 50) addSol(30);
      else if (topHolderPct >= 35) addSol(15);
    }

    // Live liquidity check.
    const liqRisk = liquidityRiskScore(liq);
    addSol(liqRisk.score);
    flags.push(...liqRisk.flags);

    let verdict: HoneypotVerdict = 'safe';
    if (riskScore >= 100) verdict = 'danger';
    else if (riskScore >= 30) verdict = 'caution';

    return {
      chain: 'solana',
      contract,
      verdict,
      isHoneypot: false,
      buyTaxPct: null,
      sellTaxPct: null,
      transferTaxPct: transferTax,
      mintAuthorityActive: mintActive,
      freezeAuthorityActive: freezeActive,
      transferFeeUpgradable,
      topHolderPct,
      topHolderLocked: null,
      holderCount: holders.length || null,
      liquidityUsd: liq.liquidityUsd,
      volume24hUsd: liq.volume24hUsd,
      pairAgeDays: liq.pairAgeDays,
      mainPairLabel: liq.mainPairLabel,
      trustList: null,
      riskScore,
      creatorAddress: null, // Solana dev info comes from Helius DAS in devWallet.ts
      contractVerified: null,
      ownershipRenounced: null,
      isMintable: null,
      isProxy: null,
      transferPausable: null,
      hasBlacklist: null,
      taxModifiable: null,
      perWalletTaxModifiable: null,
      hiddenOwner: null,
      canSelfDestruct: null,
      canTakeBackOwnership: null,
      ownerChangeBalance: null,
      tradingCooldown: null,
      cannotBuy: null,
      cannotSellAll: null,
      liquidityLocked: null,
      flags,
      source: 'gopluslabs'
    };
  } catch {
    return UNKNOWN('solana', contract, 'gopluslabs');
  }
}

export async function checkHoneypot(chain: Chain, contract: string): Promise<HoneypotReport> {
  return chain === 'ethereum' ? checkEthereum(contract) : checkSolana(contract);
}
