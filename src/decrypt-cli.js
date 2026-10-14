import { Cipher } from './crypto/cipher.js';

// Decrypts a stored backup outside the service: `BACKUP_ENCRYPTION_KEY=<64 hex> npm run decrypt -- <encrypted-file> <output-file>`.
const [input, output] = process.argv.slice(2);
const key = process.env.BACKUP_ENCRYPTION_KEY ?? '';
if (!input || !output || !/^[0-9a-fA-F]{64}$/.test(key)) {
  console.error('usage: BACKUP_ENCRYPTION_KEY=<64 hex characters> npm run decrypt -- <encrypted-file> <output-file>');
  process.exit(2);
}
try {
  await Cipher.fromHex(key).decrypt(input, output);
  console.log(`decrypted ${input} -> ${output}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
