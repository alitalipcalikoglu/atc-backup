# Events

```bash
WEBHOOK_OUT_URL=http://webhook-out.internal:3009
WEBHOOK_OUT_API_KEY=<a webhook-out key with the publish role>
```

| Event | When | Data |
|---|---|---|
| `backup.completed` | A backup finished and, if configured, was uploaded | `source`, `id`, `trigger`, `size`, `sha256` |
| `ops.backup.failed` | A copy failed, or the upload to atc-media failed | `source`, `id`, `trigger`, `stage` (`backup` or `upload`), `error` |
| `ops.backup.stale` | A source has no successful backup for two intervals; again after each further interval | `source`, `lastOkAt`, `ageSec` |

A subscription on `ops.*` (atc-status uses one for its alert hub) turns the last two into e-mails and alerts. A source that never succeeded counts from the service start.

Events are queued in memory and sent in the background with up to three retries; each carries an idempotency key, so a retry never delivers twice. A restart loses events still queued, and a full queue (500) drops the oldest. Watch `events_publish_total{result="dropped|failed"}` on `/metrics`.

Pitfalls:
- `BACKUP_INTERVAL_MIN=0` (manual only) disables the stale check.
- URL and key must be set together; a wrong key shows up as `failed` in the metrics and a warning in the log.
