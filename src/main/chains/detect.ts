import type { Chain } from '../../shared/types';

const ETH_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function detectChain(contract: string): Chain | null {
  const trimmed = contract.trim();
  if (ETH_ADDRESS.test(trimmed)) return 'ethereum';
  if (SOLANA_ADDRESS.test(trimmed)) return 'solana';
  return null;
}
