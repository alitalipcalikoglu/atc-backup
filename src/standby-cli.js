import { StandbyPull } from './standby.js';

// Warm standby pull, run on the standby host with its service stopped:
// `PRIMARY_BACKUP_URL=https://… PRIMARY_BACKUP_API_KEY=… [BACKUP_ENCRYPTION_KEY=…] npm run standby -- <source> <target-file>`
const [source, target] = process.argv.slice(2);
const url = process.env.PRIMARY_BACKUP_URL ?? '';
const apiKey = process.env.PRIMARY_BACKUP_API_KEY ?? '';
const encryptionKey = process.env.BACKUP_ENCRYPTION_KEY ?? '';
if (!source || !target || !/^https?:\/\//.test(url) || apiKey.length < 16 || (encryptionKey && !/^[0-9a-fA-F]{64}$/.test(encryptionKey))) {
  console.error('usage: PRIMARY_BACKUP_URL=<url> PRIMARY_BACKUP_API_KEY=<admin key> [BACKUP_ENCRYPTION_KEY=<64 hex>] npm run standby -- <source> <target-file>');
  process.exit(2);
}
try {
  const r = await new StandbyPull({ url, apiKey, encryptionKey }).pull(source, target);
  console.log(`${source}: ${r.status === 'updated' ? 'pulled' : 'already current'} backup ${r.backupId} (sha256 ${r.sha256}) -> ${target}`);
} catch (err) {
  console.error(`${source}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
