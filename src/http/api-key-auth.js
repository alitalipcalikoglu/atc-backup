import { ApiKeyAuth as CoreApiKeyAuth } from '@atc-web/atc-service-core/auth';
import { BackupError } from '../domain/errors.js';

/** @typedef {import('../types.js').ApiKey} ApiKey */

/**
 * Bearer API keys with two roles and optional source scoping. `read` lists sources and backups;
 * `admin` also runs backups, downloads, verifies, restores and deletes them.
 */
export class ApiKeyAuth {
  static GRANTS = Object.freeze({ read: ['read', 'admin'], admin: ['admin'] });

  /** @param {ApiKey[]} apiKeys */
  constructor(apiKeys) {
    this.core = new CoreApiKeyAuth(apiKeys.map((k) => ({ ...k, scopes: k.sources })));
  }

  get hook() {
    return this.core.hook;
  }

  /** @param {'read'|'admin'} need */
  static require(need) {
    return CoreApiKeyAuth.require(need, {
      roleOf: (request) => /** @type {any} */ (request).apiKey?.role,
      makeError: (n) => new BackupError('FORBIDDEN', `this API key has no ${n} access`),
      grants: ApiKeyAuth.GRANTS,
    });
  }

  /** A key scoped to some sources may not touch others. @param {any} key @param {string} source */
  static assertSource(key, source) {
    CoreApiKeyAuth.assertScope(key, source, (name) => new BackupError('FORBIDDEN', `this API key has no access to source "${name}"`));
  }
}
