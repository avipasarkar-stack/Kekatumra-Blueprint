// Usage: npm run backup   -> writes ./backups/kekatumra-<timestamp>.db (consistent snapshot, safe while the server runs)
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../lib/config.js';
import { openDb } from '../lib/db.js';

const dir = path.resolve('backups');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `kekatumra-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
const db = openDb(config.dbPath);
db.prepare('VACUUM INTO ?').run(file);
db.close();
fs.chmodSync(file, 0o600);
console.log(`Backup written: ${file}\nThis file contains personal data. Store it securely.`);
