import { config } from './lib/config.js';
import { openDb } from './lib/db.js';
import { createApp } from './app.js';

const db = openDb(config.dbPath);
const server = createApp({ db, config });

server.listen(config.port, config.host, () => {
  console.log(`Kekatumra backend listening on http://${config.host}:${config.port}`);
  const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n;
  if (!admins) console.log('No admin exists yet. Run: npm run create-admin -- <username>');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
