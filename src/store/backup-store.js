/** @typedef {import('../types.js').BackupRow} BackupRow */

/** Backup records. Every method is one statement; the service owns ordering and files. */
export class BackupStore {
  /** @param {import('../db.js').Database} db */
  constructor(db) {
    const raw = db.raw;
    this.stmt = {
      insert: raw.prepare('INSERT INTO backups (id, source, status, trigger, created_by, started_at) VALUES (?, ?, \'running\', ?, ?, ?)'),
      finishOk: raw.prepare('UPDATE backups SET status = \'ok\', file = ?, size = ?, sha256 = ?, pages = ?, finished_at = ?, verified_at = ?, verify_ok = 1 WHERE id = ?'),
      finishFailed: raw.prepare('UPDATE backups SET status = \'failed\', error = ?, finished_at = ? WHERE id = ?'),
      get: raw.prepare('SELECT * FROM backups WHERE id = ?'),
      verify: raw.prepare('UPDATE backups SET verified_at = ?, verify_ok = ? WHERE id = ?'),
      media: raw.prepare('UPDATE backups SET media_id = ?, media_error = ? WHERE id = ?'),
      delete: raw.prepare('DELETE FROM backups WHERE id = ?'),
      running: raw.prepare('SELECT * FROM backups WHERE status = \'running\''),
      okOf: raw.prepare('SELECT * FROM backups WHERE source = ? AND status = \'ok\' ORDER BY started_at DESC, id DESC'),
      failedOf: raw.prepare('SELECT id FROM backups WHERE source = ? AND status = \'failed\' ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET ?'),
      summary: raw.prepare(`SELECT source,
          MAX(started_at) AS last_at,
          MAX(CASE WHEN status = 'ok' THEN started_at END) AS last_ok_at,
          SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_count,
          SUM(CASE WHEN status = 'ok' THEN size ELSE 0 END) AS bytes
        FROM backups GROUP BY source`),
      lastOf: raw.prepare('SELECT * FROM backups WHERE source = ? AND status != \'running\' ORDER BY started_at DESC, id DESC LIMIT 1'),
      lastScheduledOf: raw.prepare('SELECT MAX(started_at) AS at FROM backups WHERE source = ? AND trigger != \'pre-restore\''),
    };
    this.raw = raw;
  }

  /** @param {string} id @param {string} source @param {import('../types.js').BackupTrigger} trigger @param {string} by @param {number} now */
  insert(id, source, trigger, by, now) { this.stmt.insert.run(id, source, trigger, by, now); }

  /** @param {string} id @param {{ file: string, size: number, sha256: string, pages: number }} f @param {number} now */
  finishOk(id, f, now) { this.stmt.finishOk.run(f.file, f.size, f.sha256, f.pages, now, now, id); }

  /** @param {string} id @param {string} error @param {number} now */
  finishFailed(id, error, now) { this.stmt.finishFailed.run(error.slice(0, 1_000), now, id); }

  /** @param {string} id @returns {BackupRow|undefined} */
  get(id) { return /** @type {any} */ (this.stmt.get.get(id)); }

  /** @param {string} id @param {boolean} ok @param {number} now */
  setVerify(id, ok, now) { this.stmt.verify.run(now, ok ? 1 : 0, id); }

  /** @param {string} id @param {string|null} mediaId @param {string|null} error */
  setMedia(id, mediaId, error) { this.stmt.media.run(mediaId, error ? error.slice(0, 500) : null, id); }

  /** @param {string} id */
  delete(id) { this.stmt.delete.run(id); }

  /** @returns {BackupRow[]} */
  running() { return /** @type {any} */ (this.stmt.running.all()); }

  /** Successful backups of one source, newest first. @param {string} source @returns {BackupRow[]} */
  okOf(source) { return /** @type {any} */ (this.stmt.okOf.all(source)); }

  /** Ids of failed rows of a source beyond the newest `keep`. @param {string} source @param {number} keep @returns {string[]} */
  failedBeyond(source, keep) { return this.stmt.failedOf.all(source, keep).map((r) => String(r.id)); }

  /** @param {string} source @returns {BackupRow|undefined} */
  lastOf(source) { return /** @type {any} */ (this.stmt.lastOf.get(source)); }

  /** Start of the newest non-safety attempt, which the schedule counts from. @param {string} source @returns {number|null} */
  lastAttemptAt(source) { const at = this.stmt.lastScheduledOf.get(source)?.at; return at === null || at === undefined ? null : Number(at); }

  /** @returns {Map<string, { lastAt: number, lastOkAt: number|null, okCount: number, bytes: number }>} */
  summary() {
    return new Map(this.stmt.summary.all().map((r) => [String(r.source), { lastAt: Number(r.last_at), lastOkAt: r.last_ok_at === null ? null : Number(r.last_ok_at), okCount: Number(r.ok_count), bytes: Number(r.bytes ?? 0) }]));
  }

  /**
   * Newest first, keyset paged on (started_at, id).
   * @param {{ sources: string[]|null, source?: string, status?: string, before?: { at: number, id: string }, limit: number }} q
   * @returns {BackupRow[]}
   */
  list(q) {
    /** @type {string[]} */ const where = [];
    /** @type {(string|number)[]} */ const args = [];
    if (q.sources) { where.push(`source IN (${q.sources.map(() => '?').join(', ') || 'NULL'})`); args.push(...q.sources); }
    if (q.source) { where.push('source = ?'); args.push(q.source); }
    if (q.status) { where.push('status = ?'); args.push(q.status); }
    if (q.before) { where.push('(started_at < ? OR (started_at = ? AND id < ?))'); args.push(q.before.at, q.before.at, q.before.id); }
    const sql = `SELECT * FROM backups ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, id DESC LIMIT ?`;
    // Dynamic WHERE: prepared per call, never cached.
    return /** @type {any} */ (this.raw.prepare(sql).all(...args, q.limit));
  }
}
