import type { WalletLookupApi } from './index';

declare global {
  interface Window {
    api: WalletLookupApi;
  }
}
