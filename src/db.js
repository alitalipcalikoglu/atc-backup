import { Database as CoreDatabase } from '@atc-web/atc-service-core/db';

/** SQLite connection with schema migrations applied on open. */
export class Database extends CoreDatabase {
  static MIGRATIONS = [
    `
    -- One row per backup attempt. The file lives at BACKUP_DIR/<source>/<file>; failed rows keep no file.
    CREATE TABLE backups (
      id          TEXT PRIMARY KEY,
      source      TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
      trigger     TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'pre-restore')),
      file        TEXT,
      size        INTEGER,
      sha256      TEXT,
      pages       INTEGER,
      error       TEXT,
      created_by  TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      finished_at INTEGER,
      verified_at INTEGER,
      verify_ok   INTEGER,
      media_id    TEXT,
      media_error TEXT
    );
    CREATE INDEX backups_source ON backups (source, started_at DESC);
    CREATE INDEX backups_started ON backups (started_at DESC);
    `,
  ];
}
