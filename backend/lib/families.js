// Server-side port of the family-survey rules that currently live in index.html,
// so they are enforced even if someone bypasses the browser form.
import { bad, HttpError, cleanText } from './validate.js';

export const GENDERS = ['पुरुष', 'महिला', 'इतर'];
export const MAX_MEMBERS = 30;
const RESERVED = new Set(['recordId', 'createdAt', 'savedAt']);
const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;

const norm = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('mr');
const digits = (v) => String(v ?? '').replace(/\D/g, '');
export const clampCount = (v) => Math.max(0, Math.min(MAX_MEMBERS, parseInt(v, 10) || 0));

export function people(rec) {
  const list = [];
  for (let n = 1; n <= clampCount(rec.familyCount); n++) {
    const name = norm(rec[`member${n}_name`]);
    if (name) {
      list.push({
        name,
        dob: String(rec[`member${n}_dob`] || '').trim(),
        mobile: digits(rec[`member${n}_mobile`]),
        index: n,
      });
    }
  }
  return list;
}

// Same name AND (same date of birth OR same mobile), and mobiles must not conflict.
export function samePerson(a, b) {
  if (!a.name || a.name !== b.name) return false;
  if (a.mobile && b.mobile && a.mobile !== b.mobile) return false;
  if (a.dob && b.dob && a.dob === b.dob) return true;
  if (a.mobile && b.mobile && a.mobile === b.mobile) return true;
  return false;
}

/** Turn arbitrary JSON into a flat string map, rejecting anything odd. */
export function sanitizeRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw bad('invalid_record', 'record must be a JSON object.');
  }
  const keys = Object.keys(input);
  if (keys.length > 2000) throw bad('invalid_record', 'record has too many fields.');
  const out = {};
  for (const k of keys) {
    if (RESERVED.has(k)) continue;
    if (!KEY_RE.test(k)) throw bad('invalid_key', `Unsupported field name: ${k.slice(0, 40)}`);
    const v = input[k];
    if (v === null || v === undefined) out[k] = '';
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    else if (typeof v === 'string') {
      if (v.length > 2000) throw bad('too_long', `Field ${k} is too long.`, { field: k });
      out[k] = cleanText(v);
    } else throw bad('invalid_value', `Field ${k} must be text.`, { field: k });
  }
  if (JSON.stringify(out).length > 300_000) throw bad('too_large', 'record is too large.');
  return out;
}

/** Required-field rules from the form. `previous` = stored record when editing. */
export function validateFamily(data, previous) {
  if (!data.houseNumber) throw bad('required', 'कृपया घर क्रमांक भरा.', { field: 'houseNumber' });
  if (!data.familyHead) throw bad('required', 'कृपया कुटुंबप्रमुखाचे नाव भरा.', { field: 'familyHead' });
  const count = clampCount(data.familyCount);
  if (!count) throw bad('required', 'कृपया कुटुंबातील सदस्यसंख्या भरा.', { field: 'familyCount' });
  data.familyCount = String(count);

  for (let i = 1; i <= count; i++) {
    if (!String(data[`member${i}_name`] || '').trim()) {
      throw bad('required', `कृपया सदस्य ${i} चे नाव भरा.`, { field: `member${i}_name` });
    }
    const gender = String(data[`member${i}_gender`] || '').trim();
    const prevGender = String(previous?.[`member${i}_gender`] || '').trim();
    const legacyBlankOk = Boolean(previous) && !prevGender && !gender;
    if (!GENDERS.includes(gender) && !legacyBlankOk) {
      throw bad('invalid_gender', `कृपया सदस्य ${i} साठी लिंग निवडा.`, { field: `member${i}_gender` });
    }
    const mobileKey = `member${i}_mobile`;
    const mobile = String(data[mobileKey] || '').trim();
    const prevMobile = String(previous?.[mobileKey] || '').trim();
    const unchanged = Boolean(previous) && mobile === prevMobile;
    const d = digits(mobile);
    if (mobile && d.length !== 10 && !unchanged) {
      throw bad('invalid_phone', `सदस्य ${i} चा नवीन मोबाईल क्रमांक 10 अंकी असावा.`, { field: mobileKey });
    }
    data[mobileKey] = unchanged ? prevMobile : d;
  }

  const list = people(data);
  for (let a = 0; a < list.length; a++) {
    for (let b = a + 1; b < list.length; b++) {
      if (samePerson(list[a], list[b])) {
        throw bad('duplicate_in_form',
          `सदस्य ${list[a].index} आणि सदस्य ${list[b].index} यांचे नाव, जन्मतारीख / मोबाईल जुळत आहेत. एकाच व्यक्तीची दोनदा नोंद करू नका.`,
          { field: `member${list[b].index}_name` });
      }
    }
  }
  return data;
}

const brief = (r) => ({ recordId: r.recordId, houseNumber: r.houseNumber, familyHead: r.familyHead });

/**
 * Compare `data` with the other stored records.
 * Hard block: same house + same head + a matching member  -> HttpError 409 duplicate_family
 * Warnings (client must resend with acknowledge:[codes]): same house+head only,
 * or a matching person found in a different family.
 */
export function checkDuplicates(data, others) {
  const current = people(data);
  const sameHouseHead = others.filter(
    (o) => norm(o.houseNumber) === norm(data.houseNumber) && norm(o.familyHead) === norm(data.familyHead),
  );
  const dup = sameHouseHead.find((o) => people(o).some((op) => current.some((np) => samePerson(op, np))));
  if (dup) {
    throw new HttpError(409, 'duplicate_family',
      'या घर क्रमांकावर आणि कुटुंबप्रमुखाच्या नावाने आधीची नोंद आहे; सदस्यांची ओळखही जुळते. कृपया त्या कुटुंबाची नोंद अद्ययावत करा.',
      { existing: brief(dup) });
  }
  const warnings = [];
  if (sameHouseHead.length) {
    warnings.push({
      code: 'same_house_head',
      message: 'या घर क्रमांकाची आणि कुटुंबप्रमुखाच्या नावाची नोंद आधीपासून आहे, पण सदस्यांची ओळख जुळत नाही. वेगळे कुटुंब असल्यास पुष्टी करा.',
      existing: brief(sameHouseHead[0]),
    });
  }
  outer: for (const o of others) {
    for (const op of people(o)) {
      for (const np of current) {
        if (samePerson(op, np)) {
          warnings.push({
            code: 'same_person_other_family',
            message: `सदस्य ${np.index} ची जन्मतारीख / मोबाईल दुसऱ्या कुटुंबाच्या नोंदीतही जुळत आहे. वेगळी व्यक्ती असल्याची खात्री असल्यास पुष्टी करा.`,
            memberIndex: np.index,
            existing: brief(o),
          });
          break outer;
        }
      }
    }
  }
  return warnings;
}

/** Same rule the import button uses: same house + head + a matching member. */
export function familyMatch(a, b) {
  return norm(a.houseNumber) === norm(b.houseNumber) &&
    norm(a.familyHead) === norm(b.familyHead) &&
    people(a).some((pa) => people(b).some((pb) => samePerson(pa, pb)));
}

export function genderStats(records) {
  const s = { families: records.length, members: 0, male: 0, female: 0, other: 0, missing: 0 };
  for (const r of records) {
    const count = clampCount(r.familyCount);
    s.members += count;
    for (let i = 1; i <= count; i++) {
      const g = String(r[`member${i}_gender`] || '').trim();
      if (g === 'पुरुष') s.male++;
      else if (g === 'महिला') s.female++;
      else if (g === 'इतर') s.other++;
      else s.missing++;
    }
  }
  return s;
}

export const searchNorm = norm;
