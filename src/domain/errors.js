/** Domain error with a stable code and the HTTP status the API maps it to. */
export class BackupError extends Error {
  /** @type {Record<string, number>} */
  static STATUS = {
    SOURCE_NOT_FOUND: 404,
    BACKUP_NOT_FOUND: 404,
    SOURCE_MISSING: 409,
    BUSY: 409,
    INVALID_STATE: 409,
    TARGET_EXISTS: 409,
    CHECKSUM_MISMATCH: 409,
    INTEGRITY_FAILED: 409,
    LIVE_RESTORE_DISABLED: 403,
    INVALID_ARGUMENT: 400,
    FORBIDDEN: 403,
    MEDIA_ERROR: 502,
  };

  /**
   * @param {keyof typeof BackupError.STATUS} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
    this.statusCode = BackupError.STATUS[code];
    this.details = details;
  }
}
