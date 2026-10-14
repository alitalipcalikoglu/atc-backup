import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { ADMIN_KEY, READ_KEY, bearer, buildApp, workspace } from './helpers.js';

const silent = { warn() {}, error() {} };

test('API: backup runs, downloads, verifies, restores and deletes are audit events; reads are not', async (t) => {
  const w = workspace();
  t.after(w.cleanup);
  const audit = new AuditClient({ target: { url: 'http://audit.test', apiKey: 'a'.repeat(40) }, logger: silent, fetch: async () => new Response('{}', { status: 200 }) });
  const { app } = await buildApp(w.dir, undefined, { audit });
  t.after(() => app.close());
  const a = { ...bearer(ADMIN_KEY), 'user-agent': 'test-agent' };
  const id = JSON.parse((await app.inject({ method: 'POST', url: '/v1/sources/app/backups', headers: a })).body).backup.id;
  await app.inject({ method: 'GET', url: '/v1/backups', headers: a });
  await app.inject({ method: 'GET', url: `/v1/backups/${id}/download`, headers: a });
  await app.inject({ method: 'POST', url: `/v1/backups/${id}/verify`, headers: a });
  await app.inject({ method: 'POST', url: `/v1/backups/${id}/restore`, headers: a, payload: { target: 'r.db' } });
  await app.inject({ method: 'DELETE', url: `/v1/backups/${id}`, headers: a });
  assert.deepEqual(audit.buffer.map((e) => e.action), ['atc-backup.backup.create', 'atc-backup.backup.download', 'atc-backup.backup.verify', 'atc-backup.backup.restore', 'atc-backup.backup.delete']);
  const [create, download, verify, restore, del] = audit.buffer;
  assert.deepEqual([create.actor, create.target, create.meta], [{ type: 'apikey', id: 'console' }, { type: 'backup', id }, { source: 'app', status: 'ok' }]);
  assert.deepEqual([download.meta, verify.meta, restore.meta, del.meta], [{ source: 'app' }, { checksumOk: true, integrity: 'ok' }, { live: false, target: 'r.db', safetyBackupId: null }, { source: 'app' }]);
  const n = audit.buffer.length;
  assert.equal((await app.inject({ method: 'POST', url: '/v1/sources/app/backups', headers: bearer(READ_KEY) })).statusCode, 403);
  assert.deepEqual([audit.buffer.length, audit.buffer.at(-1)?.outcome], [n + 1, 'denied']);
});
