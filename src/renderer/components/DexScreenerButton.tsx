import React from 'react';
import type { Chain } from '../../shared/types';
import { DEXSCREENER_LOGO } from '../assets/dexscreenerLogo';

// DexScreener supports more networks than our lookup engine, so this button
// accepts a slightly wider set (adds 'base' for the EVM Flow page).
export type DexChain = Chain | 'base';

interface Props {
  address: string;
  chain: DexChain;
  title?: string;
  className?: string;
}

// DexScreener uses these chain slugs in its token URLs.
const CHAIN_SLUG: Record<DexChain, string> = {
  ethereum: 'ethereum',
  solana: 'solana',
  base: 'base'
};

// Small inline button that opens the token's DexScreener page in the system
// browser. Stops propagation so it doesn't trigger a parent row/card click.
export default function DexScreenerButton({ address, chain, title, className }: Props) {
  function onOpen(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    const url = `https://dexscreener.com/${CHAIN_SLUG[chain]}/${address}`;
    // setWindowOpenHandler in main routes http(s) to the user's default browser.
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  return (
    <button
      onClick={onOpen}
      title={title ?? 'Open on DexScreener'}
      className={
        className ??
        'inline-flex items-center justify-center w-4 h-4 rounded-[3px] overflow-hidden shrink-0 ' +
          'opacity-70 hover:opacity-100 ring-1 ring-transparent hover:ring-emerald-500/60 transition'
      }
    >
      <img src={DEXSCREENER_LOGO} alt="DexScreener" className="w-full h-full object-contain" />
    </button>
  );
}
