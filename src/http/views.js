/** Response shapes. */
export class Views {
  /** @param {number|null|undefined} t */
  static iso(t) {
    return t === null || t === undefined ? null : new Date(Number(t)).toISOString();
  }

  /** @param {import('../types.js').BackupRow} b */
  static backup(b) {
    return {
      id: b.id, source: b.source, status: b.status, trigger: b.trigger, file: b.file, size: b.size === null ? null : Number(b.size), sha256: b.sha256, pages: b.pages === null ? null : Number(b.pages),
      error: b.error, createdBy: b.created_by, startedAt: Views.iso(b.started_at), finishedAt: Views.iso(b.finished_at),
      durationMs: b.finished_at === null ? null : Number(b.finished_at) - Number(b.started_at),
      verifiedAt: Views.iso(b.verified_at), verified: b.verify_ok === null ? null : b.verify_ok === 1,
      media: b.media_id || b.media_error ? { fileId: b.media_id, error: b.media_error } : null,
    };
  }

  /** @param {Awaited<ReturnType<import('../domain/backup-service.js').BackupService['sources']>>[number]} s */
  static source(s) {
    return { id: s.id, file: s.file, exists: s.exists, size: s.size, running: s.running, lastBackup: s.last ? Views.backup(s.last) : null, lastOkAt: Views.iso(s.lastOkAt), backups: s.okCount, bytes: s.bytes, nextDueAt: Views.iso(s.nextDueAt) };
  }
}
