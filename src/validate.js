// Server-side validation. Every value from the browser goes through here before touching the database.

class ValidationError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

function text(v, { field, min = 0, max = 200 }) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw new ValidationError(`${field} must be text.`);
  const t = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (t.length < min) throw new ValidationError(min === 1 ? `${field} is required.` : `${field} is too short.`);
  if (t.length > max) throw new ValidationError(`${field} must be ${max} characters or less.`);
  return t;
}

function int(v, { field, min, max }) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) throw new ValidationError(`${field} must be a whole number.`);
  if (n < min || n > max) throw new ValidationError(`${field} must be between ${min} and ${max}.`);
  return n;
}

function isoDate(v, { field }) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ValidationError(`${field} must be a date.`);
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new ValidationError(`${field} is not a real date.`);
  return v;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uuid(v, { field = 'id' } = {}) {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new ValidationError(`Invalid ${field}.`);
  return v.toLowerCase();
}

function steps(v) {
  if (!Array.isArray(v) || v.length === 0) throw new ValidationError('Add at least one study step.');
  if (v.length > 15) throw new ValidationError('Keep it to 15 steps or fewer.');
  return v.map((s, i) => {
    if (!s || typeof s !== 'object') throw new ValidationError(`Step ${i + 1} is invalid.`);
    return {
      id: s.id ? uuid(s.id, { field: 'step id' }) : null,
      title: text(s.title, { field: `Step ${i + 1} name`, min: 1, max: 120 }),
      minutes: int(s.minutes, { field: `Step ${i + 1} minutes`, min: 5, max: 600 }),
      source: s.source === 'ai' ? 'ai' : 'manual',
    };
  });
}

module.exports = { ValidationError, text, int, isoDate, uuid, steps, UUID_RE };
