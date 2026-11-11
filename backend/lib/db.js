import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Family survey: the form is a flat map of fields (member1_name, member2_dob ...),
-- so the full record is kept as JSON and the searchable fields are also real columns.
CREATE TABLE IF NOT EXISTS families (
  record_id TEXT PRIMARY KEY,
  house_number TEXT NOT NULL,
  family_head TEXT NOT NULL,
  family_count INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  text TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  public_name INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved')),
  created_at TEXT NOT NULL,
  reviewed_by INTEGER,
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  skill TEXT NOT NULL,
  experience INTEGER NOT NULL DEFAULT 0,
  availability TEXT NOT NULL DEFAULT '',
  area TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL,
  contact_consent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved')),
  created_at TEXT NOT NULL,
  reviewed_by INTEGER,
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS ratings (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  feedback TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved')),
  created_at TEXT NOT NULL,
  reviewed_by INTEGER,
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status);
CREATE INDEX IF NOT EXISTS idx_ratings_worker ON ratings(worker_id, status);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const familyColumns = db.prepare('PRAGMA table_info(families)').all().map((column) => column.name);
  if (familyColumns.includes('created_by')) {
    db.exec(`
      CREATE TABLE families_public (
        record_id TEXT PRIMARY KEY,
        house_number TEXT NOT NULL,
        family_head TEXT NOT NULL,
        family_count INTEGER NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO families_public(record_id,house_number,family_head,family_count,data,created_at,updated_at)
        SELECT record_id,house_number,family_head,family_count,data,created_at,updated_at FROM families ORDER BY rowid;
      DROP TABLE families;
      ALTER TABLE families_public RENAME TO families;
    `);
  }
  db.exec('DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS users;');
  const auditColumns = db.prepare('PRAGMA table_info(audit_log)').all().map((column) => column.name);
  if (auditColumns.includes('username')) {
    db.exec('UPDATE audit_log SET username=NULL, user_id=NULL');
  }
  return db;
}

/** Run fn inside a transaction; rolls back if it throws. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
