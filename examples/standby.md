# Warm standby

A second host keeps a copy of each service's SQLite file, a few minutes behind the primary, so a lost primary is replaced by starting the standby rather than rebuilding from scratch. The primary's atc-backup takes the snapshots; the standby pulls them with `npm run standby`.

## Pull on the standby

On the standby host, with the services **stopped** (they must not run while their file is replaced):

```bash
export PRIMARY_BACKUP_URL=https://backup.primary.internal:3017
export PRIMARY_BACKUP_API_KEY=<an admin key of the primary, scoped to the sources it copies>
export BACKUP_ENCRYPTION_KEY=<the primary's key, only when backups are encrypted>

npm run standby -- atc-auth /srv/atc-auth/data/auth.db
# atc-auth: pulled backup bk_mv8q2b1k9c4e7a0d3f6b2e81 (sha256 9f2c…) -> /srv/atc-auth/data/auth.db
npm run standby -- atc-auth /srv/atc-auth/data/auth.db
# atc-auth: already current backup bk_mv8q2b1k9c4e7a0d3f6b2e81 (…)
```

What it does, per run:

1. Asks the primary for the newest successful backup of the source (`GET /v1/backups?source=…&status=ok&limit=1`).
2. Skips everything when `<target>.standby.json` already names that backup.
3. Downloads it (abandoned after 30 minutes, or as soon as it grows past the size the primary recorded), compares the SHA-256 with the one the primary recorded, decrypts it when needed, and runs `PRAGMA integrity_check`.
4. Removes a stale `-wal`/`-shm`, renames the file into place, and writes `<target>.standby.json` (backup id, checksum, times).

Any failed step leaves the previous copy untouched and exits with status 1. Run it from cron every backup interval (`BACKUP_INTERVAL_MIN` on the primary); the standby is then at most one interval plus the pull behind (the RPO).

## Promote

1. Make sure the primary is really down, or stop it: two hosts writing the same service's data must never happen.
2. Run `npm run standby` once more per source, to get the newest snapshot.
3. Start the services on the standby (`pm2 start ecosystem.config.cjs` in each folder).
4. The gateway lists both hosts as upstreams; its active health checks see the standby pass `/health` within `UPSTREAM_HEALTH_INTERVAL_MS` and send traffic there. Without the gateway, point DNS or the reverse proxy at the standby.

When the old primary comes back, keep it stopped. Rebuild it as the new standby (pull from the promoted host) before you switch back.

## Pitfalls

- Directory sources (a source path that is a folder, such as atc-media's local `files` or atc-auth's `keys`) are `tar.gz` trees; the puller refuses them. Download them (`GET /v1/backups/:id/download`) and unpack them by hand, or keep them on shared storage (atc-media with S3 storage needs neither).
- Writes made after the last snapshot are lost on promotion; shorten `BACKUP_INTERVAL_MIN` to shrink that window.
- The standby's `.env` must carry the same secrets as the primary (API keys, `TOTP`/sealing keys, JWT keys), or clients and stored secrets stop working after promotion.
