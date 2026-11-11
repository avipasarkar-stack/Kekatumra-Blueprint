// Usage: npm run create-admin -- <username> [admin|surveyor]
// Password is prompted (hidden), or read from the ADMIN_PASSWORD environment variable.
import readline from 'node:readline';
import { config } from '../lib/config.js';
import { openDb } from '../lib/db.js';
import { hashPassword, passwordProblem } from '../lib/auth.js';

const username = String(process.argv[2] || '').toLowerCase();
const role = process.argv[3] || 'admin';
if (!/^[a-z0-9._-]{3,32}$/.test(username) || !['admin', 'surveyor'].includes(role)) {
  console.error('Usage: npm run create-admin -- <username> [admin|surveyor]\nUsername: 3-32 letters/digits/. _ -');
  process.exit(1);
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

const password = process.env.ADMIN_PASSWORD || await promptHidden('Password (min 10 characters): ');
const problem = passwordProblem(password);
if (problem) { console.error(problem); process.exit(1); }

const db = openDb(config.dbPath);
try {
  db.prepare('INSERT INTO users(username,password_hash,role,created_at) VALUES (?,?,?,?)')
    .run(username, await hashPassword(password), role, new Date().toISOString());
  console.log(`Created ${role} "${username}".`);
} catch (e) {
  console.error(String(e.message).includes('UNIQUE') ? `User "${username}" already exists.` : e.message);
  process.exitCode = 1;
}
db.close();
