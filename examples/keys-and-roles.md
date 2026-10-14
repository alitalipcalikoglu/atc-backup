# API keys, roles and scopes

```bash
BACKUP_API_KEYS=atc-console:<64 hex>:admin,dashboards:<64 hex>:read,auth-team:<64 hex>:admin:atc-auth
```

| Role | Can |
|---|---|
| `read` | List sources and backups, one backup, stats, metrics |
| `admin` | Everything: run, download, verify, restore, delete |

The role is required. A fourth field scopes a key to sources (`atc-auth+atc-content`); every source named must be in `BACKUP_SOURCES`.

A scoped key gets `403` when it names another source (run, `?source=` filter) and `404` for backups of other sources, so their ids do not leak. Lists, stats and metrics only contain its sources.

```bash
curl -s -H "Authorization: Bearer $AUTH_TEAM" -X POST $BACKUP/v1/sources/atc-content/backups   # 403 FORBIDDEN
```
