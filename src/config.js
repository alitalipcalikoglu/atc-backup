import { resolve } from 'node:path';
import { ConfigError, EnvReader, parseApiKeys, parseAudit } from '@atc-web/atc-service-core/config';

import { EventPublisher } from './events/event-publisher.js';

/** @typedef {import('./types.js').ApiKey} ApiKey */
/** @typedef {import('./types.js').KeyRole} KeyRole */
/** @typedef {import('./types.js').Source} Source */

export { ConfigError };

/** Validated service configuration. Build with {@link Config.fromEnv}. */
export class Config {
  static MIN_SECRET_LENGTH = 32;
  static SOURCE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

  /** @param {import('./types.js').ConfigValues} v */
  constructor(v) {
    this.port = v.port;
    this.host = v.host;
    this.logLevel = v.logLevel;
    this.trustProxy = v.trustProxy;
    this.tls = v.tls;
    this.audit = v.audit;
    this.bodyLimit = v.bodyLimit;
    this.dbPath = v.dbPath;
    this.dbBackupDir = v.dbBackupDir;
    this.backupDir = v.backupDir;
    this.restoreDir = v.restoreDir;
    this.sources = Object.freeze(v.sources.map((s) => Object.freeze({ ...s })));
    this.apiKeys = v.apiKeys;
    this.rateLimitMax = v.rateLimitMax;
    this.media = v.media;
    this.webhookOut = v.webhookOut;
    this.schedule = Object.freeze({ ...v.schedule });
    this.allowLiveRestore = v.allowLiveRestore;
    this.encryptionKey = v.encryptionKey;
    this.drillIntervalHours = v.drillIntervalHours;
    Object.freeze(this);
  }

  /** @param {NodeJS.ProcessEnv} [env] @returns {Config} */
  static fromEnv(env = process.env) {
    const r = new EnvReader(env);
    const certPath = r.optional('TLS_CERT_PATH');
    const keyPath = r.optional('TLS_KEY_PATH');
    if (Boolean(certPath) !== Boolean(keyPath)) throw new ConfigError('TLS_CERT_PATH and TLS_KEY_PATH must be set together');
    const dbPath = r.optional('DB_PATH') || './data/backup.db';
    const sources = [...Config.#parseSources(r.optional('BACKUP_SOURCES'), 'sqlite', 'BACKUP_SOURCES')];
    for (const t of Config.#parseSources(r.optional('BACKUP_TREES'), 'tree', 'BACKUP_TREES')) {
      if (sources.some((s) => s.id === t.id)) throw new ConfigError(`BACKUP_TREES id "${t.id}" is also a BACKUP_SOURCES id`);
      if (sources.some((s) => s.path === t.path)) throw new ConfigError(`BACKUP_TREES path "${t.path}" is also a BACKUP_SOURCES path`);
      sources.push(t);
    }
    const backupDir = resolve(r.optional('BACKUP_DIR') || './data/backups');
    const restoreDir = resolve(r.optional('RESTORE_DIR') || './data/restores');
    for (const s of sources) {
      const name = s.kind === 'tree' ? 'BACKUP_TREES' : 'BACKUP_SOURCES';
      if (dbPath !== ':memory:' && s.path === resolve(dbPath)) throw new ConfigError(`${name} "${s.id}" is this service's own database`);
      if (s.path.startsWith(`${backupDir}/`) || s.path.startsWith(`${restoreDir}/`)) throw new ConfigError(`${name} "${s.id}" lies inside BACKUP_DIR or RESTORE_DIR`);
      if (s.kind === 'tree' && [backupDir, restoreDir].some((d) => d === s.path || d.startsWith(`${s.path}/`))) throw new ConfigError(`${name} "${s.id}" contains BACKUP_DIR or RESTORE_DIR`);
    }
    return new Config({
      port: r.integer('PORT', 3017, { min: 0, max: 65535 }),
      host: r.optional('HOST') || '0.0.0.0',
      logLevel: r.optional('LOG_LEVEL') || 'info',
      trustProxy: r.boolean('TRUST_PROXY', false),
      tls: certPath ? { certPath, keyPath } : null,
      audit: parseAudit(r),
      bodyLimit: r.integer('BODY_LIMIT', 16_384, { min: 1_024 }),
      dbPath,
      dbBackupDir: r.optional('DB_BACKUP_DIR') || undefined,
      backupDir,
      restoreDir,
      sources,
      apiKeys: Config.#parseApiKeys(r.required('BACKUP_API_KEYS'), sources),
      rateLimitMax: r.integer('RATE_LIMIT_MAX', 600, { min: 1 }),
      media: Config.#parseMedia(r),
      webhookOut: EventPublisher.parseEnv(r, ConfigError),
      schedule: {
        intervalMin: r.integer('BACKUP_INTERVAL_MIN', 360, { min: 0, max: 525_600 }),
        retentionCount: r.integer('RETENTION_COUNT', 14, { min: 1, max: 10_000 }),
        retentionDays: r.integer('RETENTION_DAYS', 30, { min: 0, max: 36_500 }),
        tickMs: r.integer('TICK_MS', 60_000, { min: 1_000 }),
        pagesPerStep: r.integer('PAGES_PER_STEP', 100_000, { min: 1 }),
      },
      allowLiveRestore: r.boolean('ALLOW_LIVE_RESTORE', false),
      encryptionKey: Config.#parseKey(r.optional('BACKUP_ENCRYPTION_KEY')),
      drillIntervalHours: r.integer('DRILL_INTERVAL_HOURS', 24, { min: 0, max: 8_760 }),
    });
  }

  /**
   * `id=path,id=path`. Paths resolve against the working directory; ids and paths are unique.
   * @param {string} raw @param {'sqlite'|'tree'} kind @param {string} name @returns {Source[]}
   */
  static #parseSources(raw, kind, name) {
    /** @type {Source[]} */
    const out = [];
    for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const at = entry.indexOf('=');
      const id = at > 0 ? entry.slice(0, at).trim() : '';
      const path = at > 0 ? entry.slice(at + 1).trim() : '';
      if (!Config.SOURCE_PATTERN.test(id)) throw new ConfigError(`${name} entry "${entry}" needs id=path with a lowercase id`);
      if (!path || path === ':memory:') throw new ConfigError(`${name} "${id}" needs a ${kind === 'tree' ? 'path' : 'file path'}`);
      const abs = resolve(path);
      if (out.some((s) => s.id === id)) throw new ConfigError(`${name} id "${id}" is listed twice`);
      if (out.some((s) => s.path === abs)) throw new ConfigError(`${name} path "${path}" is listed twice`);
      out.push({ id, path: abs, kind });
    }
    return out;
  }

  /** `BACKUP_ENCRYPTION_KEY`: 64 hex characters (32 bytes), empty = backups are stored unencrypted. @param {string} raw @returns {string|null} */
  static #parseKey(raw) {
    if (!raw) return null;
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new ConfigError('BACKUP_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    return raw.toLowerCase();
  }

  /** @param {EnvReader} r */
  static #parseMedia(r) {
    const url = r.optional('MEDIA_URL').replace(/\/+$/, '');
    const apiKey = r.optional('MEDIA_API_KEY');
    if (!url && !apiKey) return null;
    if (!url || !apiKey) throw new ConfigError('MEDIA_URL and MEDIA_API_KEY must be set together');
    if (!/^https?:\/\/[^\s]+$/.test(url)) throw new ConfigError('MEDIA_URL must be an absolute http(s) URL');
    return { url, apiKey, timeoutMs: r.integer('MEDIA_TIMEOUT_MS', 120_000, { min: 1_000 }) };
  }

  /**
   * `id:secret:role[:source+source]`. The role (read or admin) is required; sources default to all.
   * @param {string} raw @param {Source[]} sources @returns {ApiKey[]}
   */
  static #parseApiKeys(raw, sources) {
    return parseApiKeys(raw, 'BACKUP_API_KEYS', {
      roles: ['read', 'admin'],
      scopePattern: Config.SOURCE_PATTERN,
      scopeValidate: (s) => sources.some((x) => x.id === s),
      scopeNoun: 'source',
      minSecretLength: Config.MIN_SECRET_LENGTH,
      roleErrorMessage: () => 'must be read or admin',
    }).map(({ id, secret, role, scopes }) => ({ id, secret, role: /** @type {KeyRole} */ (role), sources: scopes }));
  }
}
