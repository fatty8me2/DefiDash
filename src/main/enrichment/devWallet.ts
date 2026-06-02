import type { Chain, DevWalletInfo } from '../../shared/types';

// Re-use the same CEX/Tornado label table from walletDetail (kept duplicated here
// to avoid a circular import; keep them in sync if you add new known addresses).
const ETH_KNOWN: Record<string, string> = {
  '0x28c6c06298d514db089934071355e5743bf21d60': 'Binance 14',
  '0xdfd5293d8e347dfe59e90efd55b2956a1343963d': 'Binance 16',
  '0x21a31ee1afc51d94c2efccaa2092ad1028285549': 'Binance 15',
  '0x9696f59e4d72e237be84ffd425dcad154bf96976': 'Binance 4',
  '0x46340b20830761efd32832a74d7169b29feb9758': 'Crypto.com',
  '0x77696bb39917c91a0c3908d577d5e322095425ca': 'Crypto.com 2',
  '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43': 'Coinbase 10',
  '0x71660c4005ba85c37ccec55d0c4493e66fe775d3': 'Coinbase 1',
  '0xa910f92acdaf488fa6ef02174fb86208ad7722ba': 'Coinbase Prime',
  '0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740': 'Coinbase 3',
  '0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503': 'Binance 7',
  '0xf977814e90da44bfa03b6295a0616a897441acec': 'Binance 8',
  '0x910cbd523d972eb0a6f4cae4618ad62622b39dbf': 'Coinbase Hot 9',
  '0x722122df12d4e14e13ac3b6895a86e84145b6967': 'Tornado.Cash',
  '0xd90e2f925da726b50c4ed8d0fb90ad053324f31b': 'Tornado.Cash',
  '0xd96f2b1c14db8458374d9aca76e26c3d18364307': 'Tornado.Cash 1ETH',
  '0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936': 'Tornado.Cash 10ETH'
};

async function ethRpc(apiKey: string, method: string, params: unknown[]): Promise<unknown> {
  const url = `https://eth-mainnet.g.alchemy.com/v2/${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  if (!res.ok) throw new Error(`Alchemy ${method} HTTP ${res.status}`);
  return res.json();
}

// Cap how far back we scan for contract creations. 1000 external txs covers
// most reasonable cases without nuking the user's Alchemy quota.
const DEPLOY_SCAN_CAP = 1000;

async function getEthDevInfo(dev: string, tokenContract: string, alchemyKey: string): Promise<DevWalletInfo> {
  const [balJson, countJson, firstJson, fundingJson, externalJson, tokenBalJson] = await Promise.all([
    ethRpc(alchemyKey, 'eth_getBalance', [dev, 'latest']),
    ethRpc(alchemyKey, 'eth_getTransactionCount', [dev, 'latest']),
    ethRpc(alchemyKey, 'alchemy_getAssetTransfers', [{
      fromAddress: dev,
      category: ['external'],
      order: 'asc',
      withMetadata: true,
      maxCount: '0x1',
      excludeZeroValue: false
    }]),
    ethRpc(alchemyKey, 'alchemy_getAssetTransfers', [{
      toAddress: dev,
      category: ['external'],
      order: 'asc',
      withMetadata: true,
      maxCount: '0x1',
      excludeZeroValue: false
    }]),
    ethRpc(alchemyKey, 'alchemy_getAssetTransfers', [{
      fromAddress: dev,
      category: ['external'],
      order: 'desc',
      withMetadata: false,
      maxCount: `0x${DEPLOY_SCAN_CAP.toString(16)}`,
      excludeZeroValue: false
    }]),
    ethRpc(alchemyKey, 'alchemy_getTokenBalances', [dev, [tokenContract]])
  ]) as any[];

  const nativeBalance = balJson?.result ? Number(BigInt(balJson.result)) / 1e18 : null;
  const txCount = countJson?.result ? parseInt(countJson.result, 16) : null;

  const first = firstJson?.result?.transfers?.[0];
  let ageDays: number | null = null;
  if (first?.metadata?.blockTimestamp) {
    const t = new Date(first.metadata.blockTimestamp).getTime();
    ageDays = Math.floor((Date.now() - t) / 86400_000);
  }

  // Funding source: first INCOMING external tx
  const fundTx = fundingJson?.result?.transfers?.[0];
  let fundingSource: string | null = null;
  let fundingTime: number | null = null;
  if (fundTx) {
    const from = String(fundTx.from).toLowerCase();
    fundingSource = ETH_KNOWN[from] ?? `${from.slice(0, 6)}…${from.slice(-4)}`;
    fundingTime = Math.floor(new Date(fundTx.metadata.blockTimestamp).getTime() / 1000);
  }

  // Deploy count: contract-creation txs have `to: null` in Alchemy's transfers response.
  // We scan up to DEPLOY_SCAN_CAP recent external txs from the dev and tally them.
  const externalTxs = (externalJson?.result?.transfers ?? []) as { to: string | null }[];
  const deploysFound = externalTxs.filter((t) => t.to === null).length;
  const deploysCapped = externalTxs.length >= DEPLOY_SCAN_CAP;

  // Holding %: dev's current balance / total supply of this token.
  // We don't have total supply cheaply, so report dev's balance as a *fraction*
  // of their own peak — close enough for "still holding their dev allocation?".
  // For a real supply % we'd need an extra call; skip for now and leave null.
  const currentHoldingPct: number | null = null;
  void tokenBalJson;

  return {
    address: dev,
    chain: 'ethereum',
    fundingSource,
    fundingTime,
    ageDays,
    txCount,
    nativeBalance,
    deploysFound,
    deploysCapped,
    currentHoldingPct
  };
}

// --- Solana ---
// Use Helius DAS getAsset to fetch the mint authority for the token.
// Then enrich similarly with /balances + /transactions for the dev wallet.
async function getSolDevInfo(tokenMint: string, heliusKey: string): Promise<DevWalletInfo | null> {
  // 1) getAsset to find the authority (the dev / mint authority)
  const assetRes = await fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'asset',
      method: 'getAsset',
      params: { id: tokenMint }
    })
  });
  if (!assetRes.ok) return null;
  const asset = await assetRes.json();
  const auths = asset?.result?.authorities ?? [];
  const creators = asset?.result?.creators ?? [];
  const dev: string | null = auths[0]?.address ?? creators[0]?.address ?? null;
  if (!dev) return null;

  // 2) Enrich the dev address using Helius
  const [balRes, txRes] = await Promise.all([
    fetch(`https://api.helius.xyz/v0/addresses/${dev}/balances?api-key=${heliusKey}`).then((r) => (r.ok ? r.json() : null)),
    (async () => {
      // Walk back to estimate age + count + deploy count (TOKEN_MINT type)
      let oldest: number | null = null;
      let count = 0;
      let mints = 0;
      let before: string | undefined;
      const maxPages = 5;
      for (let i = 0; i < maxPages; i++) {
        const u = new URL(`https://api.helius.xyz/v0/addresses/${dev}/transactions`);
        u.searchParams.set('api-key', heliusKey);
        u.searchParams.set('limit', '100');
        if (before) u.searchParams.set('before', before);
        const r = await fetch(u.toString());
        if (!r.ok) break;
        const txs = await r.json();
        if (!Array.isArray(txs) || txs.length === 0) break;
        count += txs.length;
        // Helius classifies token creations as "TOKEN_MINT" or via the description.
        // Count entries that look like mint-init operations.
        for (const t of txs) {
          if (t.type === 'TOKEN_MINT' || t.type === 'CREATE_POOL' || (t.description ?? '').toLowerCase().includes('created')) {
            mints += 1;
          }
        }
        oldest = txs[txs.length - 1].timestamp ?? oldest;
        if (txs.length < 100) break;
        before = txs[txs.length - 1].signature;
      }
      return { oldest, count, mints, capped: count >= maxPages * 100 };
    })()
  ]);

  const nativeBalance = balRes?.nativeBalance != null ? balRes.nativeBalance / 1e9 : null;
  const ageDays = txRes.oldest ? Math.floor((Date.now() / 1000 - txRes.oldest) / 86400) : null;

  return {
    address: dev,
    chain: 'solana',
    fundingSource: null, // Solana funding-source tracing would require parsing first incoming SOL tx; skipped for v1
    fundingTime: null,
    ageDays,
    txCount: txRes.count,
    nativeBalance,
    deploysFound: txRes.mints,
    deploysCapped: txRes.capped,
    currentHoldingPct: null
  };
}

export async function getDevWalletInfo(
  chain: Chain,
  tokenContract: string,
  creatorHint: string | null,
  keys: { alchemyKey: string; heliusKey: string }
): Promise<DevWalletInfo | null> {
  try {
    if (chain === 'ethereum') {
      if (!creatorHint) return null;
      return await getEthDevInfo(creatorHint, tokenContract, keys.alchemyKey);
    }
    return await getSolDevInfo(tokenContract, keys.heliusKey);
  } catch {
    return null;
  }
}
