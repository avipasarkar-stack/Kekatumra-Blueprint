export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const bad = (code, message, extra) => new HttpError(400, code, message, extra);

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function cleanText(s) {
  return s.replace(CONTROL_CHARS, '').trim();
}

export function str(v, { field, max = 200, required = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw bad('invalid_field', `${field} must be text.`, { field });
  const s = cleanText(v);
  if (required && !s) throw bad('required', `${field} is required.`, { field });
  if (s.length > max) throw bad('too_long', `${field} must be at most ${max} characters.`, { field });
  return s;
}

export function phone10(v, { field = 'phone', required = false } = {}) {
  const s = str(v, { field, max: 20, required });
  if (!s) return '';
  if (!/^\d{10}$/.test(s)) throw bad('invalid_phone', 'मोबाईल क्रमांक १० अंकी असावा.', { field });
  return s;
}

export function int(v, { field, min, max, required = true }) {
  if ((v === undefined || v === null || v === '') && !required) return null;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw bad('invalid_number', `${field} must be a whole number between ${min} and ${max}.`, { field });
  }
  return n;
}

export const bool = (v) => v === true || v === 'true' || v === 1 || v === '1';

export function obj(v, field = 'body') {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('invalid_body', `${field} must be a JSON object.`);
  return v;
}
