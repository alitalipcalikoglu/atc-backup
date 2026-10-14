# backup examples

Scenario-driven walkthroughs of every feature. Requests to `/v1/*` need `Authorization: Bearer <secret>` from `BACKUP_API_KEYS`. Base URL below is `http://localhost:3017`.

| Example | Shows |
|---|---|
| [Sources and schedule](sources-and-schedule.md) | Configuring sources, the interval, what a source listing says |
| [Running backups](running-backups.md) | Backing up on demand, failures, `BUSY`, browsing and paging |
| [Retention](retention.md) | Count and age limits, safety backups, deleting by hand |
| [Download and verify](download-and-verify.md) | Downloading with the checksum, re-checking a stored backup |
| [Restore](restore.md) | Restoring to a file, overwrite, the guarded live restore |
| [Trees, encryption and restore drills](trees-encryption-drills.md) | Backing up directories and key files, encrypting at rest, proving that a backup restores |
| [Off-host copies in atc-media](media-copies.md) | Uploading each backup to atc-media, failures |
| [API keys, roles and scopes](keys-and-roles.md) | read, admin; keys scoped to sources |
| [Operations](operations.md) | Health, readiness, metrics, stats, PM2, Docker |
| [Events](events.md) | `backup.completed`, `ops.backup.failed`, `ops.backup.stale` through atc-webhook-out |
| [Audit events](audit-events.md) | Which actions are forwarded to the audit service |

```bash
export BACKUP=http://localhost:3017
export ADMIN=<an admin secret>
alias bk='curl -s -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json"'
```
