# `atc-backup` readiness contract

## Purpose
Scheduled online backups of the platform's SQLite data files: consistent copies taken while the
owning service runs, integrity-checked and checksummed, with retention, download, verify, restore to
a file, guarded live restore and optional off-host copies in atc-media.

## Dependencies
Read access to the source files (same host or mounted volumes). `atc-media` (optional, off-host
copies), `atc-audit` (optional, events). Neither is needed for a backup to succeed.

## Persistence
Own records in SQLite at `DB_PATH` (`./data/backup.db`; Docker `/data/backup.db`), WAL, one table
`backups`. Backup files in `BACKUP_DIR/<source>/` (0700 folders, 0600 files), restores in
`RESTORE_DIR`. Migrations by `user_version`, snapshot before upgrading, no down migrations.

## Health / readiness
`/health` no I/O. `/ready` database ping and a writable `BACKUP_DIR`, cached 10 s; the body names
the schedule and whether media upload and live restores are enabled.

## Graceful shutdown
`SIGTERM`: the scheduler stops, HTTP drains, the backup or restore in progress finishes, audit flush,
database closes. Force exit 30 s; PM2 `kill_timeout` 35 s. A backup cut off by a crash is marked
`failed` (`interrupted by a restart`) on the next start and its partial file is removed.

## Resource limits
One backup or restore at a time. `PAGES_PER_STEP` 100 000 pages per backup step, `BODY_LIMIT`
16 KiB, `RATE_LIMIT_MAX` 600/min per key, last 50 failed attempts kept per source.

## Timeouts
`MEDIA_TIMEOUT_MS` 120 s per upload. Backups have no timeout; they end when the copy is complete.

## Retry policy
None inside a run. A failed scheduled backup is retried at the next interval; a failed media upload
is recorded on the backup (`media.error`) and not retried.

## Idempotency
A source runs one backup at a time (`409 BUSY`). Backup, verify, drill and restore honour
`Idempotency-Key` (core `Idempotency`, 24 h, per API key and caller): a repeat replays the first 2xx
answer instead of running again. Restores to a file never replace an existing file
without `overwrite`. Deletes of missing backups answer 404.

## Backup / restore
Of itself: its own `DB_PATH` holds only records; the backup files are the data. Of its sources: see
the README.

## Metrics
`backup_last_success_timestamp_seconds{source}`, `backup_last_ok{source}`, `backup_stored{source}`,
`backup_stored_bytes{source}`, `backup_process_uptime_seconds`. Scoped keys see only their sources.

## Logging / tracing
Fastify request logs with request id and trace context, `authorization` redacted; database contents
never logged.

## Security model
Bearer keys with `read`/`admin` and optional source scopes on every route, list, stats and metrics.
Downloads, verifies, restores and deletes are admin only and audited. Source paths come only from
configuration; the API never takes a path. Restore targets are plain file names inside
`RESTORE_DIR`. Live restore needs `ALLOW_LIVE_RESTORE=true`, a `confirm` of the source id and takes a
safety backup first.

## Scaling model
**B — single-node stateful.** One process per `DB_PATH` and per host whose files it reads.

## Known failure modes
- A source written to constantly during a small `PAGES_PER_STEP`: the copy restarts and takes long.
- Disk full: the backup fails, its partial file is removed, earlier backups stay.
- A live restore while the owning service still runs: that service keeps its old file open and its
  writes go to the replaced file. Stop it first.
