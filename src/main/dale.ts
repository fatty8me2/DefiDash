// "Dale" — a shared charts ledger synced live across clients via Firebase
// Realtime DB. The main process keeps a long-lived SSE stream to the DB path so
// adds/removes from any client appear here in ~1s; adds/removes are plain REST
// writes. No credentials are hardcoded — the DB URL + auth secret come from
// Settings (encrypted on-device), and every client points at the same DB.
//
// DB shape:  <url>/dale/charts/<pushId> = { address, addedBy, addedAt }
import { EventEmitter } from 'events';
import type { DaleEntry, DaleSnapshot, DaleStatus } from '../shared/types';

const PATH = '/dale/charts';
const RECONNECT_MS = 4000;

interface StoredEntry { address: string; addedBy: string; addedAt: number; }

export class DaleFeed extends EventEmitter {
  private url = '';                 // Firebase DB base URL (no trailing slash), '' = unconfigured
  private secret = '';
  private entries = new Map<string, StoredEntry>();
  private status: DaleStatus = 'off';
  private controller: AbortController | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private running = false;

  // (Re)apply config. Caller restarts the stream afterwards.
  configure(url: string, secret: string): void {
    this.url = (url || '').trim().replace(/\/+$/, '');
    this.secret = (secret || '').trim();
  }

  get configured(): boolean {
    return this.url.length > 0;
  }

  start(): void {
    this.stop();
    if (!this.configured) {
      this.entries.clear();
      this.setStatus('off');
      return;
    }
    this.running = true;
    this.setStatus('connecting');
    void this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.controller) { try { this.controller.abort(); } catch { /* ignore */ } this.controller = null; }
  }

  current(): DaleSnapshot {
    return { entries: this.sortedEntries(), status: this.status };
  }

  // ── Writes (REST) ─────────────────────────────────────────────────────────
  async add(address: string, addedBy: string): Promise<DaleSnapshot> {
    if (!this.configured) throw new Error('Dale is not set up — add the Firebase URL in Settings.');
    const clean = (address || '').trim();
    if (clean.length < 32) throw new Error('That doesn’t look like a token address.');
    const entry: StoredEntry = { address: clean, addedBy: (addedBy || 'anon').trim() || 'anon', addedAt: Date.now() };
    const res = await fetch(this.restUrl(PATH), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry)
    });
    if (!res.ok) throw new Error(`Dale add failed (HTTP ${res.status}).`);
    // Optimistically reflect locally; the SSE stream will confirm shortly.
    try {
      const j = (await res.json()) as { name?: string };
      if (j?.name) { this.entries.set(j.name, entry); this.emitUpdate(); }
    } catch { /* stream will catch up */ }
    return this.current();
  }

  async remove(id: string): Promise<DaleSnapshot> {
    if (!this.configured) throw new Error('Dale is not set up — add the Firebase URL in Settings.');
    const res = await fetch(this.restUrl(`${PATH}/${id}`), { method: 'DELETE' });
    if (!res.ok) throw new Error(`Dale remove failed (HTTP ${res.status}).`);
    this.entries.delete(id);
    this.emitUpdate();
    return this.current();
  }

  // ── Realtime stream (SSE) ──────────────────────────────────────────────────
  private async connect(): Promise<void> {
    this.controller = new AbortController();
    try {
      const res = await fetch(this.restUrl(PATH), {
        headers: { Accept: 'text/event-stream' },
        signal: this.controller.signal
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE events are separated by a blank line.
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          this.handleEvent(block);
        }
      }
      throw new Error('stream ended');
    } catch (e) {
      if (!this.running) return; // intentional stop()
      this.setStatus(`error: ${e instanceof Error ? e.message : 'disconnected'}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.running) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) { this.setStatus('connecting'); void this.connect(); }
    }, RECONNECT_MS);
  }

  private handleEvent(block: string): void {
    let event = '';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!event || event === 'keep-alive') return;
    if (event === 'cancel' || event === 'auth_revoked') {
      this.setStatus('error: auth rejected — check the Firebase secret/rules');
      this.emitUpdate();
      return;
    }
    if (event !== 'put' && event !== 'patch') return;
    try {
      const payload = JSON.parse(data) as { path: string; data: unknown };
      this.applyChange(payload.path ?? '/', payload.data);
    } catch {
      // ignore malformed frame
    }
  }

  // Apply a Firebase put/patch at `path` (relative to PATH) into the local map.
  private applyChange(path: string, data: unknown): void {
    const rel = path.replace(/^\/+/, '');
    if (rel === '') {
      // Whole-tree snapshot (initial load, or a full overwrite).
      this.entries.clear();
      if (data && typeof data === 'object') {
        for (const [id, v] of Object.entries(data as Record<string, unknown>)) {
          const e = normalize(v);
          if (e) this.entries.set(id, e);
        }
      }
    } else {
      const id = rel.split('/')[0];
      if (data === null) {
        this.entries.delete(id);
      } else if (!rel.includes('/')) {
        // Whole-entry put/patch (our writes are whole objects).
        const e = normalize(data);
        if (e) this.entries.set(id, e); else this.entries.delete(id);
      }
      // Deeper field-level paths are ignored — we never write partial entries.
    }
    this.setStatus('live');
    this.emitUpdate();
  }

  private restUrl(path: string): string {
    const q = this.secret ? `?auth=${encodeURIComponent(this.secret)}` : '';
    return `${this.url}${path}.json${q}`;
  }

  private sortedEntries(): DaleEntry[] {
    return [...this.entries.entries()]
      .map(([id, e]) => ({ id, ...e }))
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  private setStatus(s: DaleStatus): void {
    this.status = s;
  }

  private emitUpdate(): void {
    this.emit('update', this.current());
  }
}

// Coerce an unknown DB value into a StoredEntry (or null if it lacks an address).
function normalize(v: unknown): StoredEntry | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const address = typeof o.address === 'string' ? o.address : '';
  if (address.length < 1) return null;
  return {
    address,
    addedBy: typeof o.addedBy === 'string' ? o.addedBy : '',
    addedAt: typeof o.addedAt === 'number' ? o.addedAt : 0
  };
}
