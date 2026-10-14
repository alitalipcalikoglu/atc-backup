import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { BackupService } from '../src/domain/backup-service.js';
import { manualClock, testService, workspace } from './helpers.js';

const count = (/** @type {string} */ path) => { const db = new DatabaseSync(path, { readOnly: true }); try { return Number(db.prepare('SELECT COUNT(*) AS n FROM items').get()?.n); } finally { db.close(); } };
const code = (/** @type {string} */ c) => (/** @type {any} */ e) => e.code === c;

test('backup: online copy of a live WAL database, self-contained, checksummed, integrity-checked', async (t) => {
  const w = workspace();
  t.after(w.cleanup);
  const { service } = testService(w.dir);
  w.live.app.prepare('INSERT INTO items (name) VALUES (?)').run('only-in-wal');
  const row = await service.run('app', { trigger: 'manual', by: 'console' });
  assert.equal(row.status, 'ok', row.error ?? '');
  assert.deepEqual([row.source, row.trigger, row.created_by, row.verify_ok], ['app', 'manual', 'console', 1]);
  const path = service.pathOf(row);
  assert.match(String(row.file), /^app-\d{8}T\d{6}Z-[0-9a-f]{8}\.db$/);
  assert.deepEqual(readdirSync(join(w.dir, 'backups', 'app')), [row.file], 'no partial files or sidecars');
  assert.equal(await BackupService.sha256(path), row.sha256);
  assert.equal(count(path), 3, 'rows still in the WAL are part of the backup');
  assert.equal(BackupService.integrity(path, true), 'ok');
  w.live.app.prepare('INSERT INTO items (name) VALUES (?)').run('after');
  assert.equal(count(join(w.dir, 'app.db')), 4, 'the live database keeps working');
});

test('backup: a missing source fails cleanly; a source cannot run twice at once; unknown source', async (t) => {
  const w = workspace();
  t.after(w.cleanup);
  const { service } = testService(w.dir);
  const gone = await service.run('gone', { trigger: 'manual', by: 'x' });
  assert.deepEqual([gone.status, gone.file], ['failed', null]);
  assert.match(String(gone.error), /does not exist/);
  const first = service.run('app', { trigger: 'manual', by: 'x' });
  assert.throws(() => service.run('app', { trigger: 'manual', by: 'x' }), code('BUSY'));
  assert.equal((await first).status, 'ok');
  assert.throws(() => service.run('nope', { trigger: 'manual', by: 'x' }), code('SOURCE_NOT_FOUND'));
});

test('retention: newest RETENTION_COUNT kept, older than RETENTION_DAYS dropped, the newest always kept', async (t) => {
  const w = workspace();
  t.after(w.cleanup);
  const clock = manualClock();
  const { service, store } = testService(w.dir, { RETENTION_COUNT: '2', RETENTION_DAYS: '3' }, { now: clock.now });
  const ids = [];
  for (let i = 0; i < 3; i++) { ids.push((await service.run('app', { trigger: 'manual', by: 'x' })).id); clock.advance(60_000); }
  assert.deepEqual(store.okOf('app').map((r) => r.id), [ids[2], ids[1]]);
  assert.equal(readdirSync(join(w.dir, 'backups', 'app')).length, 2);
  clock.advance(10 * 86_400_000);
  const last = await service.run('app', { trigger: 'manual', by: 'x' });
  assert.deepEqual(store.okOf('app').map((r) => r.id), [last.id], 'older than 3 days are gone');
  clock.advance(10 * 86_400_000);
  assert.equal(store.okOf('app').length, 1);
});

test('verify: checksum and integrity; a tampered file is reported, never restored', async (t) => {
  const w = workspace();
  t.after(w.cleanup);
  const { service } = testService(w.dir);
  const row = await service.run('app', { trigger: 'manual', by: 'x' });
  const ok = await service.verify(row.id);
  assert.deepEqual([ok.checksumOk, ok.integrity, ok.backup.verify_ok], [true, 'ok', 1]);
  writeFileSync(service.pathOf(row), 'garbage');
  const bad = await service.verify(row.id);
  assert.deepEqual([bad.checksumOk, bad.backup.verify_ok], [false, 0]);
  assert.notEqual(bad.integrity, 'ok');
  await assert.rejects(service.restore(row.id, { target: 'x.db', by: 'x' }), code('CHECKSUM_MISMATCH'));
  assert.equal(existsSync(join(w.dir, 'restores', 'x.db')), false);
  const failed = await service.run('gone', { trigger: 'manual', by: 'x' });
  assert.throws(() => service.verify(failed.id), code('INVALID_STATE'));
});

test('restore: to a new file in RESTORE_DIR; existing files need overwrite; names cannot escape', async (t) => {
  const w = workspace();
  t.after(w.cleanup);
  const { service } = testService(w.dir);
  const row = await service.run('app', { trigger: 'manual', by: 'x' });
  const r = await service.restore(row.id, { target: 'app-copy.db', by: 'x' });
  assert.deepEqual([r.live, r.target, r.sha256, r.safetyBackupId], [false, 'app-copy.db', row.sha256, null]);
  assert.equal(count(join(w.dir, 'restores', 'app-copy.db')), 2);
  await assert.rejects(service.restore(row.id, { target: 'app-copy.db', by: 'x' }), code('TARGET_EXISTS'));
  await service.restore(row.id, { target: 'app-copy.db', overwrite: true, by: 'x' });
  for (const target of ['../app.db', 'a/b.db', '', '.hidden']) assert.throws(() => service.restore(row.id, { target, by: 'x' }), code('INVALID_ARGUMENT'));
  assert.equal(count(join(w.dir, 'app.db')), 2, 'the live database is untouched');
});

test('restore live: off by default, needs confirm, takes a safety backup, drops stale sidecars', async (t) => {
  const w = workspace();
  t.after(w.cleanup);
  const off = testService(w.dir);
  const row0 = await off.service.run('app', { trigger: 'manual', by: 'x' });
  assert.throws(() => off.service.restore(row0.id, { live: true, confirm: 'app', by: 'x' }), code('LIVE_RESTORE_DISABLED'));

  const { service, store } = testService(w.dir, { ALLOW_LIVE_RESTORE: 'true', BACKUP_DIR: join(w.dir, 'b2') });
  const row = await service.run('app', { trigger: 'manual', by: 'x' });
  assert.throws(() => service.restore(row.id, { live: true, confirm: 'logs', by: 'x' }), code('INVALID_ARGUMENT'));
  assert.throws(() => service.restore(row.id, { live: true, confirm: 'app', target: 'x.db', by: 'x' }), code('INVALID_ARGUMENT'));
  w.live.app.prepare('INSERT INTO items (name) VALUES (?)').run('lost-without-safety');
  w.live.app.close(); // the owning service is stopped before a live restore
  const r = await service.restore(row.id, { live: true, confirm: 'app', by: 'console' });
  assert.equal(r.live, true);
  assert.equal(count(join(w.dir, 'app.db')), 2, 'live database is the backup again');
  for (const x of ['-wal', '-shm']) assert.equal(existsSync(join(w.dir, `app.db${x}`)), false);
  const safety = store.get(/** @type {string} */ (r.safetyBackupId));
  assert.deepEqual([safety?.trigger, safety?.status, safety?.created_by], ['pre-restore', 'ok', 'console']);
  assert.equal(count(service.pathOf(/** @type {any} */ (safety))), 3, 'the safety backup holds the replaced data');
});

test('scheduler: due sources are backed up once per interval; recover() fails interrupted rows', async (t) => {
  const w = workspace();
  t.after(w.cleanup);
  const clock = manualClock();
  const { service, store } = testService(w.dir, { BACKUP_INTERVAL_MIN: '60' }, { now: clock.now });
  await service.tick();
  const st = () => store.list({ sources: null, limit: 50 }).map((r) => `${r.source}:${r.status}`).sort();
  assert.deepEqual(st(), ['app:ok', 'gone:failed', 'logs:ok']);
  clock.advance(30 * 60_000);
  await service.tick();
  assert.equal(st().length, 3, 'nothing due yet');
  clock.advance(31 * 60_000);
  await service.tick();
  assert.equal(st().length, 6);
  const sources = await service.sources();
  assert.deepEqual(sources.map((s) => [s.id, s.exists, s.okCount, s.nextDueAt]), [['app', true, 2, clock.now() + 3_600_000], ['logs', true, 2, clock.now() + 3_600_000], ['gone', false, 0, clock.now() + 3_600_000]]);

  store.insert('bk_stuck', 'app', 'manual', 'x', clock.now());
  writeFileSync(join(w.dir, 'backups', 'app', '.app-x.db.partial'), 'x');
  await service.recover();
  assert.deepEqual([store.get('bk_stuck')?.status, store.get('bk_stuck')?.error], ['failed', 'interrupted by a restart']);
  assert.equal(readdirSync(join(w.dir, 'backups', 'app')).some((n) => n.includes('.partial')), false);
  const manual = testService(w.dir, { BACKUP_INTERVAL_MIN: '0' });
  await manual.service.tick();
  assert.equal(manual.store.list({ sources: null, limit: 5 }).length, 0, 'interval 0 = manual only');
});

test('media: each successful backup is uploaded; failures are recorded; pruning deletes the copy', async (t) => {
  const w = workspace();
  t.after(w.cleanup);
  /** @type {string[]} */ const calls = [];
  let fail = false;
  const media = {
    upload: async (/** @type {string} */ _p, /** @type {string} */ name) => { calls.push(`up:${name}`); if (fail) throw new Error('atc-media responded 503'); return { id: `m${calls.length}`, size: 1 }; },
    delete: async (/** @type {string} */ id) => { calls.push(`del:${id}`); },
  };
  const { service } = testService(w.dir, { RETENTION_COUNT: '1' }, { media });
  const a = await service.run('app', { trigger: 'manual', by: 'x' });
  assert.deepEqual([a.media_id, a.media_error], ['m1', null]);
  fail = true;
  const b = await service.run('app', { trigger: 'manual', by: 'x' });
  assert.deepEqual([b.status, b.media_id, b.media_error], ['ok', null, 'atc-media responded 503']);
  assert.deepEqual(calls, [`up:${a.file}`, 'del:m1', `up:${b.file}`]);
  await service.delete(b.id);
  assert.throws(() => service.get(b.id), code('BACKUP_NOT_FOUND'));
});

test('permissions: backup and restore dirs are 0700, backup and restored files 0600', { skip: process.platform === 'win32' }, async (t) => {
  const w = workspace();
  t.after(w.cleanup);
  const { statSync, mkdirSync, chmodSync } = await import('node:fs');
  mkdirSync(join(w.dir, 'backups'), { mode: 0o755 });
  chmodSync(join(w.dir, 'backups'), 0o755);
  const { service } = testService(w.dir);
  const mode = (/** @type {string} */ p) => statSync(p).mode & 0o777;
  const row = await service.run('app', { trigger: 'manual', by: 'x' });
  assert.equal(row.status, 'ok', row.error ?? '');
  assert.equal(mode(join(w.dir, 'backups')), 0o700, 'an existing BACKUP_DIR is tightened');
  assert.equal(mode(join(w.dir, 'backups', 'app')), 0o700);
  assert.equal(mode(service.pathOf(row)), 0o600);
  await service.restore(row.id, { target: 'copy.db', by: 'x' });
  assert.equal(mode(join(w.dir, 'restores')), 0o700);
  assert.equal(mode(join(w.dir, 'restores', 'copy.db')), 0o600);
});
