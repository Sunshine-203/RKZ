// Integration test: real Express app + real PostgreSQL (TEST_DATABASE_URL). AI is mocked.
const test = require('node:test');
const assert = require('node:assert');

if (!process.env.TEST_DATABASE_URL) { test('api (skipped: no TEST_DATABASE_URL)', () => {}); return; }
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.OPENROUTER_API_KEY = 'test-key';

const { app } = require('../server');
const { pool, migrate } = require('../src/db');
const ai = require('../src/ai');

let server, base;
test.before(async () => {
  await pool.query('drop table if exists steps, assignments, channels, users cascade');
  await migrate();
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await pool.end(); });

function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}
const inDays = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test('full planner flow with AI steps, persistence and user isolation', async () => {
  const a = client(); const b = client();
  let r = await a('GET', '/api/state');
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.assignments.length, 0);

  // AI suggest (mocked OpenRouter)
  let sent;
  ai._setFetch(async (url, opts) => { sent = JSON.parse(opts.body); return new Response(JSON.stringify({
    model: 'google/gemini-3.7-flash',
    choices: [{ message: { content: '```json\n{"steps":[{"title":"Research enzyme basics","minutes":42},{"title":"Write draft","minutes":90},{"title":"","minutes":10}]}\n```' } }],
  }), { status: 200 }); });
  r = await a('POST', '/api/ai/suggest-steps', { title: 'Bio lab report', subject: 'Biology', description: '1500 words', deadline: inDays(3) });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.steps, [{ title: 'Research enzyme basics', minutes: 40, source: 'ai' }, { title: 'Write draft', minutes: 90, source: 'ai' }]);
  assert.match(sent.messages[1].content, /Bio lab report/);
  assert.ok(!JSON.stringify(r.body).includes('test-key'));

  // Save plan
  r = await a('POST', '/api/assignments', { title: 'Bio lab report', subject: 'Biology', deadline: inDays(3), description: '1500 words', steps: r.body.steps });
  assert.strictEqual(r.status, 201);
  const saved = r.body.assignments[0];
  assert.strictEqual(saved.subject, 'Biology');
  assert.strictEqual(saved.steps.length, 2);
  assert.ok(saved.steps[0].sessions.length > 0);
  assert.strictEqual(r.body.channels[0].name, 'Biology');

  // Overflow warning when study time shrinks
  r = await a('PUT', '/api/settings', { dailyMinutes: 10 });
  assert.strictEqual(r.body.assignments[0].risk, 'red');
  assert.ok(r.body.assignments[0].unscheduledMinutes > 0);

  // Persisted after "refresh"
  r = await a('GET', '/api/state');
  assert.strictEqual(r.body.assignments.length, 1);
  assert.strictEqual(r.body.settings.dailyMinutes, 10);

  // Another browser sees nothing and cannot touch it
  r = await b('GET', '/api/state'); assert.strictEqual(r.body.assignments.length, 0);
  r = await b('DELETE', `/api/assignments/${saved.id}`); assert.strictEqual(r.status, 404);

  // Edit keeps step ids
  r = await a('PUT', `/api/assignments/${saved.id}`, { title: 'Bio lab report v2', subject: 'biology', deadline: inDays(4), description: '', steps: [{ id: saved.steps[0].id, title: 'Research', minutes: 30 }, { title: 'New step', minutes: 20 }] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.assignments[0].steps[0].id, saved.steps[0].id);
  assert.strictEqual(r.body.channels.length, 1); // same subject, case-insensitive
});

test('validation rejects bad input', async () => {
  const a = client();
  await a('GET', '/api/state');
  let r = await a('POST', '/api/assignments', { title: '', subject: 'x', deadline: inDays(1), steps: [{ title: 'a', minutes: 10 }] });
  assert.strictEqual(r.status, 400);
  r = await a('POST', '/api/assignments', { title: 'x', subject: 'x', deadline: '2020-01-01', steps: [{ title: 'a', minutes: 10 }] });
  assert.match(r.body.error, /past/);
  r = await a('POST', '/api/assignments', { title: 'x', subject: 'x', deadline: inDays(1), steps: [{ title: 'a', minutes: 9999 }] });
  assert.strictEqual(r.status, 400);
  r = await a('POST', '/api/assignments', { title: 'x', subject: 'x', deadline: inDays(1), steps: [] });
  assert.strictEqual(r.status, 400);
  r = await a('DELETE', '/api/assignments/not-a-uuid');
  assert.strictEqual(r.status, 400);
  r = await a('PUT', '/api/settings', { dailyMinutes: 'lots' });
  assert.strictEqual(r.status, 400);
});

test('AI failure returns a friendly error and manual planning still works', async () => {
  const a = client();
  ai._setFetch(async () => new Response('{"error":"down"}', { status: 500 }));
  let r = await a('POST', '/api/ai/suggest-steps', { title: 'Essay' });
  assert.strictEqual(r.status, 503);
  assert.match(r.body.error, /add steps manually/);
  r = await a('POST', '/api/assignments', { title: 'Essay', subject: 'English', deadline: inDays(2), steps: [{ title: 'Outline', minutes: 30 }] });
  assert.strictEqual(r.status, 201);
});
