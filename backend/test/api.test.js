import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../lib/db.js';
import { createApp } from '../app.js';

// ---------- test harness ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kum-'));
const publicDir = path.join(tmp, 'public');
fs.mkdirSync(publicDir);
fs.writeFileSync(path.join(publicDir, 'index.html'), '<h1>hello</h1>');
fs.writeFileSync(path.join(publicDir, '.secret'), 'nope');
fs.writeFileSync(path.join(tmp, 'outside.txt'), 'outside the public folder');

async function startApp(overrides = {}) {
  const db = openDb(':memory:');
  const config = {
    publicDir, trustProxy: false, submitLimitPerHour: 50, ...overrides,
  };
  const server = createApp({ db, config });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  function request(method, url, { body, headers = {}, raw } = {}) {
    return new Promise((resolve, reject) => {
      const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
      const req = http.request({
        host: '127.0.0.1', port, path: url, method,
        headers: {
          ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* not json */ }
          resolve({ status: res.statusCode, headers: res.headers, json, text: data });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
  const close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); db.close(); });
  return { db, port, request, close };
}

const family = (house, head, members) => {
  const r = { houseNumber: house, familyHead: head, familyCount: String(members.length) };
  members.forEach((m, i) => {
    r[`member${i + 1}_name`] = m.name;
    r[`member${i + 1}_gender`] = m.gender ?? 'पुरुष';
    r[`member${i + 1}_dob`] = m.dob ?? '';
    r[`member${i + 1}_mobile`] = m.mobile ?? '';
  });
  return r;
};

test('legacy account data is removed without losing family records', () => {
  const file = path.join(tmp, 'legacy.db');
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id));
    CREATE TABLE families (
      record_id TEXT PRIMARY KEY, house_number TEXT NOT NULL, family_head TEXT NOT NULL,
      family_count INTEGER NOT NULL, data TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY, at TEXT NOT NULL, user_id INTEGER, username TEXT,
      action TEXT NOT NULL, target TEXT, detail TEXT
    );
    INSERT INTO users VALUES (1, 'legacy', 'old-hash');
    INSERT INTO sessions VALUES ('old-token', 1);
    INSERT INTO families VALUES ('F1', '1', 'कुटुंब', 1, '{}', 1, '2024-01-01', '2024-01-01');
    INSERT INTO audit_log VALUES (1, '2024-01-01', 1, 'legacy', 'old_action', NULL, NULL);
  `);
  legacy.close();

  const db = openDb(file);
  const accounts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','sessions')").all();
  assert.deepEqual(accounts, []);
  assert.equal(db.prepare('SELECT record_id FROM families').get().record_id, 'F1');
  assert.equal(db.prepare('SELECT username FROM audit_log').get().username, null);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

// ---------- public data + approval flow ----------
describe('approval flow', () => {
  let t;
  before(async () => {
    t = await startApp();
  });
  after(() => t.close());

  test('health and security headers', async () => {
    const r = await t.request('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  test('suggestion stays hidden until approved; phone never public', async () => {
    const post = await t.request('POST', '/api/suggestions', {
      body: { category: 'रस्ते', text: 'गावात रस्ता दुरुस्त करा', consent: true, name: 'राम', phone: '9876543210' },
    });
    assert.equal(post.status, 201);
    assert.deepEqual((await t.request('GET', '/api/suggestions')).json, []);

    const pending = await t.request('GET', '/api/admin/pending');
    assert.equal(pending.json.suggestions.length, 1);
    assert.equal(pending.json.suggestions[0].phone, '9876543210');

    const id = pending.json.suggestions[0].id;
    assert.equal((await t.request('POST', `/api/admin/queue/suggestions/${id}/approve`)).status, 200);
    const pub = (await t.request('GET', '/api/suggestions')).json;
    assert.equal(pub.length, 1);
    assert.equal(pub[0].name, 'राम');
    assert.equal(pub[0].phone, undefined);
  });

  test('suggestion without consent hides the name', async () => {
    await t.request('POST', '/api/suggestions', { body: { category: 'पाणी', text: 'नळ योजना', consent: false, name: 'सीता', phone: '9876543210' } });
    const id = (await t.request('GET', '/api/admin/pending')).json.suggestions.at(-1).id;
    await t.request('POST', `/api/admin/queue/suggestions/${id}/approve`);
    const pub = (await t.request('GET', '/api/suggestions')).json;
    assert.ok(pub.every((s) => s.name !== 'सीता'));
  });

  test('bad input is rejected', async () => {
    const r1 = await t.request('POST', '/api/suggestions', { body: { category: 'x', text: '   ' } });
    assert.equal(r1.status, 400);
    const r2 = await t.request('POST', '/api/workers', {
      body: { name: 'अ', skill: 'सुतार', experience: 3, phone: '123' },
    });
    assert.equal(r2.status, 400);
    assert.equal(r2.json.error, 'invalid_phone');
    const r3 = await t.request('POST', '/api/workers', {
      body: { name: 'अ', skill: 'सुतार', experience: -1, phone: '9876543210' },
    });
    assert.equal(r3.status, 400);
  });

  test('worker + rating lifecycle; phone only with consent', async () => {
    const mk = (name, consent) => t.request('POST', '/api/workers', {
      body: { name, skill: 'सुतार', experience: 5, availability: 'रोज', area: 'केकत उमरा', description: 'फर्निचर', phone: '9876543210', contactConsent: consent },
    });
    assert.equal((await mk('सुतार एक', true)).status, 201);
    assert.equal((await mk('सुतार दोन', false)).status, 201);
    assert.deepEqual((await t.request('GET', '/api/workers')).json, []); // none approved yet

    const pend = (await t.request('GET', '/api/admin/pending')).json.workers;
    for (const w of pend) await t.request('POST', `/api/admin/queue/workers/${w.id}/approve`);

    const all = (await t.request('GET', '/api/workers')).json;
    assert.equal(all.length, 2);
    const consenting = all.find((w) => w.name === 'सुतार एक');
    const hidden = all.find((w) => w.name === 'सुतार दोन');
    assert.equal(consenting.phone, '9876543210');
    assert.equal(hidden.phone, undefined);
    assert.equal((await t.request('GET', '/api/workers?contact=1')).json.length, 1);
    assert.equal((await t.request('GET', '/api/workers?search=' + encodeURIComponent('दोन'))).json.length, 1);

    // ratings: unknown worker rejected, pending rating not counted, approved rating counted
    assert.equal((await t.request('POST', '/api/ratings', { body: { workerId: 'nope', stars: 5 } })).status, 404);
    assert.equal((await t.request('POST', '/api/ratings', { body: { workerId: consenting.id, stars: 6 } })).status, 400);
    assert.equal((await t.request('POST', '/api/ratings', { body: { workerId: consenting.id, stars: 4, feedback: 'छान' } })).status, 201);
    assert.equal((await t.request('POST', '/api/ratings', { body: { workerId: consenting.id, stars: 5 } })).status, 201);
    let w1 = (await t.request('GET', '/api/workers')).json.find((w) => w.id === consenting.id);
    assert.equal(w1.ratingCount, 0);
    assert.equal(w1.ratingAvg, null);

    const ratings = (await t.request('GET', '/api/admin/pending')).json.ratings;
    assert.equal(ratings.length, 2);
    for (const r of ratings) await t.request('POST', `/api/admin/queue/ratings/${r.id}/approve`);
    w1 = (await t.request('GET', '/api/workers')).json.find((w) => w.id === consenting.id);
    assert.equal(w1.ratingCount, 2);
    assert.equal(w1.ratingAvg, 4.5);
  });

  test('reject deletes the item; unknown kinds are 404 (no SQL from user input)', async () => {
    await t.request('POST', '/api/suggestions', { body: { category: 'a', text: 'to reject' } });
    const id = (await t.request('GET', '/api/admin/pending')).json.suggestions[0].id;
    assert.equal((await t.request('DELETE', `/api/admin/queue/suggestions/${id}`)).status, 200);
    assert.equal((await t.request('GET', '/api/admin/pending')).json.suggestions.length, 0);
    assert.equal((await t.request('DELETE', '/api/admin/queue/constructor/x')).status, 404);
    assert.equal((await t.request('POST', '/api/admin/queue/users;drop/x/approve')).status, 404);
  });

  test('login endpoints do not exist; admin actions are public', async () => {
    assert.equal((await t.request('POST', '/api/auth/login', { body: {} })).status, 404);
    assert.equal((await t.request('GET', '/api/auth/me')).status, 404);
    assert.equal((await t.request('POST', '/api/auth/logout', { body: {} })).status, 404);
    const actions = t.db.prepare('SELECT action FROM audit_log').all().map((entry) => entry.action);
    assert.ok(actions.includes('approve_suggestions'));
  });
});

// ---------- public API validation ----------
describe('public API validation', () => {
  let t;
  before(async () => {
    t = await startApp();
  });
  after(() => t.close());

  test('family and management endpoints work without a session', async () => {
    assert.equal((await t.request('GET', '/api/families')).status, 200);
    assert.equal((await t.request('GET', '/api/families/stats')).status, 200);
    assert.equal((await t.request('GET', '/api/admin/pending')).status, 200);
    assert.equal((await t.request('GET', '/api/families/export')).status, 200);
    assert.equal((await t.request('POST', '/api/auth/login', { body: {} })).status, 404);
  });

  test('CSRF protections: cross-origin and non-JSON requests are refused', async () => {
    const cross = await t.request('POST', '/api/suggestions', {
      body: { category: 'a', text: 'b' }, headers: { Origin: 'https://evil.example' },
    });
    assert.equal(cross.status, 403);
    const form = await t.request('POST', '/api/suggestions', {
      raw: 'category=a&text=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(form.status, 415);
    const sameOrigin = await t.request('POST', '/api/suggestions', {
      body: { category: 'a', text: 'b' }, headers: { Origin: `http://127.0.0.1:${t.port}` },
    });
    assert.equal(sameOrigin.status, 201); // the site's own origin is allowed
    const garbage = await t.request('POST', '/api/suggestions', {
      body: { category: 'a', text: 'b' }, headers: { Origin: 'not a url' },
    });
    assert.equal(garbage.status, 403);
  });

  test('malformed and oversized bodies', async () => {
    assert.equal((await t.request('POST', '/api/suggestions', { raw: '{not json' })).status, 400);
    const big = JSON.stringify({ category: 'a', text: 'x'.repeat(300_000) });
    assert.equal((await t.request('POST', '/api/suggestions', { raw: big })).status, 413);
    assert.equal((await t.request('GET', '/api/nothing-here')).status, 404);
    assert.equal((await t.request('DELETE', '/api/health')).status, 405);
  });
});

describe('public rate limiting', () => {
  test('public submissions are rate limited per IP', async () => {
    const t = await startApp({ submitLimitPerHour: 3 });
    const codes = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await t.request('POST', '/api/suggestions', { body: { category: 'a', text: `t${i}` } })).status);
    }
    assert.deepEqual(codes, [201, 201, 201, 429, 429]);
    await t.close();
  });
});

// ---------- family survey ----------
describe('family survey', () => {
  let t;
  before(async () => {
    t = await startApp();
  });
  after(() => t.close());

  const create = (record, extra = {}) => t.request('POST', '/api/families', { body: { record, ...extra } });

  test('creates a record and returns the stored shape', async () => {
    const res = await create(family('12', 'रामराव पाटील', [
      { name: 'रामराव पाटील', dob: '1970-01-01', mobile: '98765 43210' },
      { name: 'सुनीता पाटील', gender: 'महिला', dob: '1975-05-05' },
    ]));
    assert.equal(res.status, 201);
    assert.match(res.json.recordId, /^KUM-/);
    assert.equal(res.json.member1_mobile, '9876543210'); // normalised to digits
    assert.ok(res.json.createdAt && res.json.savedAt);
    const list = await t.request('GET', '/api/families');
    assert.equal(list.json.length, 1);
    assert.equal((await t.request('GET', `/api/families/${res.json.recordId}`)).status, 200);
  });

  test('required-field rules from the form are enforced on the server', async () => {
    const cases = [
      [{ ...family('', 'क', [{ name: 'क' }]) }, 'houseNumber'],
      [{ ...family('1', '', [{ name: 'क' }]) }, 'familyHead'],
      [{ houseNumber: '1', familyHead: 'क', familyCount: '0' }, 'familyCount'],
      [family('1', 'क', [{ name: '' }]), 'member1_name'],
      [family('1', 'क', [{ name: 'क', gender: '' }]), 'member1_gender'],
      [family('1', 'क', [{ name: 'क', mobile: '12345' }]), 'member1_mobile'],
    ];
    for (const [rec, field_] of cases) {
      const r = await create(rec);
      assert.equal(r.status, 400, field_);
      assert.equal(r.json.field, field_);
    }
  });

  test('rejects unsafe field names and non-text values', async () => {
    assert.equal((await create({ ...family('7', 'ग', [{ name: 'ग' }]), '__proto__': 'x', 'bad key': 'y' })).status, 400);
    assert.equal((await create({ ...family('7', 'ग', [{ name: 'ग' }]), extra: { nested: true } })).status, 400);
  });

  test('same person twice in one form is rejected', async () => {
    const r = await create(family('20', 'अ', [
      { name: 'अमित', dob: '1990-01-01' }, { name: 'अमित', dob: '1990-01-01' },
    ]));
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'duplicate_in_form');
  });

  test('hard duplicate (same house + head + matching member) is blocked', async () => {
    const r = await create(family('12', 'रामराव पाटील', [{ name: 'रामराव पाटील', dob: '1970-01-01' }]));
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'duplicate_family');
    assert.equal(r.json.existing.houseNumber, '12');
  });

  test('soft duplicates need acknowledgement', async () => {
    // same house + head, different people
    const rec = family('12', 'रामराव पाटील', [{ name: 'वेगळा माणूस', dob: '1960-02-02' }]);
    const first = await create(rec);
    assert.equal(first.status, 409);
    assert.equal(first.json.error, 'needs_confirmation');
    assert.equal(first.json.warnings[0].code, 'same_house_head');
    assert.equal((await create(rec, { acknowledge: ['same_house_head'] })).status, 201);

    // same person in a different family
    const rec2 = family('99', 'दुसरा', [{ name: 'सुनीता पाटील', gender: 'महिला', dob: '1975-05-05' }]);
    const w = await create(rec2);
    assert.equal(w.status, 409);
    assert.equal(w.json.warnings[0].code, 'same_person_other_family');
    assert.equal((await create(rec2, { acknowledge: ['same_person_other_family'] })).status, 201);
  });

  test('update, edit conflict detection, stats, and legacy blank gender on edit', async () => {
    const c = await create(family('30', 'ब', [{ name: 'ब एक' }, { name: 'ब दोन', gender: 'महिला' }]));
    assert.equal(c.status, 201);
    const id = c.json.recordId;

    const edited = { ...family('30', 'ब', [{ name: 'ब एक (बदल)' }, { name: 'ब दोन', gender: 'महिला' }]) };
    const up = await t.request('PUT', `/api/families/${id}`, { body: { record: edited, baseSavedAt: c.json.savedAt } });
    assert.equal(up.status, 200);
    assert.equal(up.json.member1_name, 'ब एक (बदल)');
    assert.equal(up.json.createdAt, c.json.createdAt);

    const stale = await t.request('PUT', `/api/families/${id}`, { body: { record: edited, baseSavedAt: c.json.savedAt } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error, 'conflict');

    const stats = (await t.request('GET', '/api/families/stats')).json;
    assert.ok(stats.families >= 3);
    assert.equal(stats.members, stats.male + stats.female + stats.other + stats.missing);

    const search = (await t.request('GET', '/api/families?q=' + encodeURIComponent('सुनीता'))).json;
    assert.ok(search.length >= 1);

    // an old record with a blank gender can be edited without being forced to fill it in
    t.db.prepare(`INSERT INTO families(record_id,house_number,family_head,family_count,data,created_at,updated_at)
                  VALUES ('OLD-1','50','जुना',1,?,?,?)`)
      .run(JSON.stringify({ houseNumber: '50', familyHead: 'जुना', familyCount: '1', member1_name: 'जुना माणूस', member1_gender: '' }),
        '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
    const legacy = await t.request('PUT', '/api/families/OLD-1', {
      body: { record: { houseNumber: '50', familyHead: 'जुना', familyCount: '1', member1_name: 'जुना माणूस', member1_gender: '', village: 'x' } },
    });
    assert.equal(legacy.status, 200);
  });

  test('public delete, export + import round trip is additive', async () => {
    const before = (await t.request('GET', '/api/families')).json.length;
    const exp = await t.request('GET', '/api/families/export');
    assert.equal(exp.status, 200);
    assert.match(exp.headers['content-disposition'], /attachment/);
    assert.equal(exp.json.backupType, 'keketUmraFamilyRecordsV1');
    assert.equal(exp.json.records.length, before);

    // importing the same backup again adds nothing
    const again = await t.request('POST', '/api/families/import', { body: { records: exp.json.records } });
    assert.equal(again.json.added, 0);
    assert.equal(again.json.skipped, before);

    // a new record is added; dryRun reports without writing
    const fresh = { ...family('777', 'नवीन', [{ name: 'नवीन व्यक्ती', dob: '2000-01-01' }]), recordId: 'KUM-import-1' };
    const dry = await t.request('POST', '/api/families/import', { body: { records: [fresh], dryRun: true } });
    assert.deepEqual([dry.json.toAdd, dry.json.added], [1, 0]);
    assert.equal((await t.request('GET', '/api/families')).json.length, before);
    const real = await t.request('POST', '/api/families/import', { body: { records: [fresh] } });
    assert.equal(real.json.added, 1);
    assert.equal((await t.request('GET', '/api/families')).json.length, before + 1);

    // a broken record stops the whole import
    const broken = await t.request('POST', '/api/families/import', { body: { records: [fresh, { recordId: 'x' }] } });
    assert.equal(broken.status, 400);

    assert.equal((await t.request('DELETE', '/api/families/KUM-import-1')).status, 200);
    assert.equal((await t.request('GET', '/api/families/KUM-import-1')).status, 404);
  });
});

// ---------- static files ----------
describe('static files', () => {
  let t;
  before(async () => { t = await startApp(); });
  after(() => t.close());

  test('serves index.html and blocks traversal and dotfiles', async () => {
    const home = await t.request('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.text, /hello/);
    assert.equal((await t.request('GET', '/index.html')).status, 200);
    assert.equal((await t.request('GET', '/.secret')).status, 404);
    for (const p of ['/../outside.txt', '/%2e%2e/outside.txt', '/..%2foutside.txt', '/%00']) {
      const r = await t.request('GET', p);
      assert.ok(r.status >= 400 && !r.text.includes('outside the public folder'), `${p} -> ${r.status}`);
    }
    assert.equal((await t.request('POST', '/index.html', { body: {} })).status, 405);
  });
});
