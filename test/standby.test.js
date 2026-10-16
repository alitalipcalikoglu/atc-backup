import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Cipher } from '../src/crypto/cipher.js';
import { StandbyPull } from '../src/standby.js';

const KEY = 'ab'.repeat(32);

/** A fake primary answering the two calls the puller makes. @param {string} file @param {object|null} backup */
function primary(file, backup) {
  /** @type {string[]} */ const seen = [];
  const fetchImpl = /** @type {typeof fetch} */ (async (url, init) => {
    seen.push(`${url} ${/** @type {any} */ (init?.headers)?.authorization}`);
    if (String(url).includes('/download')) return new Response(readFileSync(file));
    return Response.json({ items: backup ? [backup] : [], nextCursor: null });
  });
  return { fetchImpl, seen };
}

test('standby: pulls the newest verified snapshot, swaps it in, skips when current, refuses bad checksums', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'standby-'));
  try {
    const snap = join(dir, 'snap.db');
    const db = new DatabaseSync(snap);
    db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('from-primary');");
    db.close();
    const sha256 = createHash('sha256').update(readFileSync(snap)).digest('hex');
    const backup = { id: 'bk_mv8abcde0123456789abcdef', format: 'sqlite', encrypted: false, sha256, size: readFileSync(snap).length, startedAt: '2026-10-16T00:00:00.000Z' };
    const target = join(dir, 'live', 'auth.db');
    mkdirSync(join(dir, 'live'));
    writeFileSync(`${target}-wal`, 'stale');
    const { fetchImpl, seen } = primary(snap, backup);
    const puller = new StandbyPull({ url: 'http://primary.test/', apiKey: 'k'.repeat(40), fetchImpl });

    assert.deepEqual(await puller.pull('atc-auth', target), { status: 'updated', backupId: backup.id, sha256 });
    assert.match(seen[0], /^http:\/\/primary\.test\/v1\/backups\?source=atc-auth&status=ok&limit=1 Bearer k{40}$/);
    const copy = new DatabaseSync(target, { readOnly: true });
    assert.equal(/** @type {any} */ (copy.prepare('SELECT v FROM t').get()).v, 'from-primary');
    copy.close();
    assert.equal(existsSync(`${target}-wal`), false, 'a stale WAL never replays over the new file');
    assert.equal(JSON.parse(readFileSync(StandbyPull.markerOf(target), 'utf8')).backupId, backup.id);
    assert.equal((await puller.pull('atc-auth', target)).status, 'current', 'same backup again: nothing downloaded');
    assert.equal(seen.filter((s) => s.includes('/download')).length, 1);

    const bad = new StandbyPull({ url: 'http://primary.test', apiKey: 'k'.repeat(40), fetchImpl: primary(snap, { ...backup, id: 'bk_mv8abcde0123456789abcde0', sha256: '0'.repeat(64) }).fetchImpl });
    await assert.rejects(bad.pull('atc-auth', target), /checksum mismatch/);
    assert.equal(JSON.parse(readFileSync(StandbyPull.markerOf(target), 'utf8')).backupId, backup.id, 'a refused snapshot leaves the previous one in place');
    await assert.rejects(new StandbyPull({ url: 'http://p', apiKey: 'k'.repeat(40), fetchImpl: primary(snap, { ...backup, id: 'bk_mv8abcde0123456789abcde1', size: 1024 }).fetchImpl }).pull('atc-auth', target), /exceeds the recorded size/, 'a body larger than the recorded size is cut off while streaming');
    assert.equal(existsSync(`${target}.standby-download`), false, 'the partial download is removed');
    const slow = /** @type {typeof fetch} */ (async (url, init) => (String(url).includes('/download') ? new Promise((_, reject) => /** @type {AbortSignal} */ (init?.signal).addEventListener('abort', () => reject(/** @type {AbortSignal} */ (init?.signal).reason))) : Response.json({ items: [{ ...backup, id: 'bk_mv8abcde0123456789abcde2' }], nextCursor: null })));
    await assert.rejects(new StandbyPull({ url: 'http://p', apiKey: 'k'.repeat(40), fetchImpl: slow, downloadTimeoutMs: 50 }).pull('atc-auth', target), /timed out/, 'a stalled download is abandoned');
    await assert.rejects(new StandbyPull({ url: 'http://p', apiKey: 'k'.repeat(40), fetchImpl: primary(snap, null).fetchImpl }).pull('atc-auth', target), /no successful backup/);
    await assert.rejects(new StandbyPull({ url: 'http://p', apiKey: 'k'.repeat(40), fetchImpl: primary(snap, { ...backup, format: 'tar.gz' }).fetchImpl }).pull('atc-media', target), /file-tree backup/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('standby: decrypts an encrypted snapshot with BACKUP_ENCRYPTION_KEY and checks integrity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'standby-enc-'));
  try {
    const plain = join(dir, 'plain.db');
    const db = new DatabaseSync(plain);
    db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('sealed');");
    db.close();
    const enc = join(dir, 'snap.db.enc');
    await Cipher.fromHex(KEY).encrypt(plain, enc);
    const backup = { id: 'bk_mv8abcde0123456789abcdef', format: 'sqlite', encrypted: true, size: readFileSync(enc).length, sha256: createHash('sha256').update(readFileSync(enc)).digest('hex') };
    const target = join(dir, 'auth.db');
    await assert.rejects(new StandbyPull({ url: 'http://p', apiKey: 'k'.repeat(40), fetchImpl: primary(enc, backup).fetchImpl }).pull('atc-auth', target), /set BACKUP_ENCRYPTION_KEY/);
    await new StandbyPull({ url: 'http://p', apiKey: 'k'.repeat(40), encryptionKey: KEY, fetchImpl: primary(enc, backup).fetchImpl }).pull('atc-auth', target);
    const copy = new DatabaseSync(target, { readOnly: true });
    assert.equal(/** @type {any} */ (copy.prepare('SELECT v FROM t').get()).v, 'sealed');
    copy.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
