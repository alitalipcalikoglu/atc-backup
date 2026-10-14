# Restore

Every restore checks the stored file against its recorded SHA-256 first; a mismatch restores nothing (`409 CHECKSUM_MISMATCH`).

## To a file (default)

```bash
bk -X POST $BACKUP/v1/backups/bk_m1x2y3z4a1b2c3d4e5f60718/restore -d '{"target":"auth-check.db"}'
```

```json
{ "backup": { "...": "..." }, "live": false, "target": "auth-check.db", "size": 241664, "sha256": "9f2c…", "safetyBackupId": null }
```

The file is written to `RESTORE_DIR/auth-check.db` (0600). Inspect it with `sqlite3`, or point a stopped service's `DB_PATH` at it. An existing file answers `409 TARGET_EXISTS` unless you pass `"overwrite": true`. `target` is a plain file name: no slashes, no leading dot.

## Replacing the live database

Off unless the operator sets `ALLOW_LIVE_RESTORE=true` (otherwise `403 LIVE_RESTORE_DISABLED`).

1. Stop the owning service (`pm2 stop atc-auth`).
2. Restore, naming the source again in `confirm`:

```bash
bk -X POST $BACKUP/v1/backups/bk_m1x2y3z4a1b2c3d4e5f60718/restore -d '{"live":true,"confirm":"atc-auth"}'
```

```json
{ "live": true, "target": "atc-auth", "safetyBackupId": "bk_m1x3a0b1c2d3e4f5a6b7c8d9", "...": "..." }
```

3. Start the service again (`pm2 start atc-auth`).

What happens: a `pre-restore` safety backup of the current file is taken first (if that fails, nothing is restored), the backup is copied next to the live file, checked again, the old `-wal`/`-shm` files are removed and the copy is renamed over the live file in one step.

Pitfalls:
- `confirm` must equal the backup's source id, and `target` cannot be combined with `live` (`400 INVALID_ARGUMENT`).
- Restoring while the service runs leaves it writing to the replaced file. Always stop it first.
- To undo a live restore, restore the safety backup the same way.
