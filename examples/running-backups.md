# Running backups

```bash
bk -X POST $BACKUP/v1/sources/atc-auth/backups
```

`201`, after the copy is complete:

```json
{ "backup": { "id": "bk_m1x2y3z4a1b2c3d4e5f60718", "source": "atc-auth", "status": "ok", "trigger": "manual",
  "file": "atc-auth-20261014T101500Z-e5f60718.db", "size": 241664, "sha256": "9f2c…", "pages": 59,
  "error": null, "createdBy": "atc-console", "startedAt": "2026-10-14T10:15:00.000Z", "finishedAt": "2026-10-14T10:15:00.084Z",
  "durationMs": 84, "verifiedAt": "2026-10-14T10:15:00.084Z", "verified": true, "media": null } }
```

How a backup is made: SQLite's backup API copies the database while its service keeps writing (WAL content included), the copy is switched to a single file with no `-wal`/`-shm`, `PRAGMA integrity_check` must answer `ok`, then the SHA-256 and size are recorded and the file is moved into `BACKUP_DIR/<source>/`.

A failed attempt is recorded too and still answers `201`; check `status`:

```json
{ "backup": { "status": "failed", "file": null, "error": "the database file of \"atc-auth\" does not exist", "...": "..." } }
```

Browse, newest first, with paging:

```bash
bk "$BACKUP/v1/backups?source=atc-auth&status=ok&limit=20"
bk "$BACKUP/v1/backups?limit=20&cursor=<nextCursor>"
bk $BACKUP/v1/backups/bk_m1x2y3z4a1b2c3d4e5f60718
```

Pitfalls:
- A second run for the same source while one is running answers `409 BUSY`. Runs of different sources queue one after another.
- The request waits for the backup. Large files take as long as reading them from disk.
