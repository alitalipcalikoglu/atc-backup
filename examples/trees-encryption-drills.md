# Trees, encryption and restore drills

## Backing up files and directories

`BACKUP_SOURCES` copies live databases. Everything else a service needs to be restored (media blobs, signing keys, configuration) is a **tree**:

```bash
BACKUP_TREES=media-objects=../atc-media/data/objects,auth-keys=../atc-auth/keys,audit-keys=../atc-audit/keys
```

Each tree is packed into one `.tar.gz` by the system `tar` (no shell, fixed arguments), checked by reading it back, checksummed and then handled like any backup: retention, download, verify, media copy. `GET /v1/sources` shows `kind: "tree"`. A tree backup is a full archive each time; a very large directory takes time and space accordingly.

```bash
bk -X POST $BACKUP/v1/sources/auth-keys/backups
bk -X POST $BACKUP/v1/backups/bk_.../restore -d '{"target":"auth-keys-restored"}'   # a directory under RESTORE_DIR
```

A tree is never restored live: put the restored files in place yourself, with the owning service stopped. Backups of signing keys are as sensitive as the keys: enable encryption.

## Encryption at rest

```bash
BACKUP_ENCRYPTION_KEY=$(openssl rand -hex 32)      # keep it OUTSIDE the backup volume
```

New backups are stored AES-256-GCM encrypted (`app-20261014T020000Z-ab12cd34.db.enc`, `"encrypted": true`). Verify, drill and restore decrypt on the fly; a wrong key or a changed byte fails at the authentication tag. Downloads and the media copy are the encrypted file. Outside the service:

```bash
BACKUP_ENCRYPTION_KEY=... npm run decrypt -- app-....db.enc app.db
```

Pitfalls:
- Without the key an encrypted backup is unreadable. The stack does not generate a key for you for that reason: store it in your secret manager first.
- Older, unencrypted backups stay as they are; a new key does not re-encrypt them, and there is no key rotation (old files need their old key).
- The key protects files at rest and in off-host copies; someone with the key and the backup volume reads everything.

## Restore drills

A backup that has never been restored is a hope. `DRILL_INTERVAL_HOURS` (default 24) restores the newest backup of each source into a scratch directory under `RESTORE_DIR`, as a real restore would (decrypt, copy, open), reads it back and removes the scratch copy:

```bash
bk -X POST $BACKUP/v1/backups/bk_.../drill
```

```json
{ "ok": true, "detail": { "integrity": "ok", "tables": { "users": 1204, "sessions": 311 }, "ms": 84 }, "backup": { "drill": { "at": "2026-10-14T02:10:00.000Z", "ok": true, "detail": { "...": "..." } } } }
```

For a tree, `detail` holds `entries`. A failed drill records the error, publishes `ops.backup.failed` (stage `drill`) and shows in `GET /v1/stats` as `drillFailing`; `/metrics` has `backup_last_drill_ok{source}`. A drill proves the file opens and holds data; it does not start the owning service on it.
