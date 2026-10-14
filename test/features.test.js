import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Cipher } from '../src/crypto/cipher.js';
import { BackupService } from '../src/domain/backup-service.js';
import { manualClock, testService, workspace } from './helpers.js';

const KEY = 'ab'.repeat(32);
const code = (/** @type {string} */ c) => (/** @type {any} */ e) => e.code === c;
/** A tree with two files and a nested directory. @param {string} dir */
function makeTree(dir) {
  mkdirSync(join(dir, 'blobs', 'ab'), { recursive: true });
  writeFileSync(join(dir, 'blobs', 'one.bin'), 'first object');
  writeFileSync(join(dir, 'blobs', 'ab', 'two.bin'), 'second object');
  return join(dir, 'blobs');
}

test('Cipher: round trip, a wrong key and a changed byte are refused, nothing readable in the file', async (t) => {
  const w = workspace();
  t.after(w.cleanup);
  const src = join(w.dir, 'plain.txt');
  writeFileSync(src, 'secret payload '.repeat(1000));
  const c = Cipher.fromHex(KEY);
  await c.encrypt(src, join(w.dir, 'enc'));
  assert.equal(readFileSync(join(w.dir, 'enc')).includes('secret'), false);
  await c.decrypt(join(w.dir, 'enc'), join(w.dir, 'out'));
  assert.equal(readFileSync(join(w.dir, 'out'), 'utf8'), 'secret payload '.repeat(1000));
  await assert.rejects(Cipher.fromHex('cd'.repeat(32)).decrypt(join(w.dir, 'enc'), join(w.dir, 'bad')), /wrong key or the file was changed/);
  const buf = readFileSync(join(w.dir, 'enc'));
  buf[40] ^= 1;
  writeFileSync(join(w.dir, 'flipped'), buf);
  await assert.rejects(c.decrypt(join(w.dir, 'flipped'), join(w.dir, 'bad')), /wrong key or the file was changed/);
  writeFileSync(join(w.dir, 'short'), 'nope');
  await assert.rejects(c.decrypt(join(w.dir, 'short'), join(w.dir, 'bad')), /not an encrypted backup/);
});

test('trees: a directory is packed into a checksummed tar.gz, verified, restored to a target directory, never live', async (t) => {
  const w = workspace();
  t.after(w.cleanup);
  const tree = makeTree(w.dir);
  const { service, config } = testService(w.dir, { BACKUP_TREES: `blobs=${tree}` });
  assert.deepEqual(config.sources.filter((s) => s.kind === 'tree').map((s) => s.id), ['blobs']);
  const row = await service.run('blobs', { trigger: 'manual', by: 'console' });
  assert.equal(row.status, 'ok', row.error ?? '');
  assert.deepEqual([row.format, row.encrypted, row.pages, /^blobs-\d{8}T\d{6}Z-[0-9a-f]{8}\.tar\.gz$/.test(String(row.file))], ['tar.gz', 0, null, true]);
  assert.deepEqual(readdirSync(join(w.dir, 'backups', 'blobs')), [row.file]);
  assert.deepEqual(await service.verify(row.id).then((v) => [v.checksumOk, v.integrity]), [true, 'ok']);
  const r = await service.restore(row.id, { target: 'blobs-copy', by: 'console' });
  assert.equal(readFileSync(join(w.dir, 'restores', 'blobs-copy', 'blobs', 'ab', 'two.bin'), 'utf8'), 'second object');
  assert.equal(r.live, false);
  await assert.rejects(service.restore(row.id, { target: 'blobs-copy', by: 'console' }), code('TARGET_EXISTS'));
  await service.restore(row.id, { target: 'blobs-copy', overwrite: true, by: 'console' });
  assert.throws(() => service.restore(row.id, { live: true, confirm: 'blobs', by: 'console' }), code('INVALID_ARGUMENT'));
  const sources = await service.sources();
  assert.deepEqual(sources.find((s) => s.id === 'blobs')?.kind, 'tree');
  writeFileSync(service.pathOf(row), 'tampered');
  assert.deepEqual(await service.verify(row.id).then((v) => v.checksumOk), false);
  await assert.rejects(service.restore(row.id, { target: 'again', by: 'console' }), code('CHECKSUM_MISMATCH'));
});

test('encryption: stored files are AES-GCM encrypted, verify and restore decrypt them, a wrong key fails, nothing plain is left behind', async (t) => {
  const w = workspace();
  t.after(w.cleanup);
  const tree = makeTree(w.dir);
  const { service } = testService(w.dir, { BACKUP_ENCRYPTION_KEY: KEY, BACKUP_TREES: `blobs=${tree}` });
  const db = await service.run('app', { trigger: 'manual', by: 'console' });
  assert.equal(db.status, 'ok', db.error ?? '');
  assert.deepEqual([db.encrypted, db.format, /\.db\.enc$/.test(String(db.file))], [1, 'sqlite', true]);
  const stored = readFileSync(service.pathOf(db));
  assert.equal(stored.includes('app-1') || stored.includes('SQLite format'), false, 'no plaintext in the stored file');
  assert.deepEqual(await service.verify(db.id).then((v) => [v.checksumOk, v.integrity]), [true, 'ok']);
  const r = await service.restore(db.id, { target: 'app-restored.db', by: 'console' });
  assert.equal(r.live, false);
  const restored = new DatabaseSync(join(w.dir, 'restores', 'app-restored.db'), { readOnly: true });
  assert.equal(Number(restored.prepare('SELECT COUNT(*) AS n FROM items').get()?.n), 2);
  restored.close();
  const tr = await service.run('blobs', { trigger: 'manual', by: 'console' });
  assert.deepEqual([tr.encrypted, tr.format, /\.tar\.gz\.enc$/.test(String(tr.file))], [1, 'tar.gz', true]);
  await service.restore(tr.id, { target: 'blobs-out', by: 'console' });
  assert.equal(readFileSync(join(w.dir, 'restores', 'blobs-out', 'blobs', 'one.bin'), 'utf8'), 'first object');
  for (const dir of [join(w.dir, 'backups', 'app'), join(w.dir, 'backups', 'blobs'), join(w.dir, 'restores')]) {
    assert.equal(readdirSync(dir).some((n) => n.includes('plain') || n.includes('partial')), false, `${dir} has no plain or partial leftovers`);
  }
  const other = testService(w.dir, { BACKUP_ENCRYPTION_KEY: 'cd'.repeat(32) });
  other.store.insert('bk_x', 'app', 'manual', 'x', 1);
  other.store.finishOk('bk_x', { file: db.file ?? '', size: Number(db.size), sha256: db.sha256 ?? '', pages: null, format: 'sqlite', encrypted: true }, 2);
  assert.match(String((await other.service.verify('bk_x')).integrity), /wrong key/);
  const keyless = testService(w.dir);
  keyless.store.insert('bk_y', 'app', 'manual', 'x', 1);
  keyless.store.finishOk('bk_y', { file: db.file ?? '', size: Number(db.size), sha256: db.sha256 ?? '', pages: null, format: 'sqlite', encrypted: true }, 2);
  assert.match(String((await keyless.service.verify('bk_y')).integrity), /BACKUP_ENCRYPTION_KEY is not set/);
});

test('drill: restores into a scratch place and reads it back; table counts for databases, entries for trees; failures are recorded and announced', async (t) => {
  const w = workspace();
  t.after(w.cleanup);
  const tree = makeTree(w.dir);
  /** @type {any[]} */ const out = [];
  const { service, store } = testService(w.dir, { BACKUP_TREES: `blobs=${tree}` }, { publisher: { publish: (/** @type {string} */ ty, /** @type {any} */ d) => out.push([ty, d]) } });
  const db = await service.run('app', { trigger: 'manual', by: 'console' });
  const d1 = await service.drill(db.id);
  assert.deepEqual([d1.ok, d1.detail.integrity, d1.detail.tables], [true, 'ok', { items: 2 }]);
  assert.deepEqual([store.get(db.id)?.drill_ok, typeof store.get(db.id)?.drill_at], [1, 'number']);
  const tr = await service.run('blobs', { trigger: 'manual', by: 'console' });
  const d2 = await service.drill(tr.id);
  assert.deepEqual([d2.ok, d2.detail.entries], [true, 4]);
  assert.equal(readdirSync(join(w.dir, 'restores')).length, 0, 'the scratch directory is removed');
  writeFileSync(service.pathOf(db), 'broken');
  const d3 = await service.drill(db.id);
  assert.deepEqual([d3.ok, d3.detail.error], [false, 'checksum mismatch']);
  assert.deepEqual(out.filter(([ty]) => ty === 'ops.backup.failed').map(([ty, d]) => [ty, d.stage, d.trigger]), [['ops.backup.failed', 'drill', 'drill']]);
  assert.deepEqual(store.lastDrilled('app'), { at: store.get(db.id)?.drill_at, ok: false });
});

test('drill schedule: the newest backup of a source is drilled once per DRILL_INTERVAL_HOURS', async (t) => {
  const w = workspace();
  t.after(w.cleanup);
  const clock = manualClock();
  const { service, store } = testService(w.dir, { BACKUP_INTERVAL_MIN: '60', DRILL_INTERVAL_HOURS: '2' }, { now: clock.now });
  await service.tick();
  const drilled = () => ['app', 'logs'].map((s) => store.lastDrilled(s) !== null);
  assert.deepEqual(drilled(), [true, true], 'the first tick backs up and drills');
  const first = store.lastDrilled('app')?.at;
  clock.advance(61 * 60_000);
  await service.tick();
  assert.equal(store.lastDrilled('app')?.at, first, 'a new backup an hour later is not drilled yet');
  clock.advance(61 * 60_000);
  await service.tick();
  assert.notEqual(store.lastDrilled('app')?.at, first, 'after two hours it is');
  const off = testService(w.dir, { BACKUP_INTERVAL_MIN: '60', DRILL_INTERVAL_HOURS: '0' }, { now: clock.now });
  await off.service.tick();
  assert.equal(off.store.lastDrilled('logs'), null, 'drills can be switched off');
});

test('BackupService.tableCounts quotes odd table names', (t) => {
  const w = workspace();
  t.after(w.cleanup);
  const p = join(w.dir, 'odd.db');
  const db = new DatabaseSync(p);
  db.exec('CREATE TABLE "we""ird" (a); INSERT INTO "we""ird" VALUES (1), (2)');
  db.close();
  assert.deepEqual(BackupService.tableCounts(p), { 'we"ird': 2 });
  assert.equal(existsSync(p), true);
});

test('decrypt CLI: turns a stored encrypted backup back into a database with the key from the environment', async (t) => {
  const { execFile } = await import('node:child_process');
  const w = workspace();
  t.after(w.cleanup);
  const { service } = testService(w.dir, { BACKUP_ENCRYPTION_KEY: KEY });
  const row = await service.run('app', { trigger: 'manual', by: 'console' });
  const run = (/** @type {Record<string, string>} */ env, /** @type {string[]} */ args) => new Promise((resolve) => {
    execFile(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '..', 'src', 'decrypt-cli.js'), ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => resolve({ code: err ? Number(err.code) : 0, stdout, stderr }));
  });
  const out = join(w.dir, 'plain.db');
  assert.equal(/** @type {any} */ (await run({ BACKUP_ENCRYPTION_KEY: KEY }, [service.pathOf(row), out])).code, 0);
  assert.equal(BackupService.integrity(out, true), 'ok');
  assert.match(/** @type {any} */ (await run({ BACKUP_ENCRYPTION_KEY: 'cd'.repeat(32) }, [service.pathOf(row), join(w.dir, 'x.db')])).stderr, /wrong key/);
  assert.equal(/** @type {any} */ (await run({ BACKUP_ENCRYPTION_KEY: '' }, [service.pathOf(row), out])).code, 2);
});
