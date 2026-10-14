# Retention

```bash
RETENTION_COUNT=14   # newest successful backups kept per source
RETENTION_DAYS=30    # older successful backups are deleted; 0 = no age limit
```

After every successful backup of a source, its successful backups beyond the newest `RETENTION_COUNT`, and those started more than `RETENTION_DAYS` ago, are deleted with their files (and their atc-media copies). The newest one is always kept, however old. Only the last 50 failed attempts per source are kept.

Safety backups (`trigger: "pre-restore"`, taken before a live restore) are normal backups and count towards retention, but taking one never prunes, so the backup being restored cannot disappear underneath the restore.

Delete one by hand:

```bash
bk -X DELETE $BACKUP/v1/backups/bk_m1x2y3z4a1b2c3d4e5f60718   # 204
```

Pitfalls:
- A running backup cannot be deleted (`409 INVALID_STATE`).
- With `BACKUP_INTERVAL_MIN=0`, retention still runs after each manual backup.
