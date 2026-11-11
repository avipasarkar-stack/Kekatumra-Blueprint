import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { tx } from './lib/db.js';
import { createLimiter } from './lib/rate-limit.js';
import { HttpError, bad, str, phone10, int, bool, obj } from './lib/validate.js';
import {
  sanitizeRecord, validateFamily, checkDuplicates, familyMatch, genderStats, clampCount, searchNorm,
} from './lib/families.js';

const DEFAULT_BODY_LIMIT = 256 * 1024;
const IMPORT_BODY_LIMIT = 10 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
// Tables the admin approval queue may touch. Never build SQL from user input.
const QUEUE_TABLES = { suggestions: 'suggestions', workers: 'workers', ratings: 'ratings' };
const queueTable = (kind) => (Object.hasOwn(QUEUE_TABLES, kind) ? QUEUE_TABLES[kind] : null);

class Reply {
  constructor(status, body, headers = {}) { this.status = status; this.body = body; this.headers = headers; }
}

export function createApp({ db, config }) {
  const publicDir = path.resolve(config.publicDir);
  const nowIso = () => new Date().toISOString();

  const limiters = {
    api: createLimiter({ max: 600, windowMs: 60_000 }),
    submit: createLimiter({ max: config.submitLimitPerHour, windowMs: 60 * 60_000 }),
  };

  // ---------- small helpers ----------
  const audit = (action, target = null, detail = null) =>
    db.prepare('INSERT INTO audit_log(at,action,target,detail) VALUES (?,?,?,?)')
      .run(nowIso(), action, target, detail);

  const clientIp = (req) => {
    if (config.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xff) return xff;
    }
    return req.socket.remoteAddress || 'unknown';
  };

  function securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    // 'unsafe-inline' is needed because index.html still has inline <script>/<style>.
    // Moving them into files lets you tighten this.
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (config.production) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }

  function send(res, status, body, headers = {}) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      ...headers,
    });
    res.end(payload);
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > limit) { reject(new HttpError(413, 'too_large', 'Request body too large.')); return; }
      let size = 0, tooLarge = false;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) tooLarge = true; else chunks.push(c);
      });
      req.on('end', () => (tooLarge
        ? reject(new HttpError(413, 'too_large', 'Request body too large.'))
        : resolve(Buffer.concat(chunks))));
      req.on('error', reject);
    });
  }

  // ---------- routing ----------
  const routes = [];
  const route = (method, pattern, opts, handler) => {
    routes.push({ method, segs: pattern.split('/').filter(Boolean), opts, handler });
  };
  function match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const r of routes) {
      if (r.segs.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        if (r.segs[i].startsWith(':')) {
          try { params[r.segs[i].slice(1)] = decodeURIComponent(parts[i]); } catch { ok = false; break; }
        } else if (r.segs[i] !== parts[i]) { ok = false; break; }
      }
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method) return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }

  // ---------- static files ----------
  async function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'bad_path', 'Bad path.'); }
    if (rel.includes('\0')) throw new HttpError(400, 'bad_path', 'Bad path.');
    if (rel.endsWith('/')) rel += 'index.html';
    let full = path.join(publicDir, path.posix.normalize('/' + rel));
    if (full !== publicDir && !full.startsWith(publicDir + path.sep)) throw new HttpError(403, 'forbidden', 'Forbidden.');
    if (path.basename(full).startsWith('.')) throw new HttpError(404, 'not_found', 'Not found.');
    try {
      const st = await fs.stat(full);
      if (st.isDirectory()) full = path.join(full, 'index.html');
      const data = await fs.readFile(full);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(404, 'not_found', 'Not found.');
    }
  }

  // ---------- main handler ----------
  async function handle(req, res) {
    securityHeaders(res);
    try {
      const url = new URL(req.url, 'http://localhost');
      const ip = clientIp(req);

      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
        return await serveStatic(req, res, url.pathname);
      }

      res.setHeader('Cache-Control', 'no-store');
      const rl = limiters.api.hit(ip);
      if (!rl.ok) throw new HttpError(429, 'rate_limited', 'Too many requests.', { retryAfter: rl.retryAfter });

      const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      if (unsafe && req.headers.origin) {
        let host = null;
        try { host = new URL(req.headers.origin).host; } catch { /* invalid origin */ }
        if (host !== req.headers.host) throw new HttpError(403, 'bad_origin', 'Cross-site requests are not allowed.');
      }

      const m = match(req.method, url.pathname);
      if (!m) throw new HttpError(404, 'not_found', 'No such endpoint.');
      if (m.methodNotAllowed) throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
      const { route: r, params } = m;

      let body;
      if (unsafe) {
        const raw = await readBody(req, r.opts.bodyLimit || DEFAULT_BODY_LIMIT);
        if (raw.length) {
          if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
            throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
          }
          try { body = JSON.parse(raw.toString('utf8')); } catch { throw bad('invalid_json', 'Request body is not valid JSON.'); }
        }
      }

      const result = await r.handler({
        req, res, params, body, ip,
        query: Object.fromEntries(url.searchParams),
      });
      if (result instanceof Reply) return send(res, result.status, result.body, result.headers);
      return send(res, 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) {
        const headers = err.extra?.retryAfter ? { 'Retry-After': String(err.extra.retryAfter) } : {};
        return send(res, err.status, { error: err.code, message: err.message, ...err.extra }, headers);
      }
      console.error(err);
      return send(res, 500, { error: 'server_error', message: 'Something went wrong.' });
    }
  }

  const submitGuard = (name) => (ip) => {
    const r = limiters.submit.hit(`${name}:${ip}`);
    if (!r.ok) throw new HttpError(429, 'rate_limited', 'Too many submissions. Please try again later.', { retryAfter: r.retryAfter });
  };

  // =====================================================================
  // Public endpoints
  // =====================================================================
  route('GET', '/api/health', {}, () => ({ ok: true, time: nowIso() }));

  // ---- suggestions ----
  route('GET', '/api/suggestions', {}, () => {
    const rows = db.prepare("SELECT * FROM suggestions WHERE status='approved' ORDER BY created_at DESC").all();
    return rows.map((x) => ({
      id: x.id, category: x.category, text: x.text, createdAt: x.created_at,
      ...(x.public_name && x.name ? { name: x.name } : {}), // phone is never public
    }));
  });

  const guardSuggest = submitGuard('suggestions');
  route('POST', '/api/suggestions', {}, ({ body, ip }) => {
    guardSuggest(ip);
    const b = obj(body);
    const consent = bool(b.consent);
    const text = str(b.text, { field: 'text', max: 2000, required: true });
    const category = str(b.category, { field: 'category', max: 100, required: true });
    const phone = phone10(b.phone, { field: 'phone' });
    const name = str(b.name, { field: 'name', max: 100 });
    db.prepare(`INSERT INTO suggestions(id,category,text,name,phone,public_name,status,created_at)
                VALUES (?,?,?,?,?,?,'pending',?)`)
      .run(crypto.randomUUID(), category, text, consent ? name : '', consent ? phone : '', consent ? 1 : 0, nowIso());
    return new Reply(201, { ok: true, message: 'सूचना मिळाली. प्रशासकीय मंजुरीनंतर सार्वजनिक होईल.' });
  });

  // ---- workers ----
  const publicWorker = (w) => ({
    id: w.id, name: w.name, skill: w.skill, experience: w.experience, availability: w.availability,
    area: w.area, description: w.description, contactConsent: !!w.contact_consent,
    ...(w.contact_consent ? { phone: w.phone } : {}), // phone only if they agreed to be contacted
    ratingAvg: w.rc ? Math.round(w.ra * 10) / 10 : null,
    ratingCount: w.rc,
  });

  route('GET', '/api/workers', {}, ({ query }) => {
    const q = String(query.search || '').trim().slice(0, 100).toLocaleLowerCase('mr');
    const skill = String(query.skill || '').trim().slice(0, 100);
    const onlyContact = query.contact === '1';
    const rows = db.prepare(
      `SELECT w.*,
         (SELECT COUNT(*) FROM ratings r WHERE r.worker_id = w.id AND r.status='approved') AS rc,
         (SELECT AVG(stars) FROM ratings r WHERE r.worker_id = w.id AND r.status='approved') AS ra
       FROM workers w WHERE w.status='approved' ORDER BY w.created_at DESC`,
    ).all();
    return rows
      .filter((w) => !onlyContact || w.contact_consent)
      .filter((w) => !skill || w.skill.includes(skill))
      .filter((w) => !q || `${w.name} ${w.skill} ${w.area} ${w.description}`.toLocaleLowerCase('mr').includes(q))
      .map(publicWorker);
  });

  const guardWorker = submitGuard('workers');
  route('POST', '/api/workers', {}, ({ body, ip }) => {
    guardWorker(ip);
    const b = obj(body);
    const w = {
      name: str(b.name, { field: 'name', max: 100, required: true }),
      skill: str(b.skill, { field: 'skill', max: 100, required: true }),
      experience: int(b.experience, { field: 'experience', min: 0, max: 80 }),
      availability: str(b.availability, { field: 'availability', max: 100 }),
      area: str(b.area, { field: 'area', max: 100 }) || 'केकत उमरा',
      description: str(b.description, { field: 'description', max: 1000 }),
      phone: phone10(b.phone, { field: 'phone', required: true }),
      consent: bool(b.contactConsent) ? 1 : 0,
    };
    db.prepare(`INSERT INTO workers(id,name,skill,experience,availability,area,description,phone,contact_consent,status,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,'pending',?)`)
      .run(crypto.randomUUID(), w.name, w.skill, w.experience, w.availability, w.area, w.description, w.phone, w.consent, nowIso());
    return new Reply(201, { ok: true, message: 'नोंदणी मिळाली. मंजुरीपूर्वी सार्वजनिक होणार नाही.' });
  });

  // ---- ratings ----
  const guardRating = submitGuard('ratings');
  route('POST', '/api/ratings', {}, ({ body, ip }) => {
    guardRating(ip);
    const b = obj(body);
    const workerId = str(b.workerId, { field: 'workerId', max: 64, required: true });
    const stars = int(b.stars, { field: 'stars', min: 1, max: 5 });
    const feedback = str(b.feedback, { field: 'feedback', max: 1000 });
    const worker = db.prepare("SELECT id FROM workers WHERE id=? AND status='approved'").get(workerId);
    if (!worker) throw new HttpError(404, 'worker_not_found', 'मंजूर कामगार सापडला नाही.');
    db.prepare("INSERT INTO ratings(id,worker_id,stars,feedback,status,created_at) VALUES (?,?,?,?,'pending',?)")
      .run(crypto.randomUUID(), workerId, stars, feedback, nowIso());
    return new Reply(201, { ok: true, message: 'रेटिंग मिळाली. तपासणीनंतरच सरासरीत मोजली जाईल.' });
  });

  // =====================================================================
  // Public approval queue and actions
  // =====================================================================
  route('GET', '/api/admin/pending', {}, () => {
    const q = (t) => db.prepare(`SELECT * FROM ${queueTable(t)} WHERE status='pending' ORDER BY created_at ASC`).all();
    return {
      suggestions: q('suggestions').map((x) => ({
        id: x.id, category: x.category, text: x.text, name: x.name, phone: x.phone,
        publicName: !!x.public_name, createdAt: x.created_at,
      })),
      workers: q('workers').map((x) => ({
        id: x.id, name: x.name, skill: x.skill, experience: x.experience, availability: x.availability,
        area: x.area, description: x.description, phone: x.phone, contactConsent: !!x.contact_consent, createdAt: x.created_at,
      })),
      ratings: q('ratings').map((x) => ({
        id: x.id, workerId: x.worker_id, stars: x.stars, feedback: x.feedback, createdAt: x.created_at,
      })),
    };
  });

  route('POST', '/api/admin/queue/:kind/:id/approve', {}, ({ params }) => {
    const table = queueTable(params.kind);
    if (!table) throw new HttpError(404, 'not_found', 'Unknown item type.');
    const r = db.prepare(`UPDATE ${table} SET status='approved', reviewed_at=? WHERE id=? AND status='pending'`)
      .run(nowIso(), params.id);
    if (!r.changes) throw new HttpError(404, 'not_found', 'No pending item with that id.');
    audit(`approve_${params.kind}`, params.id);
    return { ok: true };
  });

  // "Reject" deletes the item (same as the current "नाकारून हटवा" button). Also removes approved items.
  route('DELETE', '/api/admin/queue/:kind/:id', {}, ({ params }) => {
    const table = queueTable(params.kind);
    if (!table) throw new HttpError(404, 'not_found', 'Unknown item type.');
    const r = db.prepare(`DELETE FROM ${table} WHERE id=?`).run(params.id);
    if (!r.changes) throw new HttpError(404, 'not_found', 'No item with that id.');
    audit(`delete_${params.kind}`, params.id);
    return { ok: true };
  });

  // =====================================================================
  // Public family survey
  // =====================================================================
  const toRecord = (row) => ({
    ...JSON.parse(row.data),
    recordId: row.record_id, createdAt: row.created_at, savedAt: row.updated_at,
  });
  const allRows = () => db.prepare('SELECT * FROM families ORDER BY created_at DESC, rowid DESC').all();

  route('GET', '/api/families', {}, ({ query }) => {
    const q = searchNorm(String(query.q || '').slice(0, 100));
    const records = allRows().map(toRecord);
    if (!q) return records;
    return records.filter((r) => {
      const hay = [r.houseNumber, r.familyHead];
      for (let i = 1; i <= clampCount(r.familyCount); i++) hay.push(r[`member${i}_name`]);
      return hay.some((v) => searchNorm(v).includes(q));
    });
  });

  route('GET', '/api/families/stats', {}, () => genderStats(allRows().map(toRecord)));

  route('GET', '/api/families/export', {}, () => {
    audit('export_families');
    const date = nowIso().slice(0, 10);
    return new Reply(200,
      { backupType: 'keketUmraFamilyRecordsV1', exportedAt: nowIso(), records: allRows().map(toRecord) },
      { 'Content-Disposition': `attachment; filename="keket_umra_survey_backup_${date}.json"` });
  });

  route('GET', '/api/families/:id', {}, ({ params }) => {
    const row = db.prepare('SELECT * FROM families WHERE record_id=?').get(params.id);
    if (!row) throw new HttpError(404, 'not_found', 'Family record not found.');
    return toRecord(row);
  });

  function saveFamily({ body, existingId }) {
    const b = obj(body);
    const input = sanitizeRecord(b.record);
    let previous = null, previousRow = null;
    if (existingId) {
      previousRow = db.prepare('SELECT * FROM families WHERE record_id=?').get(existingId);
      if (!previousRow) throw new HttpError(404, 'not_found', 'Family record not found.');
      if (b.baseSavedAt && b.baseSavedAt !== previousRow.updated_at) {
        throw new HttpError(409, 'conflict', 'ही नोंद दुसऱ्या कोणीतरी बदलली आहे. पुन्हा उघडून तपासा.', { current: toRecord(previousRow) });
      }
      previous = JSON.parse(previousRow.data);
    }
    const data = validateFamily(input, previous);
    const others = allRows().filter((r) => r.record_id !== existingId).map(toRecord);
    const warnings = checkDuplicates(data, others); // throws 409 duplicate_family for a hard duplicate
    const ack = new Set(Array.isArray(b.acknowledge) ? b.acknowledge : []);
    const pending = warnings.filter((w) => !ack.has(w.code));
    if (pending.length) {
      throw new HttpError(409, 'needs_confirmation', 'पुष्टी आवश्यक आहे.', { warnings: pending });
    }
    const now = nowIso();
    const json = JSON.stringify(data);
    if (existingId) {
      db.prepare('UPDATE families SET house_number=?, family_head=?, family_count=?, data=?, updated_at=? WHERE record_id=?')
        .run(data.houseNumber, data.familyHead, clampCount(data.familyCount), json, now, existingId);
      audit('update_family', existingId);
      return toRecord(db.prepare('SELECT * FROM families WHERE record_id=?').get(existingId));
    }
    const id = `KUM-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    db.prepare(`INSERT INTO families(record_id,house_number,family_head,family_count,data,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?)`)
    .run(id, data.houseNumber, data.familyHead, clampCount(data.familyCount), json, now, now);
    audit('create_family', id);
    return toRecord(db.prepare('SELECT * FROM families WHERE record_id=?').get(id));
  }

  route('POST', '/api/families', {}, (ctx) => new Reply(201, saveFamily({ ...ctx, existingId: null })));
  route('PUT', '/api/families/:id', {}, (ctx) => saveFamily({ ...ctx, existingId: ctx.params.id }));

  route('DELETE', '/api/families/:id', {}, ({ params }) => {
    const r = db.prepare('DELETE FROM families WHERE record_id=?').run(params.id);
    if (!r.changes) throw new HttpError(404, 'not_found', 'Family record not found.');
    audit('delete_family', params.id);
    return { ok: true };
  });

  // Additive import, same rules as the current JSON import button. dryRun:true = "JSON बॅकअप तपासा".
  route('POST', '/api/families/import', { bodyLimit: IMPORT_BODY_LIMIT }, ({ body }) => {
    const b = obj(body);
    const dryRun = bool(b.dryRun);
    const incoming = Array.isArray(b.records) ? b.records : null;
    if (!incoming || !incoming.length) throw bad('invalid_backup', 'या JSON फाईलमध्ये वैध कुटुंब नोंदी सापडल्या नाहीत.');
    if (incoming.length > 5000) throw bad('invalid_backup', 'Too many records in one import (max 5000).');

    const valid = incoming.map((raw, i) => {
      if (!raw || typeof raw !== 'object') throw bad('invalid_backup', `Record ${i + 1} is not an object.`);
      const recordId = String(raw.recordId || '').trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(recordId)) throw bad('invalid_backup', `Record ${i + 1}: missing or invalid recordId.`);
      const data = sanitizeRecord(raw);
      if (!data.familyHead || !data.houseNumber) throw bad('invalid_backup', `Record ${i + 1}: घर क्रमांक / कुटुंबप्रमुख रिकामा आहे.`);
      if (!clampCount(data.familyCount)) throw bad('invalid_backup', `Record ${i + 1}: सदस्यसंख्या वैध नाही.`);
      const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : nowIso());
      return { recordId, data, createdAt: iso(raw.createdAt), updatedAt: iso(raw.savedAt) };
    });

    const existing = allRows().map(toRecord);
    const ids = new Set(existing.map((r) => r.recordId));
    const toAdd = [];
    let skipped = 0;
    for (const item of valid) {
      const candidate = { ...item.data, recordId: item.recordId };
      if (ids.has(item.recordId) || toAdd.some((a) => a.recordId === item.recordId) ||
          existing.some((e) => familyMatch(e, candidate)) || toAdd.some((a) => familyMatch({ ...a.data }, candidate))) {
        skipped++;
        continue;
      }
      toAdd.push(item);
    }
    if (!dryRun && toAdd.length) {
      tx(db, () => {
        const ins = db.prepare(`INSERT INTO families(record_id,house_number,family_head,family_count,data,created_at,updated_at)
                                VALUES (?,?,?,?,?,?,?)`);
        for (const a of toAdd) {
          ins.run(a.recordId, a.data.houseNumber, a.data.familyHead, clampCount(a.data.familyCount),
            JSON.stringify(a.data), a.createdAt, a.updatedAt);
        }
      });
      audit('import_families', null, `added=${toAdd.length} skipped=${skipped}`);
    }
    return { dryRun, total: valid.length, toAdd: toAdd.length, skipped, added: dryRun ? 0 : toAdd.length };
  });

  const server = http.createServer(handle);
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}
