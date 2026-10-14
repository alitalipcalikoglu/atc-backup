import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Config, ConfigError } from '../src/config.js';
import { testEnv } from './helpers.js';

test('Config: defaults, sources, roles and source scopes', () => {
  const c = Config.fromEnv(testEnv('/w', { PORT: '' }));
  assert.equal(c.port, 3017);
  assert.deepEqual(c.sources.map((s) => [s.id, s.path]), [['app', '/w/app.db'], ['logs', '/w/logs.db'], ['gone', '/w/missing.db']]);
  assert.deepEqual(c.apiKeys.map((k) => [k.id, k.role, k.sources]), [['console', 'admin', null], ['dash', 'read', null], ['ops', 'admin', ['app']]]);
  assert.deepEqual([c.schedule.intervalMin, c.schedule.retentionCount, c.schedule.retentionDays, c.allowLiveRestore, c.media], [360, 14, 30, false, null]);
  const rel = Config.fromEnv(testEnv('/w', { BACKUP_SOURCES: 'atc-auth=../atc-auth/data/auth.db', BACKUP_API_KEYS: `a:${'a'.repeat(40)}:admin` }));
  assert.equal(rel.sources[0].path, resolve('../atc-auth/data/auth.db'));
  assert.equal(Config.fromEnv(testEnv('/w', { BACKUP_SOURCES: '', BACKUP_API_KEYS: `a:${'a'.repeat(40)}:read` })).sources.length, 0);
});

test('Config: rejects bad input', () => {
  const bad = (/** @type {Record<string,string>} */ o, /** @type {RegExp} */ re) => assert.throws(() => Config.fromEnv(testEnv('/w', o)), (e) => e instanceof ConfigError && re.test(e.message));
  bad({ BACKUP_API_KEYS: '' }, /BACKUP_API_KEYS is required/);
  bad({ BACKUP_API_KEYS: `a:${'a'.repeat(40)}` }, /must be read or admin/);
  bad({ BACKUP_API_KEYS: `a:${'a'.repeat(40)}:admin:nope` }, /unknown source "nope"/);
  bad({ BACKUP_SOURCES: 'App=/x.db' }, /lowercase id/);
  bad({ BACKUP_SOURCES: 'a=/x.db,b=/x.db' }, /listed twice/);
  bad({ BACKUP_SOURCES: 'a=/x.db,a=/y.db' }, /listed twice/);
  bad({ BACKUP_SOURCES: 'a=:memory:' }, /needs a file path/);
  bad({ BACKUP_SOURCES: 'a=/w/backups/x.db' }, /inside BACKUP_DIR/);
  bad({ DB_PATH: '/w/app.db' }, /own database/);
  bad({ MEDIA_URL: 'http://media' }, /must be set together/);
  bad({ TLS_KEY_PATH: '/k.pem' }, /must be set together/);
});
