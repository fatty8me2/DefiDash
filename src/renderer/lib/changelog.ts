// In-app changelog shown by the "What's New" popup after an update. Keep the
// newest version at the top and add an entry each release.
export interface ChangelogEntry {
  version: string;
  highlights: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '2.13.0',
    highlights: [
      'Defi Dashboard is now available on macOS — a universal build for both Intel and Apple-Silicon Macs.',
      'Access is now managed with a personal code — enter yours once when the app opens.'
    ]
  },
  {
    version: '2.12.0',
    highlights: [
      'New “Dale” shared charts board — beam a chart to your crew with “+ Dale” (or paste an address) and everyone sees it live. Set it up in Settings → Dale (shared charts).',
      'New API Usage tab — see how much of each provider’s free-tier limits you’ve used (this minute / today / this month).'
    ]
  },
  {
    version: '2.11.0',
    highlights: ['Watchlist & Charts now support ETH contracts (0x…) — paste one to track it; charts render via GMGN.']
  },
  {
    version: '2.10.0',
    highlights: ['Trade: new pump.fun (PumpPortal) fallback — coins Jupiter can\'t route now trade directly on the bonding curve.']
  },
  {
    version: '2.9.0',
    highlights: [
      'Trade: clearer quote errors — shows the real reason (e.g. "no swap route") instead of "HTTP 400".',
      'Your tokens: cleaner list with total value and quick actions (★ watchlist, copy mint, hide).'
    ]
  },
  {
    version: '2.8.1',
    highlights: ['Watchlist coins never go "stale" — price/market-cap stay updated even when a coin is quiet.']
  },
  {
    version: '2.8.0',
    highlights: [
      'Trade: fixed intermittent "Quote failed" — quotes now retry and fall back automatically.',
      'Pump Flow stream auto-pauses ~1 min after you leave it (and the watchlist) to save API.'
    ]
  },
  {
    version: '2.7.0',
    highlights: ['Watchlist: paste a token mint to add it manually (no need to drag a card).']
  },
  {
    version: '2.6.0',
    highlights: [
      'New "What\'s New" popup that highlights changes after each update.',
      'You can re-open it anytime from Settings.'
    ]
  },
  {
    version: '2.5.0',
    highlights: ['Tracked Wallets: a persistent list of every buy/sell notification from your tracked wallets.']
  },
  {
    version: '2.4.1',
    highlights: ['Charts: see GMGN\'s transactions under each chart, with a Txns button to toggle them on/off to save space.']
  },
  {
    version: '2.3.0',
    highlights: ['Trade: slippage now defaults to Auto (Jupiter dynamic), with presets and a custom % field.']
  },
  {
    version: '2.2.1',
    highlights: ['Fixed an update issue that could hide your settings/wallet — your data now auto-recovers on launch.']
  },
  {
    version: '2.2.0',
    highlights: [
      'Renamed the app to Defi Dashboard.',
      'EVM Flow now includes BNB Chain (PancakeSwap) alongside Ethereum and Base.'
    ]
  },
  {
    version: '2.1.3',
    highlights: ['Trade: far more reliable swap landing — transactions rebroadcast and poll until confirmed.']
  },
  {
    version: '2.1.2',
    highlights: ['Trade: the quote auto-refreshes continuously so swaps land cleanly without a manual refresh.']
  },
  {
    version: '2.1.1',
    highlights: ['Watchlist cards stay live in the background when switching tabs.']
  },
  {
    version: '2.1.0',
    highlights: ['Charts: a "Sell all" button on each chart to dump your entire balance of that token.']
  },
  {
    version: '2.0.1',
    highlights: ['Pump Flow: press Spacebar to pause/resume the live feed.']
  },
  {
    version: '2.0.0',
    highlights: ['Charts tab is a draggable, resizable dashboard of your watchlist coins; cards flow in reading order.']
  },
  {
    version: '1.9.0',
    highlights: ['Get notified (toast pop-ups) when a tracked wallet buys or sells a coin.']
  },
  {
    version: '1.8.0',
    highlights: ['New Charts tab — live charts for every coin on your watchlist.']
  },
  {
    version: '1.7.0',
    highlights: [
      'Trade: multi-wallet support — add and switch between wallets.',
      'Trade: a watchlist rail on the left, plus a refresh button on the swap panel.',
      'Pump Flow: added a Bubblemaps button to each card.'
    ]
  },
  {
    version: '1.6.0',
    highlights: [
      'Trade: Speed (priority fee) selector — Normal / Fast / Turbo.',
      'Trade: hide tokens you don\'t want cluttering your holdings list.'
    ]
  },
  {
    version: '1.5.3',
    highlights: ['Trade: a "Your tokens" list showing everything your wallet holds — click one to sell it.']
  },
  {
    version: '1.5.0',
    highlights: [
      'New Trade tab — swap Solana tokens right in the app via Jupiter (buy & sell).',
      'Use a fresh burner wallet or import your own; the key is encrypted on your device.',
      'A Buy button on Pump Flow cards jumps straight to the Trade terminal.'
    ]
  },
  {
    version: '1.4.0',
    highlights: [
      'Pump Flow: a watchlist — drag cards to a pinned left rail to track them closely.',
      'Pump Flow: shows how recently a token\'s DexScreener profile was updated.'
    ]
  },
  {
    version: '1.3.0',
    highlights: ['Live feeds (V2 Deploys & Verified Launches) now run in the background and backfill recent items on launch.']
  }
];

function cmp(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Changelog entries to show. On a real update we show everything newer than the
 * last-seen version up to the current one; on a fresh install (no last-seen) we
 * just show the current version's entry as a welcome.
 */
export function changesSince(last: string | null, current: string): ChangelogEntry[] {
  return CHANGELOG.filter((e) => {
    if (cmp(e.version, current) > 0) return false;
    return last ? cmp(e.version, last) > 0 : e.version === current;
  });
}
