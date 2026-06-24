// Whole-app access gate. Each install carries a per-person access code; on
// launch and every few minutes the app checks that code against the operator's
// allowlist in their Firebase Realtime DB. The operator revokes someone by
// setting their code's `allowed` flag to false (or deleting it) in the console.
//
// The gate URL is FIXED in the build on purpose — it's the operator's database,
// so a user can't repoint the gate at their own DB to self-authorize. It isn't a
// secret (access is gated by an unguessable per-person code + DB rules that allow
// reading only a known code path, not listing).
//
//   DB shape:  /access/<code> = { name: "Mickey", allowed: true }
//   Rules:     { "rules": { "access": { "$code": { ".read": true } }, … } }
import { app } from 'electron';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import type { AccessState } from '../shared/types';

const ACCESS_DB_URL = 'https://defi-dashboard-63d04-default-rtdb.firebaseio.com';
const POLL_MS = 5 * 60_000;               // re-check every 5 minutes
const MAX_OFFLINE_MS = 72 * 60 * 60_000;  // a previously-OK client may run 72h offline, then locks

interface Cache { status: 'allowed' | 'revoked'; name: string | null; lastVerifiedAt: number; }

export class AccessGate extends EventEmitter {
  private code = '';
  private state: AccessState = { status: 'checking', name: null };
  private cache: Cache | null = null;
  private cacheLoaded = false;
  private timer: NodeJS.Timeout | null = null;

  setCode(code: string): void {
    this.code = (code || '').trim();
  }

  current(): AccessState {
    return this.state;
  }

  start(): void {
    this.stop();
    void this.check();
    this.timer = setInterval(() => void this.check(), POLL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // Verify the current code against the operator's allowlist. Falls back to the
  // cached verdict (within the offline grace) when the server is unreachable.
  async check(): Promise<AccessState> {
    this.loadCache();
    if (!this.code) {
      this.setState({ status: 'unconfigured', name: null });
      return this.state;
    }
    try {
      const res = await fetch(`${ACCESS_DB_URL}/access/${encodeURIComponent(this.code)}.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { allowed?: boolean | string; name?: string } | null;
      // Accept a real boolean OR the string "true" — the Firebase console can
      // save the value either way depending on how it was entered.
      if (data && (data.allowed === true || data.allowed === 'true')) {
        this.cache = { status: 'allowed', name: data.name ?? null, lastVerifiedAt: Date.now() };
        this.saveCache();
        this.setState({ status: 'allowed', name: data.name ?? null });
      } else {
        // Reachable but the code is missing or disabled → revoked.
        this.cache = { status: 'revoked', name: data?.name ?? null, lastVerifiedAt: Date.now() };
        this.saveCache();
        this.setState({ status: 'revoked', name: data?.name ?? null });
      }
    } catch {
      // Network failure — lean on the last known verdict.
      if (this.cache?.status === 'allowed' && Date.now() - this.cache.lastVerifiedAt < MAX_OFFLINE_MS) {
        this.setState({ status: 'allowed', name: this.cache.name });
      } else if (this.cache?.status === 'allowed') {
        this.setState({ status: 'stale', name: this.cache.name, message: 'Offline too long — reconnect to verify access.' });
      } else if (this.cache?.status === 'revoked') {
        this.setState({ status: 'revoked', name: this.cache.name });
      } else {
        // Never successfully verified and can't reach the server — don't grant.
        this.setState({ status: 'checking', name: null, message: 'Couldn’t reach the access server — retrying…' });
      }
    }
    return this.state;
  }

  private setState(s: AccessState): void {
    const changed =
      s.status !== this.state.status || s.name !== this.state.name || s.message !== this.state.message;
    this.state = s;
    if (changed) this.emit('update', s);
  }

  private cacheFile(): string {
    return path.join(app.getPath('userData'), 'access.json');
  }
  private loadCache(): void {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    try {
      this.cache = JSON.parse(fs.readFileSync(this.cacheFile(), 'utf8')) as Cache;
    } catch {
      this.cache = null;
    }
  }
  private saveCache(): void {
    try {
      if (this.cache) fs.writeFileSync(this.cacheFile(), JSON.stringify(this.cache));
    } catch {
      // non-fatal — gate still works from the live check
    }
  }
}
