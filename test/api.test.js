import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ADMIN_KEY, READ_KEY, SCOPED_KEY, bearer, buildApp, workspace } from './helpers.js';

test('API: probes, info, auth', async (t) => {
  const w = workspace();
  t.after(w.cleanup);
  const { app } = await buildApp(w.dir);
  t.after(() => app.close());
  const ready = await app.inject({ method: 'GET', url: '/ready' });
  assert.deepEqual(JSON.parse(ready.body), { status: 'ok', sources: 3, schedule: 'every 360 min', media: 'disabled', liveRestore: 'disabled' });
  assert.equal(JSON.parse((await app.inject({ method: 'GET', url: '/v1/info' })).body).service, 'atc-backup');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/sources' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/sources/app/backups', headers: bearer(READ_KEY) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/openapi.yaml' })).statusCode, 200);
});

test('API: run, list, get, download with checksum, verify, restore, delete', async (t) => {
  const w = workspace();
  t.after(w.cleanup);
  const { app } = await buildApp(w.dir);
  t.after(() => app.close());
  const a = bearer(ADMIN_KEY);
  const run = await app.inject({ method: 'POST', url: '/v1/sources/app/backups', headers: a });
  assert.equal(run.statusCode, 201);
  const b = JSON.parse(run.body).backup;
  assert.deepEqual([b.status, b.trigger, b.createdBy, b.verified, b.media], ['ok', 'manual', 'console', true, null]);
  const failed = JSON.parse((await app.inject({ method: 'POST', url: '/v1/sources/gone/backups', headers: a })).body).backup;
  assert.equal(failed.status, 'failed');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/sources/nope/backups', headers: a })).statusCode, 404);

  const sources = JSON.parse((await app.inject({ method: 'GET', url: '/v1/sources', headers: bearer(READ_KEY) })).body).items;
  assert.deepEqual(sources.map((/** @type {any} */ s) => [s.id, s.file, s.exists, s.backups, s.lastBackup?.status ?? null]), [['app', 'app.db', true, 1, 'ok'], ['logs', 'logs.db', true, 0, null], ['gone', 'missing.db', false, 0, 'failed']]);
  assert.equal(JSON.stringify(sources).includes(w.dir), false, 'full paths are not exposed');

  const page1 = JSON.parse((await app.inject({ method: 'GET', url: '/v1/backups?limit=1', headers: bearer(READ_KEY) })).body);
  assert.equal(page1.items[0].id, failed.id);
  const page2 = JSON.parse((await app.inject({ method: 'GET', url: `/v1/backups?limit=1&cursor=${encodeURIComponent(page1.nextCursor)}`, headers: bearer(READ_KEY) })).body);
  assert.deepEqual([page2.items[0].id, page2.nextCursor], [b.id, null]);
  assert.equal(JSON.parse((await app.inject({ method: 'GET', url: '/v1/backups?status=ok', headers: a })).body).items.length, 1);

  assert.equal((await app.inject({ method: 'GET', url: `/v1/backups/${b.id}/download`, headers: bearer(READ_KEY) })).statusCode, 403, 'downloads are admin only');
  const dl = await app.inject({ method: 'GET', url: `/v1/backups/${b.id}/download`, headers: a });
  assert.equal(dl.statusCode, 200);
  assert.equal(dl.headers['content-type'], 'application/vnd.sqlite3');
  assert.match(String(dl.headers['content-disposition']), /^attachment; filename="app-/);
  assert.equal(dl.headers['x-checksum-sha256'], b.sha256);
  assert.equal(createHash('sha256').update(dl.rawPayload).digest('hex'), b.sha256);
  assert.equal(dl.rawPayload.subarray(0, 15).toString('latin1'), 'SQLite format 3');

  const v = JSON.parse((await app.inject({ method: 'POST', url: `/v1/backups/${b.id}/verify`, headers: a })).body);
  assert.deepEqual([v.checksumOk, v.integrity, v.backup.verified], [true, 'ok', true]);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/backups/${failed.id}/verify`, headers: a })).statusCode, 409);

  const r = await app.inject({ method: 'POST', url: `/v1/backups/${b.id}/restore`, headers: a, payload: { target: 'app-check.db' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual([JSON.parse(r.body).target, JSON.parse(r.body).live], ['app-check.db', false]);
  assert.equal(JSON.parse((await app.inject({ method: 'POST', url: `/v1/backups/${b.id}/restore`, headers: a, payload: { target: 'app-check.db' } })).body).error.code, 'TARGET_EXISTS');
  assert.equal(JSON.parse((await app.inject({ method: 'POST', url: `/v1/backups/${b.id}/restore`, headers: a, payload: { target: '../x.db' } })).body).error.code, 'INVALID_ARGUMENT');
  assert.equal(JSON.parse((await app.inject({ method: 'POST', url: `/v1/backups/${b.id}/restore`, headers: a, payload: { live: true, confirm: 'app' } })).body).error.code, 'LIVE_RESTORE_DISABLED');
  assert.equal((await app.inject({ method: 'POST', url: `/v1/backups/${b.id}/restore`, headers: a, payload: { target: 'x.db', extra: 1 } })).statusCode, 400);

  const stats = JSON.parse((await app.inject({ method: 'GET', url: '/v1/stats', headers: bearer(READ_KEY) })).body);
  assert.deepEqual([stats.sources, stats.backups, stats.failing, stats.stale, stats.media], [3, 1, ['gone'], ['logs', 'gone'], false]);
  assert.equal((await app.inject({ method: 'DELETE', url: `/v1/backups/${b.id}`, headers: a })).statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/backups/${b.id}`, headers: a })).statusCode, 404);
});

test('API: source-scoped keys see and touch only their sources', async (t) => {
  const w = workspace();
  t.after(w.cleanup);
  const { app } = await buildApp(w.dir);
  t.after(() => app.close());
  const logs = JSON.parse((await app.inject({ method: 'POST', url: '/v1/sources/logs/backups', headers: bearer(ADMIN_KEY) })).body).backup;
  const s = bearer(SCOPED_KEY);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/sources/app/backups', headers: s })).statusCode, 201);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/sources/logs/backups', headers: s })).statusCode, 403);
  assert.deepEqual(JSON.parse((await app.inject({ method: 'GET', url: '/v1/sources', headers: s })).body).items.map((/** @type {any} */ x) => x.id), ['app']);
  assert.deepEqual(JSON.parse((await app.inject({ method: 'GET', url: '/v1/backups', headers: s })).body).items.map((/** @type {any} */ x) => x.source), ['app']);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/backups?source=logs', headers: s })).statusCode, 403);
  for (const [method, url] of [['GET', `/v1/backups/${logs.id}`], ['GET', `/v1/backups/${logs.id}/download`], ['POST', `/v1/backups/${logs.id}/verify`], ['DELETE', `/v1/backups/${logs.id}`]]) {
    assert.equal((await app.inject({ method: /** @type {any} */ (method), url, headers: s })).statusCode, 404, `${method} ${url}`);
  }
  const metrics = (await app.inject({ method: 'GET', url: '/metrics', headers: s })).body;
  assert.match(metrics, /backup_stored\{source="app"\} 1/);
  assert.equal(metrics.includes('source="logs"'), false);
  assert.equal(JSON.parse((await app.inject({ method: 'GET', url: '/v1/stats', headers: s })).body).sources, 1);
});
