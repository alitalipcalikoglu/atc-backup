# Download and verify

Download (admin only, audited):

```bash
curl -s -H "Authorization: Bearer $ADMIN" -D headers.txt -o auth.db $BACKUP/v1/backups/bk_m1x2y3z4a1b2c3d4e5f60718/download
grep -i x-checksum-sha256 headers.txt
shasum -a 256 auth.db
sqlite3 auth.db 'PRAGMA integrity_check'
```

The response is `application/vnd.sqlite3` as an attachment with `X-Checksum-SHA256`; the file is a complete database with no sidecar files.

Re-check a stored backup (for example after moving disks):

```bash
bk -X POST $BACKUP/v1/backups/bk_m1x2y3z4a1b2c3d4e5f60718/verify
```

```json
{ "backup": { "verified": true, "verifiedAt": "2026-10-14T11:00:00.000Z", "...": "..." }, "checksumOk": true, "integrity": "ok" }
```

A changed or damaged file answers `checksumOk: false` and/or an `integrity` message, and the backup is marked `verified: false`. Such a backup is never restored.

Pitfalls:
- Failed backups have no file: download and verify answer `409 INVALID_STATE`.
- A downloaded file holds everything the source service stores (password hashes, keys). Treat it like the live database.
