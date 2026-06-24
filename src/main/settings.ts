import { app, safeStorage } from 'electron';
import path from 'path';
import fs from 'fs';
import type { AppSettings } from '../shared/types';

export type Settings = AppSettings;

export const DEFAULTS: AppSettings = {
  alchemyKey: '',
  heliusKey: '',
  etherscanKey: '',
  cieloKey: '',
  defaultBuyers: 50,
  feedV2Enabled: true,
  feedVerifiedEnabled: true,
  feedTrendingEnabled: true,
  trendingRefreshSec: 30,
  trendingMaxFdvUsd: 0,
  trendingMinLiqUsd: 0,
  launchOnStartup: false,
  notifyVerified: false,
  displayName: '',
  daleFirebaseUrl: '',
  daleFirebaseSecret: '',
  accessCode: ''
};

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'settings.bin');
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// Merge a parsed/partial object onto the defaults so older settings files and
// missing keys are handled gracefully.
function coerce(parsed: Record<string, unknown>): AppSettings {
  return {
    alchemyKey: str(parsed.alchemyKey, DEFAULTS.alchemyKey),
    heliusKey: str(parsed.heliusKey, DEFAULTS.heliusKey),
    etherscanKey: str(parsed.etherscanKey, DEFAULTS.etherscanKey),
    cieloKey: str(parsed.cieloKey, DEFAULTS.cieloKey),
    defaultBuyers: num(parsed.defaultBuyers, DEFAULTS.defaultBuyers),
    feedV2Enabled: bool(parsed.feedV2Enabled, DEFAULTS.feedV2Enabled),
    feedVerifiedEnabled: bool(parsed.feedVerifiedEnabled, DEFAULTS.feedVerifiedEnabled),
    feedTrendingEnabled: bool(parsed.feedTrendingEnabled, DEFAULTS.feedTrendingEnabled),
    trendingRefreshSec: num(parsed.trendingRefreshSec, DEFAULTS.trendingRefreshSec),
    trendingMaxFdvUsd: num(parsed.trendingMaxFdvUsd, DEFAULTS.trendingMaxFdvUsd),
    trendingMinLiqUsd: num(parsed.trendingMinLiqUsd, DEFAULTS.trendingMinLiqUsd),
    launchOnStartup: bool(parsed.launchOnStartup, DEFAULTS.launchOnStartup),
    notifyVerified: bool(parsed.notifyVerified, DEFAULTS.notifyVerified),
    displayName: str(parsed.displayName, DEFAULTS.displayName),
    daleFirebaseUrl: str(parsed.daleFirebaseUrl, DEFAULTS.daleFirebaseUrl),
    daleFirebaseSecret: str(parsed.daleFirebaseSecret, DEFAULTS.daleFirebaseSecret),
    accessCode: str(parsed.accessCode, DEFAULTS.accessCode)
  };
}

export function loadSettings(): Settings {
  const file = settingsFile();
  if (fs.existsSync(file)) {
    try {
      const buf = fs.readFileSync(file);
      const json = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(buf)
        : buf.toString('utf8');
      return coerce(JSON.parse(json));
    } catch {
      // fall through to env
    }
  }
  return {
    ...DEFAULTS,
    alchemyKey: process.env.ALCHEMY_API_KEY ?? DEFAULTS.alchemyKey,
    heliusKey: process.env.HELIUS_API_KEY ?? DEFAULTS.heliusKey,
    etherscanKey: process.env.ETHERSCAN_API_KEY ?? DEFAULTS.etherscanKey,
    cieloKey: process.env.CIELO_API_KEY ?? DEFAULTS.cieloKey
  };
}

export function saveSettings(s: Settings): void {
  const clean = coerce(s as unknown as Record<string, unknown>);
  // Trim the key strings.
  clean.alchemyKey = clean.alchemyKey.trim();
  clean.heliusKey = clean.heliusKey.trim();
  clean.etherscanKey = clean.etherscanKey.trim();
  clean.cieloKey = clean.cieloKey.trim();
  clean.displayName = clean.displayName.trim();
  clean.daleFirebaseUrl = clean.daleFirebaseUrl.trim().replace(/\/+$/, ''); // no trailing slash
  clean.daleFirebaseSecret = clean.daleFirebaseSecret.trim();
  clean.accessCode = clean.accessCode.trim();
  // Clamp numerics to sane ranges.
  clean.defaultBuyers = [50, 100, 200].includes(clean.defaultBuyers) ? clean.defaultBuyers : 50;
  clean.trendingRefreshSec = Math.max(10, Math.min(300, Math.round(clean.trendingRefreshSec)));
  clean.trendingMaxFdvUsd = Math.max(0, clean.trendingMaxFdvUsd);
  clean.trendingMinLiqUsd = Math.max(0, clean.trendingMinLiqUsd);

  const json = JSON.stringify(clean);
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf8');
  fs.writeFileSync(settingsFile(), buf, { mode: 0o600 });
}
