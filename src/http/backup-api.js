import { constants, createReadStream, mkdirSync, readFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { createErrorHandler, registerInfo, registerOpenApi, registerProbes, registerRequestContext, requestOptions } from '@atc-web/atc-service-core/fastify';
import { BackupError } from '../domain/errors.js';
import { ApiKeyAuth } from './api-key-auth.js';
import { Schemas } from './schemas.js';
import { Views } from './views.js';

/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('fastify').FastifyInstance} FastifyInstance */
/** @typedef {import('fastify').FastifyRequest} FastifyRequest */

/**
 * HTTP surface. `read` lists sources and backups; `admin` runs, downloads, verifies, restores and
 * deletes. Source-scoped keys only see and touch their sources.
 */
export class BackupApi {
  static READY_CACHE_MS = 10_000;

  /**
   * @param {object} deps
   * @param {Config} deps.config
   * @param {import('../domain/backup-service.js').BackupService} deps.service
   * @param {import('../db.js').Database} deps.db
   * @param {string} deps.version
   * @param {import('../types.js').Logger} [deps.logger]
   * @param {import('@atc-web/atc-service-core/audit').AuditClient} [deps.audit]
   */
  constructor({ config, audit, service, db, version, logger }) {
    this.config = config;
    this.audit = audit;
    this.service = service;
    this.db = db;
    this.version = version;
    this.logger = logger;
    this.auth = new ApiKeyAuth(config.apiKeys);
  }

  /** @returns {Promise<FastifyInstance>} */
  async build() {
    const { config } = this;
    const app = Fastify({
      ...(config.tls ? { https: { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath), minVersion: 'TLSv1.2' } } : {}),
      ...requestOptions({ logger: this.logger, logLevel: config.logLevel }),
      trustProxy: config.trustProxy,
      bodyLimit: config.bodyLimit,
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    registerRequestContext(app, { trustProxy: config.trustProxy });
    app.decorateRequest('apiKey', /** @type {any} */ (null));
    app.setErrorHandler(createErrorHandler(BackupError));
    app.addHook('onSend', AuditClient.hook(this.audit));
    app.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'route not found' } });
    });
    app.addHook('onSend', async (_request, reply) => {
      reply.header('x-content-type-options', 'nosniff');
      if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    });
    registerProbes(app, async () => {
      this.db.ping();
      mkdirSync(config.backupDir, { recursive: true });
      await access(config.backupDir, constants.W_OK);
    }, {
      cacheMs: BackupApi.READY_CACHE_MS,
      extra: () => ({ sources: config.sources.length, schedule: config.schedule.intervalMin ? `every ${config.schedule.intervalMin} min` : 'manual', media: config.media ? 'enabled' : 'disabled', liveRestore: config.allowLiveRestore ? 'enabled' : 'disabled' }),
    });
    registerOpenApi(app, new URL('../../openapi.yaml', import.meta.url));
    registerInfo(app, { service: 'atc-backup', version: this.version, capabilities: ['online-backup', 'integrity-check', 'sha256', 'retention', 'restore-to-file', 'live-restore', 'media-upload', 'source-scoped-keys'], schemaVersion: this.db.schemaVersion });
    await app.register((api) => this.#registerV1(api), { prefix: '/v1' });
    await app.register((ops) => this.#registerMetrics(ops));
    return app;
  }

  /** @param {FastifyInstance} api */
  async #registerV1(api) {
    api.addHook('onRequest', this.auth.hook);
    await api.register(rateLimit, {
      max: this.config.rateLimitMax,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.apiKey.id,
      errorResponseBuilder: (_request, context) => Object.assign(new Error(`rate limit exceeded, retry in ${context.after}`), { statusCode: 429, code: 'RATE_LIMITED' }),
    });
    const s = this.service;
    const read = { preHandler: ApiKeyAuth.require('read') };
    const admin = { preHandler: ApiKeyAuth.require('admin') };
    const visible = (/** @type {FastifyRequest} */ r, /** @type {string} */ source) => !r.apiKey.sources || r.apiKey.sources.includes(source);
    const sourceOf = (/** @type {FastifyRequest} */ r) => { const id = /** @type {{ id: string }} */ (r.params).id; ApiKeyAuth.assertSource(r.apiKey, id); return id; };
    /** A backup the key may see; a scoped key gets 404 for others, so ids of foreign backups do not leak. */
    const backupOf = (/** @type {FastifyRequest} */ r) => {
      const id = /** @type {{ id: string }} */ (r.params).id;
      const row = s.get(id);
      if (!visible(r, row.source)) throw new BackupError('BACKUP_NOT_FOUND', `no backup "${id}"`);
      return row;
    };
    const target = (/** @type {FastifyRequest} */ r) => ({ type: 'backup', id: /** @type {any} */ (r.params).id });

    api.get('/sources', read, async (request) => ({ items: (await s.sources()).filter((x) => visible(request, x.id)).map(Views.source) }));

    api.get('/sources/:id', { ...read, schema: { params: Schemas.sourceParams } }, async (request) => {
      const id = sourceOf(request);
      s.source(id);
      return { source: Views.source(/** @type {any} */ ((await s.sources()).find((x) => x.id === id))) };
    });

    api.post('/sources/:id/backups', { config: { audit: AuditClient.route('atc-backup.backup.create', (_r, b) => ({ type: 'backup', id: b?.backup?.id ?? '' }), (r, b) => ({ source: /** @type {any} */ (r.params).id, status: b?.backup?.status })) }, ...admin, schema: { params: Schemas.sourceParams } }, async (request, reply) => {
      const row = await s.run(sourceOf(request), { trigger: 'manual', by: request.apiKey.id });
      return reply.code(201).send({ backup: Views.backup(row) });
    });

    api.get('/backups', { ...read, schema: { querystring: Schemas.listQuery } }, async (request) => {
      const q = /** @type {{ source?: string, status?: string, limit?: string, cursor?: string }} */ (request.query);
      if (q.source) ApiKeyAuth.assertSource(request.apiKey, q.source);
      const limit = q.limit ? Number(q.limit) : 50;
      const [at, id] = q.cursor ? q.cursor.split('~') : [];
      const rows = s.store.list({ sources: request.apiKey.sources, source: q.source, status: q.status, before: q.cursor ? { at: Number(at), id } : undefined, limit: limit + 1 });
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return { items: page.map(Views.backup), nextCursor: rows.length > limit && last ? `${last.started_at}~${last.id}` : null };
    });

    api.get('/backups/:id', { ...read, schema: { params: Schemas.idParams } }, async (request) => ({ backup: Views.backup(backupOf(request)) }));

    api.get('/backups/:id/download', { config: { audit: AuditClient.route('atc-backup.backup.download', target, (r) => ({ source: s.store.get(/** @type {any} */ (r.params).id)?.source })) }, ...admin, schema: { params: Schemas.idParams } }, async (request, reply) => {
      const f = await s.file(backupOf(request).id);
      reply.header('content-type', 'application/vnd.sqlite3');
      reply.header('content-disposition', `attachment; filename="${f.row.file}"`);
      reply.header('content-length', String(f.size));
      reply.header('x-checksum-sha256', String(f.row.sha256));
      return reply.send(createReadStream(f.path));
    });

    api.post('/backups/:id/verify', { config: { audit: AuditClient.route('atc-backup.backup.verify', target, (_r, b) => ({ checksumOk: b?.checksumOk, integrity: b?.integrity })) }, ...admin, schema: { params: Schemas.idParams } }, async (request) => {
      const r = await s.verify(backupOf(request).id);
      return { backup: Views.backup(r.backup), checksumOk: r.checksumOk, integrity: r.integrity };
    });

    api.post('/backups/:id/restore', { config: { audit: AuditClient.route('atc-backup.backup.restore', target, (r, b) => ({ live: Boolean(/** @type {any} */ (r.body)?.live), target: b?.target, safetyBackupId: b?.safetyBackupId })) }, ...admin, schema: { params: Schemas.idParams, body: Schemas.restore } }, async (request) => {
      const b = /** @type {{ target?: string, overwrite?: boolean, live?: boolean, confirm?: string }} */ (request.body ?? {});
      const r = await s.restore(backupOf(request).id, { ...b, by: request.apiKey.id });
      return { backup: Views.backup(r.backup), live: r.live, target: r.target, size: r.size, sha256: r.sha256, safetyBackupId: r.safetyBackupId };
    });

    api.delete('/backups/:id', { config: { audit: AuditClient.route('atc-backup.backup.delete', target, (r) => ({ source: /** @type {any} */ (r).backupSource })) }, ...admin, schema: { params: Schemas.idParams } }, async (request, reply) => {
      const row = backupOf(request);
      /** @type {any} */ (request).backupSource = row.source;
      await s.delete(row.id);
      return reply.code(204).send();
    });

    api.get('/stats', read, async (request) => {
      const items = (await s.sources()).filter((x) => visible(request, x.id));
      const every = this.config.schedule.intervalMin * 60_000;
      const now = s.now();
      // Stale: no good backup within two intervals (or ever, when scheduled).
      const stale = items.filter((x) => every && (x.lastOkAt === null || now - x.lastOkAt > 2 * every)).map((x) => x.id);
      return {
        sources: items.length, backups: items.reduce((a, x) => a + x.okCount, 0), bytes: items.reduce((a, x) => a + x.bytes, 0),
        failing: items.filter((x) => x.last?.status === 'failed').map((x) => x.id), stale, running: items.filter((x) => x.running).map((x) => x.id),
        intervalMin: this.config.schedule.intervalMin, retentionCount: this.config.schedule.retentionCount, retentionDays: this.config.schedule.retentionDays,
        media: this.config.media !== null, liveRestore: this.config.allowLiveRestore,
      };
    });
  }

  /** @param {FastifyInstance} ops */
  #registerMetrics(ops) {
    ops.addHook('onRequest', this.auth.hook);
    ops.get('/metrics', { logLevel: 'warn', preHandler: ApiKeyAuth.require('read') }, async (request, reply) => {
      const scope = request.apiKey.sources;
      const items = (await this.service.sources()).filter((x) => !scope || scope.includes(x.id));
      const label = (/** @type {string} */ v) => v.replace(/[\\"\n]/g, '\\$&');
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      return [
        '# HELP backup_last_success_timestamp_seconds When the newest successful backup of a source started.',
        '# TYPE backup_last_success_timestamp_seconds gauge',
        ...items.filter((x) => x.lastOkAt !== null).map((x) => `backup_last_success_timestamp_seconds{source="${label(x.id)}"} ${Math.floor(Number(x.lastOkAt) / 1000)}`),
        '# HELP backup_last_ok Whether the newest finished backup of a source succeeded (1) or failed (0).',
        '# TYPE backup_last_ok gauge',
        ...items.filter((x) => x.last).map((x) => `backup_last_ok{source="${label(x.id)}"} ${x.last?.status === 'ok' ? 1 : 0}`),
        '# HELP backup_stored Successful backups kept per source.',
        '# TYPE backup_stored gauge',
        ...items.map((x) => `backup_stored{source="${label(x.id)}"} ${x.okCount}`),
        '# HELP backup_stored_bytes Bytes of the kept backups per source.',
        '# TYPE backup_stored_bytes gauge',
        ...items.map((x) => `backup_stored_bytes{source="${label(x.id)}"} ${x.bytes}`),
        '# HELP backup_process_uptime_seconds Process uptime.',
        '# TYPE backup_process_uptime_seconds gauge',
        `backup_process_uptime_seconds ${process.uptime().toFixed(0)}`,
        '',
      ].join('\n');
    });
  }
}
