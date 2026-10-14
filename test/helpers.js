import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readServiceVersion } from '@atc-web/atc-service-core/fastify';
import { Config } from '../src/config.js';
import { Database } from '../src/db.js';
import { BackupService } from '../src/domain/backup-service.js';
import { BackupApi } from '../src/http/backup-api.js';
import { BackupStore } from '../src/store/backup-store.js';

export const ADMIN_KEY = 'a'.repeat(40);
export const READ_KEY = 'r'.repeat(40);
export const SCOPED_KEY = 's'.repeat(40);

/** A clock tests move by hand. */
export function manualClock(start = 1_800_000_000_000) {
  const c = { t: start, now: () => c.t, advance: (/** @type {number} */ ms) => { c.t += ms; } };
  return c;
}

/**
 * A temp workspace with two live WAL databases (`app`, `logs`) kept open for writing, as a running service would.
 * @returns {{ dir: string, live: Record<string, DatabaseSync>, cleanup: () => void }}
 */
export function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'atc-backup-test-'));
  /** @type {Record<string, DatabaseSync>} */
  const live = {};
  for (const id of ['app', 'logs']) {
    const db = new DatabaseSync(join(dir, `${id}.db`));
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
    db.prepare('INSERT INTO items (name) VALUES (?), (?)').run(`${id}-1`, `${id}-2`);
    live[id] = db;
  }
  return { dir, live, cleanup: () => { for (const db of Object.values(live)) { try { db.close(); } catch { /* closed by the test */ } } rmSync(dir, { recursive: true, force: true }); } };
}

/** @param {string} dir @param {Record<string, string>} [overrides] */
export function testEnv(dir, overrides = {}) {
  return {
    PORT: '0', LOG_LEVEL: 'silent', DB_PATH: ':memory:',
    BACKUP_DIR: join(dir, 'backups'), RESTORE_DIR: join(dir, 'restores'),
    BACKUP_SOURCES: `app=${join(dir, 'app.db')},logs=${join(dir, 'logs.db')},gone=${join(dir, 'missing.db')}`,
    BACKUP_API_KEYS: `console:${ADMIN_KEY}:admin,dash:${READ_KEY}:read,ops:${SCOPED_KEY}:admin:app`,
    ...overrides,
  };
}

/** @param {string} dir @param {Record<string, string>} [overrides] @param {{ now?: () => number, media?: any, publisher?: any }} [o] */
export function testService(dir, overrides, o = {}) {
  const config = Config.fromEnv(testEnv(dir, overrides));
  const db = new Database(':memory:');
  const store = new BackupStore(db);
  const service = new BackupService({ config, store, media: o.media ?? null, publisher: o.publisher, now: o.now });
  return { config, db, store, service };
}

/** @param {string} dir @param {Record<string, string>} [overrides] @param {object} [deps] @param {{ now?: () => number, media?: any }} [o] */
export async function buildApp(dir, overrides, deps = {}, o = {}) {
  const t = testService(dir, overrides, o);
  const app = await new BackupApi({ ...t, version: readServiceVersion(import.meta.url), ...deps }).build();
  await app.ready();
  return { app, ...t };
}

/** @param {string} key */
export function bearer(key) {
  return { authorization: `Bearer ${key}` };
}
