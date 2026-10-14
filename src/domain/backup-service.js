import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
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
   * @param {() => number} [deps.now]
   * @param {import('../types.js').Logger} [deps.logger]
   */
  constructor({ config, store, media = null, now = Date.now, logger }) {
    this.config = config;
    this.store = store;
    this.media = media;
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
        id: s.id, file: basename(s.path), exists: Boolean(st?.isFile()), size: st?.isFile() ? st.size : null,
        last: this.store.lastOf(s.id) ?? null, lastOkAt: sum?.lastOkAt ?? null, okCount: sum?.okCount ?? 0, bytes: sum?.bytes ?? 0,
        running: this.busy.has(s.id),
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
        return await this.#backupInto(source, id);
      } finally {
        this.busy.delete(source.id);
      }
    });
  }

  /** Re-hash the stored file and run `PRAGMA integrity_check` on it. @param {string} id */
  verify(id) {
    const row = this.#okRow(id);
    return this.#serial(async () => {
      const path = this.pathOf(row);
      if (!existsSync(path)) {
        this.store.setVerify(row.id, false, this.now());
        return { backup: this.get(row.id), checksumOk: false, integrity: 'file missing' };
      }
      const checksumOk = (await BackupService.sha256(path)) === row.sha256;
      const integrity = BackupService.integrity(path, true);
      this.store.setVerify(row.id, checksumOk && integrity === 'ok', this.now());
      return { backup: this.get(row.id), checksumOk, integrity };
    });
  }

  /**
   * Write a backup out. Default: a new file `target` inside RESTORE_DIR (`overwrite` replaces an
   * existing one). With `live`, replace the source's live database instead; needs
   * ALLOW_LIVE_RESTORE, `confirm` equal to the source id, and takes a safety backup first.
   * @param {string} id
   * @param {{ target?: string, overwrite?: boolean, live?: boolean, confirm?: string, by: string }} o
   */
  restore(id, o) {
    const row = this.#okRow(id);
    if (o.live) {
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
        try {
          await copyFile(from, tmp);
          await chmod(tmp, 0o600);
          await BackupService.#fsync(tmp);
          const sha = await BackupService.sha256(tmp);
          if (sha !== row.sha256) throw new BackupError('CHECKSUM_MISMATCH', 'the written copy does not match the backup checksum');
          // Old WAL/SHM sidecars belong to the replaced file and would corrupt the restored one.
          await Promise.all(['-wal', '-shm', '-journal'].map((x) => rm(`${dest}${x}`, { force: true })));
          await rename(tmp, dest);
        } finally {
          await rm(tmp, { force: true });
        }
        return { backup: this.get(row.id), live: Boolean(source), target: source ? source.id : /** @type {string} */ (o.target), size: Number(row.size), sha256: /** @type {string} */ (row.sha256), safetyBackupId };
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
    const file = `${source.id}-${new Date(started?.started_at ?? this.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${id.slice(-8)}.db`;
    const tmp = join(dir, `.${file}.partial`);
    try {
      if (!existsSync(source.path)) throw new BackupError('SOURCE_MISSING', `the database file of "${source.id}" does not exist`);
      await BackupService.#privateDir(this.config.backupDir);
      await BackupService.#privateDir(dir);
      // Copies hold other services' secrets: owner-only from the first byte (SQLite gives its journal the same mode).
      await writeFile(tmp, '', { mode: 0o600, flag: 'wx' });
      const src = new DatabaseSync(source.path, { readOnly: true });
      let pages;
      try {
        pages = await sqliteBackup(src, tmp, { rate: this.config.schedule.pagesPerStep });
      } finally {
        src.close();
      }
      // A self-contained file: rollback journal instead of WAL, so the copy is one file with no sidecars.
      const copy = new DatabaseSync(tmp);
      try { copy.exec('PRAGMA journal_mode = DELETE'); } finally { copy.close(); }
      await chmod(tmp, 0o600);
      const integrity = BackupService.integrity(tmp, false);
      if (integrity !== 'ok') throw new BackupError('INTEGRITY_FAILED', `integrity check failed: ${integrity}`);
      await BackupService.#fsync(tmp);
      const sha256 = await BackupService.sha256(tmp);
      const { size } = await stat(tmp);
      await rename(tmp, join(dir, file));
      this.store.finishOk(id, { file, size, sha256, pages }, this.now());
    } catch (err) {
      this.store.finishFailed(id, err instanceof Error ? err.message : String(err), this.now());
      return this.get(id);
    } finally {
      await Promise.all(['', '-journal', '-wal', '-shm'].map((x) => rm(`${tmp}${x}`, { force: true })));
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
      const f = await this.media.upload(this.pathOf(row), /** @type {string} */ (row.file), this.stopping.signal);
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
