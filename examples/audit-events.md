# Audit events

With `AUDIT_URL` and `AUDIT_API_KEY` set, every write and every download is forwarded, with outcome `success`, or `denied` on 403:

| Action | Target | Meta |
|---|---|---|
| `atc-backup.backup.create` | backup | `source`, `status` (`ok` or `failed`) |
| `atc-backup.backup.download` | backup | `source` |
| `atc-backup.backup.verify` | backup | `checksumOk`, `integrity` |
| `atc-backup.backup.restore` | backup | `live`, `target`, `safetyBackupId` |
| `atc-backup.backup.delete` | backup | `source` |

The actor is the API key id. Scheduled backups and retention deletes are not audited (no caller); they are visible in the backup list with `createdBy: "scheduler"`. Reads are not audited.
