# Operations

```bash
curl -s $BACKUP/health   # {"status":"ok"}
curl -s $BACKUP/ready    # {"status":"ok","sources":15,"schedule":"every 360 min","media":"disabled","liveRestore":"disabled"}
bk $BACKUP/v1/stats
```

```json
{ "sources": 15, "backups": 120, "bytes": 31457280, "failing": [], "stale": ["atc-geo"], "running": [],
  "intervalMin": 360, "retentionCount": 14, "retentionDays": 30, "media": false, "liveRestore": false }
```

`failing`: the newest attempt failed. `stale`: no good backup within two intervals. Alert on either.

Metrics (`read` key): `backup_last_success_timestamp_seconds{source}`, `backup_last_ok{source}`, `backup_stored{source}`, `backup_stored_bytes{source}`. A useful alert: `time() - backup_last_success_timestamp_seconds > 2 * 6 * 3600`.

PM2: `pm2 start ecosystem.config.cjs`. On `SIGTERM` the running backup finishes before exit (force exit 30 s).

Docker: mount every source volume read-only and list it.

```bash
docker run -p 3017:3017 --env-file .env -v atc-backup-data:/data \
  -v atc-auth-data:/sources/atc-auth:ro -e BACKUP_SOURCES=atc-auth=/sources/atc-auth/auth.db atc-backup
```

Pitfalls:
- A read-only mount works for backups (SQLite reads the WAL through the existing `-shm`), but a live restore needs write access.
- Keep `BACKUP_DIR` on a different disk than the sources, or enable the atc-media copies.
