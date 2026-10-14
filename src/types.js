/**
 * Shared JSDoc typedefs for the backup service. No runtime exports.
 */

/** @typedef {'read'|'admin'} KeyRole */

/**
 * @typedef {object} ApiKey
 * @property {string} id
 * @property {string} secret
 * @property {KeyRole} role
 * @property {string[]|null} sources   Sources the key may touch; null = all.
 */

/**
 * @typedef {object} Source
 * @property {string} id     Stable name, usually the owning service id (`atc-auth`).
 * @property {string} path   Absolute path of the live SQLite file, or of the file or directory of a tree source.
 * @property {'sqlite'|'tree'} kind  `sqlite`: online backup of a database. `tree`: a file or directory packed into a `.tar.gz`.
 */

/**
 * @typedef {object} Schedule
 * @property {number} intervalMin     Minutes between scheduled backups of a source; 0 = manual only.
 * @property {number} retentionCount  Newest successful backups kept per source.
 * @property {number} retentionDays   Successful backups older than this are deleted; 0 = no age limit.
 * @property {number} tickMs          How often the scheduler looks for due sources.
 * @property {number} pagesPerStep    SQLite pages copied per backup step (other work runs between steps).
 */

/**
 * @typedef {object} MediaTarget
 * @property {string} url
 * @property {string} apiKey
 * @property {number} timeoutMs
 */

/**
 * @typedef {object} ConfigValues
 * @property {number} port
 * @property {string} host
 * @property {string} logLevel
 * @property {boolean} trustProxy
 * @property {{ certPath: string, keyPath: string }|null} tls
 * @property {{ url: string, apiKey: string }|null} audit
 * @property {number} bodyLimit
 * @property {string} dbPath
 * @property {string|undefined} dbBackupDir
 * @property {string} backupDir
 * @property {string} restoreDir
 * @property {Source[]} sources
 * @property {ApiKey[]} apiKeys
 * @property {number} rateLimitMax
 * @property {MediaTarget|null} media
 * @property {{ url: string, apiKey: string, timeoutMs: number }|null} webhookOut  atc-webhook-out target for operational events (null = off).
 * @property {Schedule} schedule
 * @property {boolean} allowLiveRestore
 * @property {string|null} encryptionKey  64 hex characters; backups are encrypted at rest when set.
 * @property {number} drillIntervalHours  Hours between automatic restore drills of the newest backup per source; 0 = off.
 */

/** @typedef {'running'|'ok'|'failed'} BackupStatus */
/** @typedef {'schedule'|'manual'|'pre-restore'} BackupTrigger */

/**
 * @typedef {object} BackupRow
 * @property {string} id
 * @property {string} source
 * @property {BackupStatus} status
 * @property {BackupTrigger} trigger
 * @property {string|null} file          Name inside BACKUP_DIR/<source>/.
 * @property {number|null} size
 * @property {string|null} sha256
 * @property {number|null} pages
 * @property {'sqlite'|'tar.gz'} format
 * @property {number} encrypted          1 when the stored file is AES-256-GCM encrypted.
 * @property {number|null} drill_at
 * @property {number|null} drill_ok
 * @property {string|null} drill_detail  JSON: what the last restore drill found.
 * @property {string|null} error
 * @property {string} created_by
 * @property {number} started_at
 * @property {number|null} finished_at
 * @property {number|null} verified_at
 * @property {number|null} verify_ok
 * @property {string|null} media_id
 * @property {string|null} media_error
 */

/** @typedef {import('fastify').FastifyBaseLogger} Logger */

export {};
