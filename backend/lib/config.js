// Loads optional .env (Node 20.12+) and exposes settings.
try { process.loadEnvFile(); } catch { /* no .env file: use defaults */ }

const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const production = env.NODE_ENV === 'production';

export const config = {
  port: num(env.PORT, 3000),
  host: env.HOST || '127.0.0.1',
  dbPath: env.DB_PATH || './data/kekatumra.db',
  production,
  trustProxy: env.TRUST_PROXY === 'true',
  submitLimitPerHour: num(env.SUBMIT_LIMIT_PER_HOUR, 20),
  publicDir: env.PUBLIC_DIR || './public',
};
