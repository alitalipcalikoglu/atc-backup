# Sources and schedule

Sources are the live SQLite files this service may read. They come from configuration only; no API call can add a path.

```bash
BACKUP_SOURCES=atc-auth=../atc-auth/data/auth.db,atc-content=../atc-content/data/content.db
BACKUP_INTERVAL_MIN=360   # every 6 hours; 0 = manual only
```

Relative paths resolve against this service's working directory. Each id must be unique and lowercase; usually it is the owning service id.

```bash
bk $BACKUP/v1/sources
```

```json
{ "items": [
  { "id": "atc-auth", "file": "auth.db", "exists": true, "size": 245760, "running": false,
    "lastBackup": { "id": "bk_m1x2y3z4a1b2c3d4e5f60718", "status": "ok", "trigger": "schedule", "size": 241664, "...": "..." },
    "lastOkAt": "2026-10-14T06:00:00.000Z", "backups": 9, "bytes": 2174976, "nextDueAt": "2026-10-14T12:00:00.000Z" }
] }
```

What to expect:
- The scheduler looks for due sources every `TICK_MS` (60 s) and once right after start, so a source never backed up is backed up at once.
- `nextDueAt` counts from the start of the newest attempt, failed ones included; a failing source is retried once per interval, not in a loop.
- `file` is only the base name. Full paths are never returned.

Pitfalls:
- A missing source file is not a configuration error: the service starts and each attempt fails with `does not exist`, visible in `/v1/stats` as `failing`.
- Listing this service's own `DB_PATH`, or a file inside `BACKUP_DIR`/`RESTORE_DIR`, is refused at start.
