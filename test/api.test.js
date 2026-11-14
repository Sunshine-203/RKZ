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
  await pool.query('drop table if exists revisions, sessions, steps, assignments, channels, users cascade');
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

test('focus room: channels keep separate defaults, sessions save outcomes, isolation holds', async () => {
  const a = client(); const b = client();
  let r = await a('POST', '/api/demo/focus-sample');
  assert.strictEqual(r.status, 200);
  const math = r.body.channels.find((c) => c.name === 'Math');
  const bio = r.body.channels.find((c) => c.name === 'Biology');
  assert.deepStrictEqual([math.scene, math.soundOn, math.focusMinutes], ['plain', false, 50]);
  assert.deepStrictEqual([bio.scene, bio.soundOn, bio.focusMinutes], ['rain', true, 25]);
  // calling sample again does not duplicate tasks
  r = await a('POST', '/api/demo/focus-sample');
  assert.strictEqual(r.body.assignments.length, 2);

  // edit Math defaults, Biology untouched, persists after refresh
  r = await a('PUT', `/api/channels/${math.id}`, { scene: 'ocean', soundOn: true, focusMinutes: 40 });
  assert.strictEqual(r.status, 200);
  r = await a('GET', '/api/state');
  const m2 = r.body.channels.find((c) => c.id === math.id), b2 = r.body.channels.find((c) => c.id === bio.id);
  assert.deepStrictEqual([m2.scene, m2.soundOn, m2.focusMinutes], ['ocean', true, 40]);
  assert.deepStrictEqual([b2.scene, b2.soundOn, b2.focusMinutes], ['rain', true, 25]);

  // rename + duplicate name rejected + bad scene rejected
  r = await a('PUT', `/api/channels/${math.id}`, { name: 'Calculus' }); assert.strictEqual(r.status, 200);
  r = await a('PUT', `/api/channels/${math.id}`, { name: 'biology' }); assert.strictEqual(r.status, 409);
  r = await a('PUT', `/api/channels/${math.id}`, { scene: 'disco' }); assert.strictEqual(r.status, 400);
  r = await a('POST', '/api/channels', { name: 'Physics', scene: 'fireplace', soundOn: true, focusMinutes: 30 }); assert.strictEqual(r.status, 201);

  // other browser can't edit my channel
  await b('GET', '/api/state');
  r = await b('PUT', `/api/channels/${bio.id}`, { scene: 'plain' }); assert.strictEqual(r.status, 404);

  // partial session on a Biology step
  const bioTask = r = (await a('GET', '/api/state')).body.assignments.find((x) => x.subject === 'Biology');
  const step = bioTask.steps[0];
  r = await a('POST', '/api/sessions', { stepId: step.id, outcome: 'partial', scene: 'rain', soundOn: true, plannedMinutes: 25, focusedSeconds: 600, doneMinutes: 10, note: 'Phone distracted me' });
  assert.strictEqual(r.status, 201);
  let s1 = r.body.assignments.find((x) => x.id === bioTask.id).steps[0];
  assert.strictEqual(s1.status, 'partial'); assert.strictEqual(s1.doneMinutes, 10); assert.strictEqual(s1.remainingMinutes, 15);
  assert.strictEqual(r.body.sessions[0].note, 'Phone distracted me');
  // complete it
  r = await a('POST', '/api/sessions', { stepId: step.id, outcome: 'complete', scene: 'rain', soundOn: true, plannedMinutes: 25, focusedSeconds: 900, doneMinutes: 15 });
  s1 = r.body.assignments.find((x) => x.id === bioTask.id).steps[0];
  assert.strictEqual(s1.status, 'done');
  // invalid outcome / foreign step
  r = await a('POST', '/api/sessions', { stepId: step.id, outcome: 'great', scene: 'rain', soundOn: true, plannedMinutes: 25 }); assert.strictEqual(r.status, 400);
  r = await b('POST', '/api/sessions', { stepId: step.id, outcome: 'missed', scene: 'rain', soundOn: true, plannedMinutes: 25 }); assert.strictEqual(r.status, 404);
});

test('progress review: AI recovery keeps finished work, adds steps, saves a before/after revision', async () => {
  const a = client(); const b = client();
  let r = await a('POST', '/api/demo/review-sample');
  assert.strictEqual(r.status, 200);
  const sess = r.body.sessions.find((s) => !s.reviewed && s.outcome === 'partial');
  assert.ok(sess && sess.note.includes('phone'));
  // idempotent sample
  r = await a('POST', '/api/demo/review-sample');
  assert.strictEqual(r.body.sessions.filter((s) => !s.reviewed).length, 1);

  let sentPrompt;
  ai._setFetch(async (url, opts) => { sentPrompt = JSON.parse(opts.body).messages[1].content; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    message: 'Busy evening at home is normal. Let’s finish the sources in short, phone-free blocks.',
    steps: [{ title: 'Phone in another room: read sources 2 and 3', minutes: 25 }, { title: 'Read source 4 and add notes', minutes: 20 }, { title: 'Bad step', minutes: 'x' }],
    tip: 'Set a 25-minute timer and leave your phone outside the room.' }) } }] }), { status: 200 }); });
  r = await a('POST', '/api/ai/recovery', { sessionId: sess.id, note: '' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.steps.length, 2);
  assert.strictEqual(r.body.remainingMinutes, 40);
  assert.match(sentPrompt, /Family visitors/);
  assert.match(sentPrompt, /40 min left/);

  // other browser cannot touch it
  await b('GET', '/api/state');
  r = await b('POST', '/api/ai/recovery', { sessionId: sess.id }); assert.strictEqual(r.status, 404);
  r = await b('POST', '/api/recovery/apply', { sessionId: sess.id, steps: [{ title: 'x', minutes: 10 }] }); assert.strictEqual(r.status, 404);

  r = await a('POST', '/api/recovery/apply', { sessionId: sess.id, source: 'ai', steps: [{ title: 'Phone in another room: read sources 2 and 3', minutes: 25, source: 'ai' }, { title: 'Read source 4 and add notes', minutes: 20, source: 'ai' }], aiMessage: 'ok', aiTip: 'tip' });
  assert.strictEqual(r.status, 200);
  const essay = r.body.assignments.find((x) => x.title === 'History Essay: Ottoman Reforms');
  assert.deepStrictEqual(essay.steps.map((s) => [s.title, s.status, s.minutes]), [
    ['Read sources and take notes', 'done', 20],
    ['Phone in another room: read sources 2 and 3', 'todo', 25],
    ['Read source 4 and add notes', 'todo', 20],
    ['Write the outline and thesis', 'todo', 30],
    ['Write the full draft', 'todo', 90],
    ['Edit and add citations', 'todo', 30],
  ]);
  const rev = r.body.revisions[0];
  assert.strictEqual(rev.source, 'ai');
  assert.strictEqual(rev.before.steps.length, 4);
  assert.strictEqual(rev.after.steps.length, 6);
  // persists after refresh, cannot re-apply
  r = await a('GET', '/api/state');
  assert.strictEqual(r.body.revisions.length, 1);
  assert.ok(r.body.sessions.find((s) => s.id === sess.id).reviewed);
  r = await a('POST', '/api/recovery/apply', { sessionId: sess.id, steps: [{ title: 'x', minutes: 10 }] });
  assert.strictEqual(r.status, 409);
});

test('missed session with no progress is replaced by recovery steps (manual, no AI)', async () => {
  const a = client();
  let r = await a('POST', '/api/assignments', { title: 'Physics lab', subject: 'Physics', deadline: inDays(1), steps: [{ title: 'Run experiment', minutes: 60 }, { title: 'Write report', minutes: 60 }] });
  const step = r.body.assignments[0].steps[0];
  r = await a('POST', '/api/sessions', { stepId: step.id, outcome: 'missed', scene: 'plain', soundOn: false, plannedMinutes: 60, note: 'Lab was closed' });
  const sid = r.body.sessionId;
  r = await a('POST', '/api/recovery/apply', { sessionId: sid, source: 'manual', steps: [{ title: 'Finish: Run experiment', minutes: 60 }] });
  assert.strictEqual(r.status, 200);
  const steps = r.body.assignments[0].steps;
  assert.deepStrictEqual(steps.map((s) => s.title), ['Finish: Run experiment', 'Write report']);
  assert.strictEqual(r.body.revisions[0].source, 'manual');
  assert.strictEqual(r.body.assignments[0].risk, 'yellow'); // 120 min over today+tomorrow at 60/day finishes on due day
});

test('accounts: sign up keeps guest data, generic login error, logout gives a fresh guest', async () => {
  const a = client();
  await a('POST', '/api/assignments', { title: 'Keep me', subject: 'Art', deadline: inDays(2), steps: [{ title: 'Sketch', minutes: 20 }] });
  let r = await a('POST', '/api/auth/register', { name: 'Shurouq', username: 'sunshine', password: 'secret123' });
  assert.strictEqual(r.status, 201); assert.strictEqual(r.body.profile.name, 'Shurouq'); assert.strictEqual(r.body.assignments.length, 1);
  r = await a('POST', '/api/auth/logout'); assert.strictEqual(r.body.profile.guest, true); assert.strictEqual(r.body.assignments.length, 0);
  r = await a('POST', '/api/auth/login', { username: 'sunshine', password: 'wrongpass' }); assert.strictEqual(r.status, 401); assert.strictEqual(r.body.error, 'Incorrect username or password.');
  r = await a('POST', '/api/auth/login', { username: 'nobody', password: 'whatever1' }); assert.strictEqual(r.body.error, 'Incorrect username or password.');
  r = await a('POST', '/api/auth/login', { username: 'SUNSHINE', password: 'secret123' }); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.assignments[0].title, 'Keep me');
  const b = client(); await b('GET', '/api/state');
  r = await b('POST', '/api/auth/register', { name: 'X', username: 'sunshine', password: 'another1' }); assert.strictEqual(r.status, 409);
  r = await b('POST', '/api/auth/register', { name: 'X', username: 'bad name!', password: 'another1' }); assert.strictEqual(r.status, 400);
  const row = await pool.query("select password_hash from users where username='sunshine'"); assert.ok(!row.rows[0].password_hash.includes('secret123'));
});
