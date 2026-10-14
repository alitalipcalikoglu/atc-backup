import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

/**
 * Off-host copies: each successful backup is streamed into atc-media as a private file. atc-media
 * must list the stored types in its ALLOWED_TYPES: `application/vnd.sqlite3` (databases), `application/gzip` (trees) and
 * `application/vnd.atc-backup` (encrypted backups).
 */
export class MediaClient {
  /**
   * @param {import('../types.js').MediaTarget} target
   * @param {typeof fetch} [fetchImpl]
   */
  constructor(target, fetchImpl = fetch) {
    this.target = target;
    this.fetch = fetchImpl;
  }

  /**
   * Never retried: a failed upload leaves nothing behind on the media side.
   * @param {string} path @param {string} name @param {string} contentType @param {AbortSignal} signal
   * @returns {Promise<{ id: string, size: number }>}
   */
  async upload(path, name, contentType, signal) {
    const { size } = await stat(path);
    const res = await this.fetch(`${this.target.url}/v1/files?visibility=private&name=${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${this.target.apiKey}`, 'content-type': contentType, 'content-length': String(size) },
      body: /** @type {any} */ (createReadStream(path)),
      // @ts-ignore -- Node's fetch needs duplex for a streamed request body.
      duplex: 'half',
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.target.timeoutMs)]),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(MediaClient.#message(res.status, text));
    const file = JSON.parse(text).file;
    return { id: String(file.id), size: Number(file.size) };
  }

  /** An already missing file counts as deleted. @param {string} id */
  async delete(id) {
    const res = await this.fetch(`${this.target.url}/v1/files/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${this.target.apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(this.target.timeoutMs),
    });
    if (!res.ok && res.status !== 404) throw new Error(MediaClient.#message(res.status, await res.text().catch(() => '')));
  }

  /** @param {number} status @param {string} text */
  static #message(status, text) {
    try { const j = JSON.parse(text); if (j?.error?.message) return `atc-media: ${j.error.message}`; } catch { /* not JSON */ }
    return `atc-media responded ${status}`;
  }
}
