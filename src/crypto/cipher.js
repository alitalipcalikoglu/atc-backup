import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { finished } from 'node:stream/promises';

/**
 * Encryption of stored backups with AES-256-GCM. File layout: `ATCBK1\n` (7 bytes), a random 12-byte IV,
 * the ciphertext, the 16-byte authentication tag. The key is 32 bytes (`BACKUP_ENCRYPTION_KEY`, 64 hex
 * characters). Decryption writes to a temporary file the caller removes; a wrong key or a changed byte
 * fails at the end (the tag) and the caller must not use the output. There is no key derivation or key
 * rotation: a new key applies to new backups, older ones need the key they were written with.
 */
export class Cipher {
  static MAGIC = Buffer.from('ATCBK1\n');
  static IV = 12;
  static TAG = 16;

  /** @param {Buffer} key 32 bytes */
  constructor(key) {
    if (key.length !== 32) throw new Error('the encryption key must be 32 bytes');
    this.key = key;
  }

  /** @param {string} hex 64 hex characters */
  static fromHex(hex) {
    return new Cipher(Buffer.from(hex, 'hex'));
  }

  /** @param {string} src @param {string} dest @returns {Promise<void>} */
  async encrypt(src, dest) {
    const iv = randomBytes(Cipher.IV);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const out = createWriteStream(dest, { mode: 0o600 });
    out.write(Buffer.concat([Cipher.MAGIC, iv]));
    const input = createReadStream(src);
    input.pipe(cipher).pipe(out, { end: false });
    await finished(cipher);
    out.end(cipher.getAuthTag());
    await finished(out);
  }

  /** @param {string} src @param {string} dest @returns {Promise<void>} */
  async decrypt(src, dest) {
    const fh = await open(src, 'r');
    try {
      const { size } = await fh.stat();
      const head = Buffer.alloc(Cipher.MAGIC.length + Cipher.IV);
      if (size < head.length + Cipher.TAG) throw new Error('not an encrypted backup (too short)');
      await fh.read(head, 0, head.length, 0);
      if (!head.subarray(0, Cipher.MAGIC.length).equals(Cipher.MAGIC)) throw new Error('not an encrypted backup (unknown header)');
      const tag = Buffer.alloc(Cipher.TAG);
      await fh.read(tag, 0, Cipher.TAG, size - Cipher.TAG);
      const decipher = createDecipheriv('aes-256-gcm', this.key, head.subarray(Cipher.MAGIC.length));
      decipher.setAuthTag(tag);
      const out = createWriteStream(dest, { mode: 0o600 });
      const input = createReadStream(src, { start: head.length, end: size - Cipher.TAG - 1 });
      input.pipe(decipher).pipe(out);
      await Promise.all([finished(out), finished(decipher)]).catch(() => { throw new Error('decryption failed: wrong key or the file was changed'); });
    } finally {
      await fh.close();
    }
  }
}
