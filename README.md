# atc-backup

Scheduled online backups of the platform's SQLite data files. Each backup is taken through SQLite's backup API while the owning service keeps running, stored as one self-contained file, checked with `PRAGMA integrity_check` and recorded with its SHA-256. Retention by count and age, download with checksum, re-verify, restore to a file, a guarded live restore with a safety backup, and optional off-host copies in atc-media. HTTP only.

Runtime dependencies: `fastify`, `@fastify/rate-limit`, `@atc-web/atc-service-core`. Storage and backups use `node:sqlite` (Node 22.13+).

## Run

```bash
cp .env.example .env        # set BACKUP_API_KEYS and BACKUP_SOURCES
npm ci
npm run dev
```

Production: `npm ci --omit=dev && pm2 start ecosystem.config.cjs`, or `docker build -t atc-backup .` and run it with the source volumes mounted under `/sources/<id>` (see [examples/operations.md](examples/operations.md)).

Tests and type check: `npm test`, `npm run typecheck`.

## Model

- **Source**: `id=path` from `BACKUP_SOURCES`, the live SQLite file of another service. Paths come only from configuration.
- **Backup**: one attempt for one source, `status` `running`, `ok` or `failed`, `trigger` `schedule`, `manual` or `pre-restore`. An `ok` backup has a file in `BACKUP_DIR/<source>/`, its size, page count and SHA-256.
- **Schedule**: every `BACKUP_INTERVAL_MIN` per source, counted from the newest attempt; `0` = manual only. Backups and restores run one at a time.
- **Retention**: after each successful backup, keep the newest `RETENTION_COUNT`, drop those older than `RETENTION_DAYS`; the newest is always kept.
- **Restore**: to `RESTORE_DIR/<target>`, or (with `ALLOW_LIVE_RESTORE=true` and `confirm`) over the live file after a safety backup.

## API

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/health`, `/ready`, `/v1/info` | none | Probes, identity |
| GET | `/metrics` | read | Prometheus text (only the key's sources) |
| GET | `/v1/sources`, `/v1/sources/:id` | read | Sources with their newest backup and next due time |
| POST | `/v1/sources/:id/backups` | admin | Back up now; waits, returns the record (`ok` or `failed`) |
| GET | `/v1/backups` | read | Newest first; `source`, `status`, `limit`, `cursor` |
| GET / DELETE | `/v1/backups/:id` | read / admin | One backup; delete it and its file |
| GET | `/v1/backups/:id/download` | admin | The file, with `X-Checksum-SHA256` |
| POST | `/v1/backups/:id/verify` | admin | Re-hash and integrity check |
| POST | `/v1/backups/:id/restore` | admin | `{ target, overwrite }` or `{ live: true, confirm }` |
| GET | `/v1/stats` | read | Totals, failing and stale sources |

Errors: `{ "error": { "code", "message" } }` — `VALIDATION_FAILED`, `INVALID_ARGUMENT` (400), `FORBIDDEN`, `LIVE_RESTORE_DISABLED` (403), `SOURCE_NOT_FOUND`, `BACKUP_NOT_FOUND` (404), `BUSY`, `INVALID_STATE`, `TARGET_EXISTS`, `CHECKSUM_MISMATCH` (409), `RATE_LIMITED` (429). Full contract: [openapi.yaml](openapi.yaml).

## Examples

Sources, backups, retention, download and verify, restore, media copies, scoped keys: [examples/README.md](examples/README.md).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `3017`, `0.0.0.0` | Listen address |
| `BACKUP_API_KEYS` | required | `id:secret:role[:source+source]`; role `read` or `admin` |
| `BACKUP_SOURCES` | empty | `id=path,…`; relative paths resolve against the working directory |
| `BACKUP_DIR`, `RESTORE_DIR` | `./data/backups`, `./data/restores` | Created 0700; files 0600 |
| `BACKUP_INTERVAL_MIN` | `360` | Minutes between scheduled backups; `0` = manual only |
| `RETENTION_COUNT`, `RETENTION_DAYS` | `14`, `30` | Kept per source; `0` days = no age limit |
| `TICK_MS`, `PAGES_PER_STEP` | `60000`, `100000` | Scheduler check interval; SQLite pages per backup step |
| `ALLOW_LIVE_RESTORE` | `false` | Allow replacing a source's live file |
| `MEDIA_URL`, `MEDIA_API_KEY`, `MEDIA_TIMEOUT_MS` | empty, empty, `120000` | Upload each backup to atc-media (both or neither) |
| `DB_PATH`, `DB_BACKUP_DIR`, `BODY_LIMIT`, `RATE_LIMIT_MAX` | `./data/backup.db`, –, `16384`, `600` | |
| `TRUST_PROXY`, `TLS_CERT_PATH`, `TLS_KEY_PATH`, `LOG_LEVEL` | | As in every service |
| `AUDIT_URL`, `AUDIT_API_KEY` | empty | Forward audit events (both or neither) |

## Security notes

- Backups hold everything the sources store (password hashes, keys, sessions). Folders are 0700 and files 0600; downloads are admin only and audited.
- The API never takes a path. Restore targets are plain file names inside `RESTORE_DIR`; this service's own database and files inside its folders cannot be sources.
- A live restore needs the operator switch, a `confirm` of the source id, a verified checksum and a successful safety backup.
- Every route checks the key's role and source scope; a scoped key gets `404` for other sources' backups.

## Code layout

```
src/
  application.js           composition root, scheduler, lifecycle
  config.js, db.js, types.js
  domain/backup-service.js online backup, integrity, checksums, retention, verify, restore, scheduling
  store/backup-store.js    SQLite statements for backup records
  net/media-client.js      streamed upload to atc-media, delete
  http/                    BackupApi routes, ApiKeyAuth (roles, source scopes), Schemas, Views
test/                      node:test suites
```

## Out of scope by design

- Databases other than SQLite, and files on other hosts (mount them; there is no agent).
- Compression and encryption at rest of the backup files (use an encrypted volume; atc-media copies are private files).
- Point-in-time recovery between backups (WAL shipping).
- Stopping and starting the owning service around a live restore; the operator does that.

## Audit events

With `AUDIT_URL` and `AUDIT_API_KEY` set, `atc-backup.backup.create` (meta: source, status), `atc-backup.backup.download` (meta: source), `atc-backup.backup.verify` (meta: checksumOk, integrity), `atc-backup.backup.restore` (meta: live, target, safetyBackupId) and `atc-backup.backup.delete` (meta: source) are forwarded with `success`, or `denied` on 403. Scheduled runs and retention are not audited. Details: [examples/audit-events.md](examples/audit-events.md).

## Scaling model

**B — single-node stateful.** One process per `DB_PATH`, on the host (or with the volumes) of its sources. See [docs/READINESS.md](docs/READINESS.md).

## Observability

Request logs with request id and trace context; `/metrics` (last success time, last outcome, stored count and bytes per source); `/v1/stats` (failing, stale); `/ready`.

Audit forwarding is observable too: `audit_forward_enabled`, `audit_forward_events_total{result="recorded|sent|dropped|failed"}` and `audit_forward_pending`. A rising `dropped`, or a `pending` that does not drain, means audit events are being lost or delayed; alert on it.

## Backup / restore

Of this service: `DB_PATH` holds only records; the data is the files in `BACKUP_DIR` (and their atc-media copies). Of the sources: [examples/restore.md](examples/restore.md).

## License

MIT, see [LICENSE](LICENSE).
