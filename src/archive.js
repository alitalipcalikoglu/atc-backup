import { execFile } from 'node:child_process';
import { basename, dirname } from 'node:path';

/**
 * Tree sources (key files, media blobs, config directories) are stored as one `.tar.gz`. The work is
 * done by the system `tar` (no shell, fixed arguments, names passed as separate arguments), so the
 * service needs no archive library. Archives are created from a relative name and checked by the
 * service's own SHA-256 before anything is extracted, so extraction never meets a foreign archive.
 */
export class Archive {
  static ENV = Object.freeze({ ...process.env, COPYFILE_DISABLE: '1' });

  /** Pack a file or directory into `dest`. @param {string} path @param {string} dest */
  static create(path, dest) {
    // `./name` so a name starting with a dash is never read as an option.
    return Archive.#tar(['-czf', dest, '-C', dirname(path), `./${basename(path)}`]);
  }

  /** Fails when the archive is truncated or corrupt (gzip CRC and tar structure are both read). @param {string} file */
  static async check(file) {
    await Archive.#tar(['-tzf', file]);
  }

  /** Number of entries (files and directories). @param {string} file */
  static async entries(file) {
    const out = await Archive.#tar(['-tzf', file]);
    return out.split('\n').filter(Boolean).length;
  }

  /** Unpack into an existing directory. @param {string} file @param {string} dir */
  static extract(file, dir) {
    return Archive.#tar(['-xzf', file, '-C', dir]);
  }

  /** @param {string[]} args @returns {Promise<string>} */
  static #tar(args) {
    return new Promise((resolve, reject) => {
      execFile('tar', args, { env: Archive.ENV, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`tar failed: ${String(stderr || err.message).trim().split('\n')[0].slice(0, 200)}`));
        else resolve(stdout);
      });
    });
  }
}
