# Off-host copies in atc-media

```bash
MEDIA_URL=http://media.internal:3003
MEDIA_API_KEY=<a media key>
```

atc-media must accept the types: add `application/vnd.sqlite3` (databases), `application/gzip` (trees) and `application/vnd.atc-backup` (encrypted backups) to its `ALLOWED_TYPES`.

After every successful backup (and its retention run), the file is streamed to atc-media as a private file named like the backup. The backup records the result:

```json
{ "media": { "fileId": "f_01J…", "error": null } }
```

A failed upload does not fail the backup:

```json
{ "status": "ok", "media": { "fileId": null, "error": "atc-media: type application/vnd.sqlite3 is not allowed" } }
```

When retention or a delete removes a backup, its atc-media file is deleted too (best effort; a failure is logged).

Pitfalls:
- Uploads are not retried; the next backup uploads again.
- `/ready` says `"media": "enabled"` only when both variables are set.
