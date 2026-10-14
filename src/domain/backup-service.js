import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { Archive } from '../archive.js';
import { Cipher } from '../crypto/cipher.js';
import { EventPublisher } from '../events/event-publisher.js';
import { BackupError } from './errors.js';

/** @typedef {import('../types.js').BackupRow} BackupRow */
/** @typedef {import('../types.js').Source} Source */
/** @typedef {import('../types.js').BackupTrigger} BackupTrigger */

/**
 * Online SQLite backups. A backup copies the live file through SQLite's backup API (consistent
 * under WAL, writers keep going), switches the copy to a self-contained rollback-journal file,
 * runs `PRAGMA integrity_check`, records size and SHA-256 and only then moves it into place.
 * Backups, restores and safety copies run one at a time; a source already being backed up answers
 * `BUSY`. Restores never touch a live database unless `ALLOW_LIVE_RESTORE` is on and the caller
 * names the source again in `confirm`.
 */
export class BackupService {
  static NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  static FAILED_KEPT = 50;

  /**
   * @param {object} deps
   * @param {import('../config.js').Config} deps.config
   * @param {import('../store/backup-store.js').BackupStore} deps.store
   * @param {import('../net/media-client.js').MediaClient|null} [deps.media]
   * @param {EventPublisher} [deps.publisher]
   * @param {() => number} [deps.now]
   * @param {import('../types.js').Logger} [deps.logger]
   */
  constructor({ config, store, media = null, publisher = new EventPublisher({ source: 'atc-backup', target: null }), now = Date.now, logger }) {
    this.config = config;
    this.store = store;
    this.media = media;
    this.publisher = publisher;
    this.cipher = config.encryptionKey ? Cipher.fromHex(config.encryptionKey) : null;
    /** @type {Map<string, number>} */
    this.staleSent = new Map();
    this.startedAt = now();
    this.now = now;
    this.logger = logger;
    this.stopping = new AbortController();
    /** @type {Set<string>} */
    this.busy = new Set();
    /** @type {Promise<unknown>} */
    this.chain = Promise.resolve();
  }

  /** @param {string} id @returns {Source} */
  source(id) {
    const s = this.config.sources.find((x) => x.id === id);
    if (!s) throw new BackupError('SOURCE_NOT_FOUND', `no source "${id}"`);
    return s;
  }

  /** Configured sources with their live file and backup summary. */
  async sources() {
    const summary = this.store.summary();
    const every = this.config.schedule.intervalMin * 60_000;
    return Promise.all(this.config.sources.map(async (s) => {
      const st = await stat(s.path).catch(() => null);
      const sum = summary.get(s.id);
      const lastAttempt = this.store.lastAttemptAt(s.id);
      return {
        id: s.id, kind: s.kind, file: basename(s.path), exists: s.kind === 'tree' ? st !== null : Boolean(st?.isFile()), size: st?.isFile() ? st.size : null,
        last: this.store.lastOf(s.id) ?? null, lastOkAt: sum?.lastOkAt ?? null, okCount: sum?.okCount ?? 0, bytes: sum?.bytes ?? 0,
        running: this.busy.has(s.id), lastDrill: this.store.lastDrilled(s.id),
        nextDueAt: every ? (lastAttempt === null ? this.now() : lastAttempt + every) : null,
      };
    }));
  }

  /** @param {string} id @returns {BackupRow} */
  get(id) {
    const row = this.store.get(id);
    if (!row) throw new BackupError('BACKUP_NOT_FOUND', `no backup "${id}"`);
    return row;
  }

  /** @param {BackupRow} row */
  pathOf(row) {
    return join(this.config.backupDir, row.source, /** @type {string} */ (row.file));
  }

  /** The stored file of a successful backup. @param {string} id */
  async file(id) {
    const row = this.#okRow(id);
    const path = this.pathOf(row);
    const st = await stat(path).catch(() => null);
    if (!st) throw new BackupError('INVALID_STATE', `the file of backup "${id}" is missing`);
    return { row, path, size: st.size };
  }

  /**
   * Back up one source now. Resolves with the finished row (status `ok` or `failed`).
   * @param {string} sourceId
   * @param {{ trigger: BackupTrigger, by: string }} o
   * @returns {Promise<BackupRow>}
   */
  run(sourceId, { trigger, by }) {
    const source = this.source(sourceId);
    if (this.busy.has(source.id)) throw new BackupError('BUSY', `a backup of "${source.id}" is already running`);
    this.busy.add(source.id);
    const id = BackupService.#id(this.now());
    this.store.insert(id, source.id, trigger, by, this.now());
    return this.#serial(async () => {
      try {
        const row = await this.#backupInto(source, id);
        this.#announce(row);
        return row;
      } finally {
        this.busy.delete(source.id);
      }
    });
  }

  /** Re-hash the stored file, then (decrypting first when needed) check its content: `PRAGMA integrity_check` or a full read of the archive. @param {string} id */
  verify(id) {
    const row = this.#okRow(id);
    return this.#serial(async () => {
      const path = this.pathOf(row);
      if (!existsSync(path)) {
        this.store.setVerify(row.id, false, this.now());
        return { backup: this.get(row.id), checksumOk: false, integrity: 'file missing' };
      }
      const checksumOk = (await BackupService.sha256(path)) === row.sha256;
      const integrity = await this.#withPlain(row, (plain) => this.#integrityOf(row, plain)).catch((err) => (err instanceof Error ? err.message : String(err)));
      this.store.setVerify(row.id, checksumOk && integrity === 'ok', this.now());
      return { backup: this.get(row.id), checksumOk, integrity };
    });
  }

  /**
   * Restore drill: unpack the backup into a scratch place under RESTORE_DIR as a real restore would
   * (decrypt, copy, open) and read it back: every table's row count for a database, every entry for an
   * archive. Records the outcome on the backup; a failed drill publishes `ops.backup.failed` (stage `drill`).
   * @param {string} id
   */
  drill(id) {
    const row = this.#okRow(id);
    return this.#serial(async () => {
      /** @type {Record<string, unknown>} */ let detail;
      let ok = false;
      const started = performance.now();
      try {
        const path = this.pathOf(row);
        if (!existsSync(path)) throw new Error('file missing');
        if ((await BackupService.sha256(path)) !== row.sha256) throw new Error('checksum mismatch');
        await BackupService.#privateDir(this.config.restoreDir);
        const scratch = await mkdtemp(join(this.config.restoreDir, '.drill-'));
        try {
          detail = await this.#withPlain(row, async (plain) => {
            if (row.format === 'tar.gz') {
              const out = join(scratch, 'tree');
              await mkdir(out);
              await Archive.extract(plain, out);
              return { entries: await Archive.entries(plain) };
            }
            const copy = join(scratch, 'restored.db');
            await copyFile(plain, copy);
            const integrity = BackupService.integrity(copy, true);
            if (integrity !== 'ok') throw new Error(`integrity check failed: ${integrity}`);
            return { integrity, tables: BackupService.tableCounts(copy) };
          });
          ok = true;
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      } catch (err) {
        detail = { error: err instanceof Error ? err.message : String(err) };
      }
      detail = { ...detail, ms: Math.round(performance.now() - started) };
      this.store.setDrill(row.id, ok, detail, this.now());
      if (!ok) this.publisher.publish('ops.backup.failed', { source: row.source, id: row.id, trigger: 'drill', stage: 'drill', error: String(detail.error) });
      return { backup: this.get(row.id), ok, detail };
    });
  }

  /** Row count of every user table of a database file. @param {string} path @returns {Record<string, number>} */
  static tableCounts(path) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      /** @type {Record<string, number>} */ const out = {};
      for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
        out[String(t.name)] = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${String(t.name).replace(/"/g, '""')}"`).get()?.n ?? 0);
      }
      return out;
    } finally {
      db.close();
    }
  }

  /**
   * Run `fn` on the plain content of a backup: the stored file itself, or a temporary decrypted copy that is removed afterwards.
   * @template T @param {BackupRow} row @param {(plainPath: string) => Promise<T>} fn @returns {Promise<T>}
   */
  async #withPlain(row, fn) {
    const path = this.pathOf(row);
    if (!row.encrypted) return fn(path);
    if (!this.cipher) throw new BackupError('INVALID_STATE', 'this backup is encrypted but BACKUP_ENCRYPTION_KEY is not set');
    await BackupService.#privateDir(this.config.restoreDir);
    const tmp = join(this.config.restoreDir, `.plain-${randomBytes(6).toString('hex')}`);
    try {
      await this.cipher.decrypt(path, tmp);
      return await fn(tmp);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /** `ok`, or the first problem found in the plain content of a backup. @param {BackupRow} row @param {string} plain */
  async #integrityOf(row, plain) {
    if (row.format === 'tar.gz') return Archive.check(plain).then(() => 'ok', (err) => (err instanceof Error ? err.message : String(err)));
    return BackupService.integrity(plain, true);
  }

  /**
   * Write a backup out. Default: a new file (database) or directory (tree) `target` inside RESTORE_DIR
   * (`overwrite` replaces an existing one). With `live`, replace the source's live database instead; needs
   * ALLOW_LIVE_RESTORE, `confirm` equal to the source id, and takes a safety backup first. Trees are never
   * restored live: they are unpacked next to the others and put in place by a person.
   * @param {string} id
   * @param {{ target?: string, overwrite?: boolean, live?: boolean, confirm?: string, by: string }} o
   */
  restore(id, o) {
    const row = this.#okRow(id);
    if (o.live) {
      if (row.format === 'tar.gz') throw new BackupError('INVALID_ARGUMENT', 'a tree backup cannot be restored live; restore it to a target and put the files in place yourself');
      if (!this.config.allowLiveRestore) throw new BackupError('LIVE_RESTORE_DISABLED', 'live restores are disabled; set ALLOW_LIVE_RESTORE=true on this service');
      if (o.confirm !== row.source) throw new BackupError('INVALID_ARGUMENT', `a live restore needs confirm set to the source id "${row.source}"`);
      if (o.target) throw new BackupError('INVALID_ARGUMENT', 'name either target or live, not both');
    } else if (!o.target || !BackupService.NAME_PATTERN.test(o.target)) {
      throw new BackupError('INVALID_ARGUMENT', 'target must be a plain file name (letters, digits, dot, dash, underscore)');
    }
    const source = o.live ? this.source(row.source) : null;
    if (source) {
      if (this.busy.has(source.id)) throw new BackupError('BUSY', `a backup of "${source.id}" is running`);
      this.busy.add(source.id);
    }
    return this.#serial(async () => {
      try {
        const from = this.pathOf(row);
        if (!existsSync(from) || (await BackupService.sha256(from)) !== row.sha256) {
          this.store.setVerify(row.id, false, this.now());
          throw new BackupError('CHECKSUM_MISMATCH', `backup "${row.id}" does not match its recorded checksum; it was not restored`);
        }
        /** @type {string|null} */ let safetyBackupId = null;
        let dest;
        if (source) {
          dest = source.path;
          if (existsSync(dest)) {
            safetyBackupId = BackupService.#id(this.now());
            this.store.insert(safetyBackupId, source.id, 'pre-restore', o.by, this.now());
            const safety = await this.#backupInto(source, safetyBackupId);
            if (safety.status !== 'ok') throw new BackupError('INVALID_STATE', `the safety backup of the live database failed (${safety.error}); nothing was restored`, { safetyBackupId });
          }
        } else {
          dest = join(this.config.restoreDir, /** @type {string} */ (o.target));
          if (existsSync(dest) && !o.overwrite) throw new BackupError('TARGET_EXISTS', `"${o.target}" already exists in RESTORE_DIR; pass overwrite to replace it`);
        }
        // A live restore writes into the owning service's own directory, which keeps its mode.
        if (source) await mkdir(dirname(dest), { recursive: true });
        else await BackupService.#privateDir(this.config.restoreDir);
        const tmp = `${dest}.restore-${randomBytes(6).toString('hex')}`;
        let plainSha = /** @type {string} */ (row.sha256);
        try {
          await this.#withPlain(row, async (plain) => {
            if (row.format === 'tar.gz') {
              await mkdir(tmp, { mode: 0o700 });
              await Archive.extract(plain, tmp);
              return;
            }
            await copyFile(plain, tmp);
            await chmod(tmp, 0o600);
            await BackupService.#fsync(tmp);
            plainSha = await BackupService.sha256(tmp);
            // For an encrypted backup the GCM tag has vouched for the content; for a plain one the recorded checksum must match.
            if (!row.encrypted && plainSha !== row.sha256) throw new BackupError('CHECKSUM_MISMATCH', 'the written copy does not match the backup checksum');
          });
          if (row.format === 'tar.gz') {
            if (existsSync(dest)) await rm(dest, { recursive: true, force: true });
          } else {
            // Old WAL/SHM sidecars belong to the replaced file and would corrupt the restored one.
            await Promise.all(['-wal', '-shm', '-journal'].map((x) => rm(`${dest}${x}`, { force: true })));
          }
          await rename(tmp, dest);
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
        return { backup: this.get(row.id), live: Boolean(source), target: source ? source.id : /** @type {string} */ (o.target), size: Number(row.size), sha256: plainSha, safetyBackupId };
      } finally {
        if (source) this.busy.delete(source.id);
      }
    });
  }

  /** Delete a finished backup and its file (and its media copy, best effort). @param {string} id */
  async delete(id) {
    const row = this.get(id);
    if (row.status === 'running') throw new BackupError('INVALID_STATE', 'a running backup cannot be deleted');
    await this.#remove(row);
  }

  /** Back up every source whose interval has passed. Called by the scheduler; never throws. */
  async tick() {
    const every = this.config.schedule.intervalMin * 60_000;
    if (!every) return;
    for (const s of this.config.sources) {
      if (this.stopping.signal.aborted) return;
      const last = this.store.lastAttemptAt(s.id);
      if (this.busy.has(s.id) || (last !== null && this.now() - last < every)) continue;
      try {
        const row = await this.run(s.id, { trigger: 'schedule', by: 'scheduler' });
        if (row.status !== 'ok') this.logger?.warn({ source: s.id, error: row.error }, 'scheduled backup failed');
      } catch (err) {
        this.logger?.error({ err, source: s.id }, 'scheduled backup failed');
      }
    }
    this.checkStale();
    await this.#drillDue();
  }

  /** Restore drill of the newest backup of each source whose last drill is older than DRILL_INTERVAL_HOURS. Never throws. */
  async #drillDue() {
    const every = this.config.drillIntervalHours * 3_600_000;
    if (!every) return;
    for (const s of this.config.sources) {
      if (this.stopping.signal.aborted) return;
      const newest = this.store.newestOk(s.id);
      const last = this.store.lastDrillAt(s.id);
      if (!newest || (last !== null && this.now() - last < every)) continue;
      try { await this.drill(newest.id); } catch (err) { this.logger?.error({ err, source: s.id }, 'restore drill failed to run'); }
    }
  }

  /** Events for a finished backup: `backup.completed`, or `ops.backup.failed` for a failed copy or a failed media upload. @param {BackupRow} row */
  #announce(row) {
    const base = { source: row.source, id: row.id, trigger: row.trigger };
    if (row.status !== 'ok') this.publisher.publish('ops.backup.failed', { ...base, stage: 'backup', error: row.error });
    else if (row.media_error) this.publisher.publish('ops.backup.failed', { ...base, stage: 'upload', error: row.media_error });
    else this.publisher.publish('backup.completed', { ...base, size: row.size, sha256: row.sha256 });
  }

  /** `ops.backup.stale` once per interval for a source with no successful backup for two intervals (a source that never succeeded counts from the service start). */
  checkStale() {
    const every = this.config.schedule.intervalMin * 60_000;
    if (!every) return;
    const now = this.now();
    const sums = this.store.summary();
    for (const s of this.config.sources) {
      const lastOk = sums.get(s.id)?.lastOkAt ?? this.startedAt;
      if (now - lastOk < 2 * every || now - (this.staleSent.get(s.id) ?? 0) < every) continue;
      this.staleSent.set(s.id, now);
      this.publisher.publish('ops.backup.stale', { source: s.id, lastOkAt: sums.get(s.id)?.lastOkAt ?? null, ageSec: Math.floor((now - lastOk) / 1000) });
    }
  }

  /** On start: rows left `running` by a crash become `failed`, their partial files go. */
  async recover() {
    for (const row of this.store.running()) this.store.finishFailed(row.id, 'interrupted by a restart', this.now());
    for (const s of this.config.sources) {
      const dir = join(this.config.backupDir, s.id);
      const names = await readdir(dir).catch(() => /** @type {string[]} */ ([]));
      await Promise.all(names.filter((n) => n.startsWith('.') && n.includes('.partial')).map((n) => rm(join(dir, n), { force: true })));
    }
  }

  /** Resolves when the operation in progress (if any) has finished. */
  idle() {
    return this.chain.then(() => undefined, () => undefined);
  }

  /** @param {string} path */
  static async sha256(path) {
    const h = createHash('sha256');
    for await (const chunk of createReadStream(path)) h.update(chunk);
    return h.digest('hex');
  }

  /**
   * `ok`, or the first problem `PRAGMA integrity_check` reports (or why the file would not open).
   * @param {string} path @param {boolean} readOnly
   */
  static integrity(path, readOnly) {
    let db;
    try {
      db = new DatabaseSync(path, { readOnly });
      const rows = db.prepare('PRAGMA integrity_check').all();
      return String(rows[0]?.integrity_check ?? 'no result');
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      db?.close();
    }
  }

  /**
   * @param {Source} source @param {string} id
   * @returns {Promise<BackupRow>}
   */
  async #backupInto(source, id) {
    const started = this.store.get(id);
    const dir = join(this.config.backupDir, source.id);
    const tree = source.kind === 'tree';
    const encrypted = this.cipher !== null;
    const stamp = new Date(started?.started_at ?? this.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const file = `${source.id}-${stamp}-${id.slice(-8)}${tree ? '.tar.gz' : '.db'}${encrypted ? '.enc' : ''}`;
    const plainTmp = join(dir, `.${file}.plain.partial`);
    const tmp = join(dir, `.${file}.partial`);
    try {
      if (!existsSync(source.path)) throw new BackupError('SOURCE_MISSING', `the ${tree ? 'path' : 'database file'} of "${source.id}" does not exist`);
      await BackupService.#privateDir(this.config.backupDir);
      await BackupService.#privateDir(dir);
      // Copies hold other services' secrets: owner-only from the first byte (SQLite gives its journal the same mode).
      await writeFile(plainTmp, '', { mode: 0o600, flag: 'wx' });
      /** @type {number|null} */ let pages = null;
      if (tree) {
        await Archive.create(source.path, plainTmp);
        await chmod(plainTmp, 0o600);
        await Archive.check(plainTmp).catch((err) => { throw new BackupError('INTEGRITY_FAILED', `integrity check failed: ${err.message}`); });
      } else {
        const src = new DatabaseSync(source.path, { readOnly: true });
        try {
          pages = await sqliteBackup(src, plainTmp, { rate: this.config.schedule.pagesPerStep });
        } finally {
          src.close();
        }
        // A self-contained file: rollback journal instead of WAL, so the copy is one file with no sidecars.
        const copy = new DatabaseSync(plainTmp);
        try { copy.exec('PRAGMA journal_mode = DELETE'); } finally { copy.close(); }
        await chmod(plainTmp, 0o600);
        const integrity = BackupService.integrity(plainTmp, false);
        if (integrity !== 'ok') throw new BackupError('INTEGRITY_FAILED', `integrity check failed: ${integrity}`);
      }
      if (this.cipher) {
        await this.cipher.encrypt(plainTmp, tmp);
        await rm(plainTmp, { force: true });
      } else {
        await rename(plainTmp, tmp);
      }
      await BackupService.#fsync(tmp);
      const sha256 = await BackupService.sha256(tmp);
      const { size } = await stat(tmp);
      await rename(tmp, join(dir, file));
      this.store.finishOk(id, { file, size, sha256, pages, format: tree ? 'tar.gz' : 'sqlite', encrypted }, this.now());
    } catch (err) {
      this.store.finishFailed(id, err instanceof Error ? err.message : String(err), this.now());
      return this.get(id);
    } finally {
      await Promise.all(['', '-journal', '-wal', '-shm'].flatMap((x) => [rm(`${plainTmp}${x}`, { force: true }), rm(`${tmp}${x}`, { force: true })]));
    }
    // A safety copy taken during a restore must not prune the backup being restored.
    if (started?.trigger !== 'pre-restore') await this.#prune(source.id);
    await this.#upload(id);
    return this.get(id);
  }

  /** Keep the newest RETENTION_COUNT successful backups, drop older than RETENTION_DAYS (never the newest). @param {string} source */
  async #prune(source) {
    const { retentionCount, retentionDays } = this.config.schedule;
    const cutoff = retentionDays ? this.now() - retentionDays * 86_400_000 : -Infinity;
    const ok = this.store.okOf(source);
    for (const [i, row] of ok.entries()) if (i > 0 && (i >= retentionCount || row.started_at < cutoff)) await this.#remove(row);
    for (const id of this.store.failedBeyond(source, BackupService.FAILED_KEPT)) this.store.delete(id);
  }

  /** @param {string} id */
  async #upload(id) {
    if (!this.media) return;
    const row = this.get(id);
    try {
      const type = row.encrypted ? 'application/octet-stream' : row.format === 'tar.gz' ? 'application/gzip' : 'application/vnd.sqlite3';
      const f = await this.media.upload(this.pathOf(row), /** @type {string} */ (row.file), type, this.stopping.signal);
      this.store.setMedia(id, f.id, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.setMedia(id, null, message);
      this.logger?.warn({ backup: id, error: message }, 'backup upload to atc-media failed');
    }
  }

  /** @param {BackupRow} row */
  async #remove(row) {
    if (row.file) await rm(this.pathOf(row), { force: true });
    if (row.media_id && this.media) {
      await this.media.delete(row.media_id).catch((err) => this.logger?.warn({ backup: row.id, error: err instanceof Error ? err.message : String(err) }, 'could not delete the atc-media copy'));
    }
    this.store.delete(row.id);
  }

  /** @param {string} id */
  #okRow(id) {
    const row = this.get(id);
    if (row.status !== 'ok' || !row.file) throw new BackupError('INVALID_STATE', `backup "${id}" is ${row.status}, not a usable backup`);
    return row;
  }

  /**
   * One backup or restore at a time.
   * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
   */
  #serial(fn) {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** Create (or tighten) a directory to owner-only access. @param {string} path */
  static async #privateDir(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }

  /** @param {string} path */
  static async #fsync(path) {
    const fh = await open(path, 'r+');
    try { await fh.sync(); } finally { await fh.close(); }
  }

  /** @param {number} now */
  static #id(now) {
    return `bk_${now.toString(36)}${randomBytes(8).toString('hex')}`;
  }
}
