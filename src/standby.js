import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Cipher } from './crypto/cipher.js';

/**
 * Warm standby: pulls a source's newest successful snapshot from the primary atc-backup over HTTP(S),
 * checks its SHA-256 and SQLite integrity, and swaps it into place on this host. Run it on the
 * standby on a schedule (RPO = the primary's backup interval) and once more at promotion. The
 * service that owns `target` must be stopped while it runs; nothing here can tell a live file.
 */
export class StandbyPull {
  /**
   * @param {{ url: string, apiKey: string, encryptionKey?: string, fetchImpl?: typeof fetch, downloadTimeoutMs?: number }} o
   */
  constructor({ url, apiKey, encryptionKey = '', fetchImpl = fetch, downloadTimeoutMs = StandbyPull.DOWNLOAD_TIMEOUT_MS }) {
    this.url = url.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.cipher = encryptionKey ? Cipher.fromHex(encryptionKey) : null;
    this.fetch = fetchImpl;
    this.downloadTimeoutMs = downloadTimeoutMs;
  }

  /** A download that takes longer than this is abandoned; the previous copy stays. */
  static DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

  /** @param {string} target */
  static markerOf(target) { return `${target}.standby.json`; }

  /**
   * @param {string} source  Backup source id on the primary (e.g. atc-auth).
   * @param {string} target  SQLite file this host's service opens.
   * @returns {Promise<{ status: 'updated'|'current', backupId: string, sha256: string }>}
   */
  async pull(source, target) {
    const headers = { authorization: `Bearer ${this.apiKey}` };
    const list = await this.fetch(`${this.url}/v1/backups?source=${encodeURIComponent(source)}&status=ok&limit=1`, { headers, signal: AbortSignal.timeout(15_000) });
    if (!list.ok) throw new Error(`listing backups failed: HTTP ${list.status}`);
    const latest = /** @type {{ items: any[] }} */ (await list.json()).items[0];
    if (!latest) throw new Error(`no successful backup of ${source} on the primary yet`);
    if (latest.format !== 'sqlite') throw new Error(`${source} is a file-tree backup; restore it by hand (see examples/standby.md)`);
    if (latest.encrypted && !this.cipher) throw new Error('the backup is encrypted; set BACKUP_ENCRYPTION_KEY');
    const marker = StandbyPull.markerOf(target);
    if (existsSync(target) && existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).backupId === latest.id) return { status: 'current', backupId: latest.id, sha256: latest.sha256 };

    const download = `${target}.standby-download`;
    const plain = `${target}.standby-tmp`;
    // A referenced timer, not AbortSignal.timeout: the latter is unref'd and would not fire in an otherwise idle process.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error(`download timed out after ${this.downloadTimeoutMs} ms`)), this.downloadTimeoutMs);
    try {
      const res = await this.fetch(`${this.url}/v1/backups/${encodeURIComponent(latest.id)}/download`, { headers, signal: abort.signal });
      if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
      const expected = Number(latest.size);
      if (!Number.isFinite(expected) || expected <= 0) throw new Error('the primary recorded no size for this backup');
      const hash = createHash('sha256');
      const body = Readable.fromWeb(/** @type {any} */ (res.body));
      let received = 0;
      // The size is checked while streaming, so a wrong or hostile primary cannot fill the disk before the checksum runs.
      body.on('data', (/** @type {Buffer} */ chunk) => { received += chunk.length; hash.update(chunk); if (received > expected) body.destroy(new Error(`download exceeds the recorded size of ${expected} bytes`)); });
      await pipeline(body, createWriteStream(download, { mode: 0o600 }));
      if (received !== expected) throw new Error(`download is ${received} bytes, the primary recorded ${expected}`);
      const sha256 = hash.digest('hex');
      if (sha256 !== latest.sha256) throw new Error(`checksum mismatch: got ${sha256}, the primary recorded ${latest.sha256}`);
      if (this.cipher) await this.cipher.decrypt(download, plain);
      else await rename(download, plain);
      const db = new DatabaseSync(plain, { readOnly: true });
      try {
        const rows = /** @type {{ integrity_check: string }[]} */ (db.prepare('PRAGMA integrity_check').all());
        if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw new Error(`integrity check failed: ${rows.map((r) => r.integrity_check).join('; ').slice(0, 300)}`);
      } finally { db.close(); }
      // A WAL left by an earlier run of the service would be replayed over the new file.
      await Promise.all([rm(`${target}-wal`, { force: true }), rm(`${target}-shm`, { force: true })]);
      await rename(plain, target);
      await writeFile(marker, `${JSON.stringify({ backupId: latest.id, sha256: latest.sha256, startedAt: latest.startedAt, pulledAt: new Date().toISOString() })}\n`, { mode: 0o600 });
      return { status: 'updated', backupId: latest.id, sha256: latest.sha256 };
    } finally {
      clearTimeout(timer);
      await Promise.all([rm(download, { force: true }), rm(plain, { force: true })]);
    }
  }
}
