import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..', '..');
const publicDir = path.resolve(scriptDir, '..', 'public');
const frontendFiles = ['index.html', 'app.js'];

await fs.mkdir(publicDir, { recursive: true });
for (const name of frontendFiles) {
  const source = path.join(projectRoot, name);
  const destination = path.join(publicDir, name);
  await fs.copyFile(source, destination);
  console.log(`Synced ${name} to backend/public.`);
}
