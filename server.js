// RKZ (ركز) server: Express API + static frontend + PostgreSQL.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { pool, migrate } = require('./src/db');
const { schedule } = require('./src/scheduler');
const v = require('./src/validate');
const ai = require('./src/ai');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---------- Security headers ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  );
  next();
});

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// ---------- Anonymous private session (no login) ----------
// Each browser gets a random id in an HttpOnly cookie; every query is filtered by it.
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

app.use('/api', async (req, res, next) => {
  if (req.path === '/health') return next();
  try {
    let uid = readCookie(req, 'rkz_uid');
    if (!uid || !v.UUID_RE.test(uid)) {
      uid = crypto.randomUUID();
      const secure = req.secure ? '; Secure' : '';
      res.setHeader('Set-Cookie', `rkz_uid=${uid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
    }
    req.uid = uid.toLowerCase();
    await pool.query('insert into users (id) values ($1) on conflict do nothing', [req.uid]);
    next();
  } catch (e) { next(e); }
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function kuwaitToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuwait', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// ---------- Load + schedule + save the whole plan for one user ----------
async function buildState(uid, { persist = true } = {}) {
  const today = kuwaitToday();
  const [u, ch, as, st] = await Promise.all([
    pool.query('select daily_minutes from users where id=$1', [uid]),
    pool.query('select id, name, scene, sound_on, focus_minutes from channels where user_id=$1 order by created_at', [uid]),
    pool.query("select id, channel_id, title, description, to_char(deadline,'YYYY-MM-DD') as deadline, created_at from assignments where user_id=$1 order by deadline, created_at", [uid]),
    pool.query('select id, assignment_id, ord, title, minutes, done_minutes, status, source from steps where user_id=$1 order by ord', [uid]),
  ]);
  const dailyMinutes = u.rows[0]?.daily_minutes ?? 60;

  const assignments = as.rows.map((a) => ({
    id: a.id,
    channelId: a.channel_id,
    title: a.title,
    description: a.description,
    deadline: a.deadline,
    createdAt: a.created_at.toISOString(),
    steps: st.rows.filter((s) => s.assignment_id === a.id).map((s) => ({
      id: s.id, ord: s.ord, title: s.title, minutes: s.minutes, doneMinutes: s.done_minutes, status: s.status, source: s.source,
    })),
  }));

  const plan = schedule({ today, dailyMinutes, assignments });

  if (persist && st.rows.length) {
    const ids = [], scheds = [], unsched = [];
    for (const s of st.rows) {
      const r = plan.byStep[s.id] || { sessions: [], unscheduledMinutes: 0 };
      ids.push(s.id); scheds.push(JSON.stringify(r.sessions)); unsched.push(r.unscheduledMinutes);
    }
    await pool.query(
      `update steps set schedule = x.sched::jsonb, unscheduled_minutes = x.un
       from unnest($1::uuid[], $2::text[], $3::int[]) as x(id, sched, un)
       where steps.id = x.id and steps.user_id = $4`,
      [ids, scheds, unsched, uid]
    );
  }

  const channels = ch.rows.map((c) => ({ id: c.id, name: c.name, scene: c.scene, soundOn: c.sound_on, focusMinutes: c.focus_minutes }));
  for (const a of assignments) {
    Object.assign(a, plan.byAssignment[a.id]);
    a.subject = channels.find((c) => c.id === a.channelId)?.name || '';
    for (const s of a.steps) Object.assign(s, plan.byStep[s.id]);
  }
  const se = await pool.query(
    `select id, step_id, assignment_id, channel_id, step_title, scene, sound_on, planned_minutes, focused_seconds,
            outcome, done_minutes, note, reviewed, created_at
     from sessions where user_id=$1 order by created_at desc limit 30`, [uid]);
  const sessions = se.rows.map((r) => ({
    id: r.id, stepId: r.step_id, assignmentId: r.assignment_id, channelId: r.channel_id, stepTitle: r.step_title,
    scene: r.scene, soundOn: r.sound_on, plannedMinutes: r.planned_minutes, focusedSeconds: r.focused_seconds,
    outcome: r.outcome, doneMinutes: r.done_minutes, note: r.note, reviewed: r.reviewed, createdAt: r.created_at.toISOString(),
  }));
  const rv = await pool.query(
    'select id, session_id, assignment_id, source, ai_message, ai_tip, before, after, created_at from revisions where user_id=$1 order by created_at desc limit 5', [uid]);
  const revisions = rv.rows.map((r) => ({
    id: r.id, sessionId: r.session_id, assignmentId: r.assignment_id, source: r.source, aiMessage: r.ai_message, aiTip: r.ai_tip,
    before: r.before, after: r.after, createdAt: r.created_at.toISOString(),
  }));
  return { today, settings: { dailyMinutes }, channels, assignments, agenda: plan.agenda, sessions, revisions };
}

async function channelFor(client, uid, subject) {
  const found = await client.query('select id from channels where user_id=$1 and lower(name)=lower($2)', [uid, subject]);
  if (found.rows[0]) return found.rows[0].id;
  const made = await client.query(
    'insert into channels (user_id, name) values ($1,$2) on conflict (user_id, lower(name)) do update set name=channels.name returning id',
    [uid, subject]
  );
  return made.rows[0].id;
}

function readAssignment(body, today) {
  const title = v.text(body.title, { field: 'Assignment name', min: 1, max: 120 });
  const subject = v.text(body.subject, { field: 'Subject', min: 1, max: 40 });
  const description = v.text(body.description, { field: 'Description', max: 2000 });
  const deadline = v.isoDate(body.deadline, { field: 'Deadline' });
  if (deadline < today) throw new v.ValidationError('Deadline can’t be in the past.');
  const steps = v.steps(body.steps);
  return { title, subject, description, deadline, steps };
}

// ---------- Routes ----------
app.get('/api/health', wrap(async (req, res) => {
  await pool.query('select 1');
  res.json({ ok: true, ai: Boolean(process.env.OPENROUTER_API_KEY) });
}));

app.get('/api/state', wrap(async (req, res) => {
  res.json(await buildState(req.uid));
}));

app.put('/api/settings', wrap(async (req, res) => {
  const dailyMinutes = v.int(req.body.dailyMinutes, { field: 'Study minutes per day', min: 10, max: 720 });
  await pool.query('update users set daily_minutes=$1 where id=$2', [dailyMinutes, req.uid]);
  res.json(await buildState(req.uid));
}));

app.post('/api/assignments', wrap(async (req, res) => {
  const a = readAssignment(req.body, kuwaitToday());
  const client = await pool.connect();
  try {
    await client.query('begin');
    const count = await client.query('select count(*)::int as n from assignments where user_id=$1', [req.uid]);
    if (count.rows[0].n >= 50) throw new v.ValidationError('You have reached the 50 assignment limit. Delete one first.');
    const channelId = await channelFor(client, req.uid, a.subject);
    const ins = await client.query(
      'insert into assignments (user_id, channel_id, title, description, deadline) values ($1,$2,$3,$4,$5) returning id',
      [req.uid, channelId, a.title, a.description, a.deadline]
    );
    const aid = ins.rows[0].id;
    for (const [i, s] of a.steps.entries()) {
      await client.query('insert into steps (assignment_id, user_id, ord, title, minutes, source) values ($1,$2,$3,$4,$5,$6)',
        [aid, req.uid, i, s.title, s.minutes, s.source]);
    }
    await client.query('commit');
    const state = await buildState(req.uid);
    res.status(201).json({ ...state, savedId: aid });
  } catch (e) { await client.query('rollback'); throw e; }
  finally { client.release(); }
}));

app.put('/api/assignments/:id', wrap(async (req, res) => {
  const id = v.uuid(req.params.id, { field: 'assignment' });
  const a = readAssignment(req.body, kuwaitToday());
  const client = await pool.connect();
  try {
    await client.query('begin');
    const own = await client.query('select id from assignments where id=$1 and user_id=$2 for update', [id, req.uid]);
    if (!own.rows[0]) { const e = new Error('Assignment not found.'); e.status = 404; throw e; }
    const channelId = await channelFor(client, req.uid, a.subject);
    await client.query('update assignments set channel_id=$1, title=$2, description=$3, deadline=$4 where id=$5 and user_id=$6',
      [channelId, a.title, a.description, a.deadline, id, req.uid]);
    // Keep progress on steps that still exist; replace the rest.
    const keep = a.steps.filter((s) => s.id).map((s) => s.id);
    await client.query('delete from steps where assignment_id=$1 and user_id=$2 and not (id = any($3::uuid[]))', [id, req.uid, keep]);
    for (const [i, s] of a.steps.entries()) {
      if (s.id) {
        await client.query('update steps set ord=$1, title=$2, minutes=$3, done_minutes=least(done_minutes,$3) where id=$4 and assignment_id=$5 and user_id=$6',
          [i, s.title, s.minutes, s.id, id, req.uid]);
      } else {
        await client.query('insert into steps (assignment_id, user_id, ord, title, minutes, source) values ($1,$2,$3,$4,$5,$6)',
          [id, req.uid, i, s.title, s.minutes, s.source]);
      }
    }
    await client.query('commit');
    res.json({ ...(await buildState(req.uid)), savedId: id });
  } catch (e) { await client.query('rollback'); throw e; }
  finally { client.release(); }
}));

app.delete('/api/assignments/:id', wrap(async (req, res) => {
  const id = v.uuid(req.params.id, { field: 'assignment' });
  const r = await pool.query('delete from assignments where id=$1 and user_id=$2', [id, req.uid]);
  if (!r.rowCount) return res.status(404).json({ error: 'Assignment not found.' });
  res.json(await buildState(req.uid));
}));

// ---------- Focus Room: subject channels ----------
function readChannel(body, { partial = false } = {}) {
  const out = {};
  if (!partial || body.name !== undefined) out.name = v.text(body.name, { field: 'Channel name', min: 1, max: 40 });
  if (!partial || body.scene !== undefined) out.scene = v.scene(body.scene);
  if (!partial || body.soundOn !== undefined) out.soundOn = v.bool(body.soundOn, { field: 'Sound' });
  if (!partial || body.focusMinutes !== undefined) out.focusMinutes = v.int(body.focusMinutes, { field: 'Focus length', min: 5, max: 180 });
  return out;
}
function nameTaken(e, name) {
  if (e.code === '23505') { const err = new v.ValidationError(`You already have a channel called “${name}”.`); err.status = 409; return err; }
  return e;
}

app.post('/api/channels', wrap(async (req, res) => {
  const c = readChannel(req.body);
  const n = await pool.query('select count(*)::int as n from channels where user_id=$1', [req.uid]);
  if (n.rows[0].n >= 30) throw new v.ValidationError('You can have up to 30 channels.');
  try {
    await pool.query('insert into channels (user_id, name, scene, sound_on, focus_minutes) values ($1,$2,$3,$4,$5)',
      [req.uid, c.name, c.scene, c.soundOn, c.focusMinutes]);
  } catch (e) { throw nameTaken(e, c.name); }
  res.status(201).json(await buildState(req.uid));
}));

app.put('/api/channels/:id', wrap(async (req, res) => {
  const id = v.uuid(req.params.id, { field: 'channel' });
  const c = readChannel(req.body, { partial: true });
  const cols = { name: 'name', scene: 'scene', soundOn: 'sound_on', focusMinutes: 'focus_minutes' };
  const keys = Object.keys(c);
  if (!keys.length) throw new v.ValidationError('Nothing to update.');
  const sets = keys.map((k, i) => `${cols[k]}=$${i + 1}`).join(', ');
  let r;
  try {
    r = await pool.query(`update channels set ${sets} where id=$${keys.length + 1} and user_id=$${keys.length + 2}`,
      [...keys.map((k) => c[k]), id, req.uid]);
  } catch (e) { throw nameTaken(e, c.name); }
  if (!r.rowCount) return res.status(404).json({ error: 'Channel not found.' });
  res.json(await buildState(req.uid));
}));

// One tap for judges: Math and Biology channels with different setups, each with a task to open.
app.post('/api/demo/focus-sample', wrap(async (req, res) => {
  const today = kuwaitToday();
  const plusDays = (n) => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const samples = [
    { name: 'Math', scene: 'plain', soundOn: false, focusMinutes: 50, title: 'Calculus II: Practice Set 4', due: 4,
      steps: [['Solve integration by parts problems 1–6', 50], ['Check answers and redo mistakes', 30]] },
    { name: 'Biology', scene: 'rain', soundOn: true, focusMinutes: 25, title: 'Biology: Cell Respiration Notes', due: 3,
      steps: [['Read chapter 9 and highlight key terms', 25], ['Draw the Krebs cycle diagram', 25]] },
  ];
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const s of samples) {
      const ch = await client.query(
        `insert into channels (user_id, name, scene, sound_on, focus_minutes) values ($1,$2,$3,$4,$5)
         on conflict (user_id, lower(name)) do update set scene=excluded.scene, sound_on=excluded.sound_on, focus_minutes=excluded.focus_minutes
         returning id`, [req.uid, s.name, s.scene, s.soundOn, s.focusMinutes]);
      const chId = ch.rows[0].id;
      const has = await client.query('select 1 from assignments where user_id=$1 and title=$2', [req.uid, s.title]);
      if (has.rows[0]) continue;
      const a = await client.query('insert into assignments (user_id, channel_id, title, description, deadline) values ($1,$2,$3,$4,$5) returning id',
        [req.uid, chId, s.title, 'Sample task for the Focus Room', plusDays(s.due)]);
      for (const [i, [t, m]] of s.steps.entries()) {
        await client.query('insert into steps (assignment_id, user_id, ord, title, minutes) values ($1,$2,$3,$4,$5)', [a.rows[0].id, req.uid, i, t, m]);
      }
    }
    await client.query('commit');
  } catch (e) { await client.query('rollback'); throw e; }
  finally { client.release(); }
  res.json(await buildState(req.uid));
}));

// ---------- Focus Room: save a session outcome ----------
app.post('/api/sessions', wrap(async (req, res) => {
  const stepId = v.uuid(req.body.stepId, { field: 'task' });
  const outcome = v.outcome(req.body.outcome);
  const scene = v.scene(req.body.scene);
  const soundOn = v.bool(req.body.soundOn, { field: 'Sound' });
  const plannedMinutes = v.int(req.body.plannedMinutes, { field: 'Focus length', min: 1, max: 180 });
  const focusedSeconds = v.int(req.body.focusedSeconds ?? 0, { field: 'Focused time', min: 0, max: 6 * 3600 });
  const note = v.text(req.body.note, { field: 'Note', max: 500 });
  let doneMinutes = outcome === 'missed' ? 0 : v.int(req.body.doneMinutes ?? 0, { field: 'Minutes done', min: 0, max: 600 });

  const client = await pool.connect();
  try {
    await client.query('begin');
    const st = await client.query(
      `select s.id, s.title, s.minutes, s.done_minutes, s.assignment_id, a.channel_id
       from steps s join assignments a on a.id = s.assignment_id
       where s.id=$1 and s.user_id=$2 for update of s`, [stepId, req.uid]);
    const step = st.rows[0];
    if (!step) { const e = new Error('Task not found.'); e.status = 404; throw e; }

    let newDone = step.done_minutes;
    let status;
    if (outcome === 'complete') { doneMinutes = Math.max(doneMinutes, step.minutes - step.done_minutes); newDone = step.minutes; status = 'done'; }
    else if (outcome === 'partial') {
      if (doneMinutes < 1) throw new v.ValidationError('For a partial session, enter how many minutes you got done.');
      newDone = Math.min(step.minutes, step.done_minutes + doneMinutes);
      status = newDone >= step.minutes ? 'done' : 'partial';
    } else { status = step.done_minutes > 0 ? 'partial' : 'missed'; }

    await client.query('update steps set done_minutes=$1, status=$2 where id=$3 and user_id=$4', [newDone, status, stepId, req.uid]);
    const ins = await client.query(
      `insert into sessions (user_id, step_id, assignment_id, channel_id, step_title, scene, sound_on, planned_minutes, focused_seconds, outcome, done_minutes, note, reviewed)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [req.uid, stepId, step.assignment_id, step.channel_id, step.title, scene, soundOn, plannedMinutes, focusedSeconds, outcome, doneMinutes, note, outcome === 'complete']);
    await client.query('commit');
    res.status(201).json({ ...(await buildState(req.uid)), sessionId: ins.rows[0].id });
  } catch (e) { await client.query('rollback'); throw e; }
  finally { client.release(); }
}));

// ---------- Progress Review + Replanning ----------
function snapshot(state, assignmentId) {
  const a = state.assignments.find((x) => x.id === assignmentId);
  if (!a) return null;
  return {
    title: a.title, subject: a.subject, deadline: a.deadline, risk: a.risk, finishDate: a.finishDate,
    remainingMinutes: a.remainingMinutes, unscheduledMinutes: a.unscheduledMinutes,
    steps: a.steps.map((s) => ({ id: s.id, title: s.title, minutes: s.minutes, status: s.status, doneMinutes: s.doneMinutes, source: s.source, sessions: s.sessions, unscheduledMinutes: s.unscheduledMinutes })),
  };
}

async function loadReviewContext(uid, sessionId) {
  const r = await pool.query(
    `select se.id, se.outcome, se.note, se.reviewed, s.id as step_id, s.title as step_title, s.minutes, s.done_minutes, s.status, s.ord,
            a.id as assignment_id, a.title as assignment_title, to_char(a.deadline,'YYYY-MM-DD') as deadline, c.name as subject
     from sessions se
     join steps s on s.id = se.step_id and s.user_id = se.user_id
     join assignments a on a.id = s.assignment_id
     left join channels c on c.id = a.channel_id
     where se.id=$1 and se.user_id=$2`, [sessionId, uid]);
  const row = r.rows[0];
  if (!row) { const e = new Error('Session not found, or its task was deleted.'); e.status = 404; throw e; }
  return row;
}

app.post('/api/demo/review-sample', wrap(async (req, res) => {
  const today = kuwaitToday();
  const plusDays = (n) => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const title = 'History Essay: Ottoman Reforms';
  const client = await pool.connect();
  try {
    await client.query('begin');
    const has = await client.query(
      `select se.id from sessions se join assignments a on a.id = se.assignment_id
       where se.user_id=$1 and a.title=$2 and se.reviewed=false`, [req.uid, title]);
    if (!has.rows[0]) {
      const ch = await client.query(
        `insert into channels (user_id, name, scene, sound_on, focus_minutes) values ($1,'History','fireplace',true,30)
         on conflict (user_id, lower(name)) do update set name=channels.name returning id`, [req.uid]);
      const a = await client.query('insert into assignments (user_id, channel_id, title, description, deadline) values ($1,$2,$3,$4,$5) returning id',
        [req.uid, ch.rows[0].id, title, '1200-word essay on the Tanzimat reforms with 4 sources.', plusDays(3)]);
      const steps = [['Read sources and take notes', 60, 20, 'partial'], ['Write the outline and thesis', 30, 0, 'todo'], ['Write the full draft', 90, 0, 'todo'], ['Edit and add citations', 30, 0, 'todo']];
      let first;
      for (const [i, [t, m, d, st]] of steps.entries()) {
        const s = await client.query('insert into steps (assignment_id, user_id, ord, title, minutes, done_minutes, status) values ($1,$2,$3,$4,$5,$6,$7) returning id',
          [a.rows[0].id, req.uid, i, t, m, d, st]);
        if (i === 0) first = s.rows[0].id;
      }
      await client.query(
        `insert into sessions (user_id, step_id, assignment_id, channel_id, step_title, scene, sound_on, planned_minutes, focused_seconds, outcome, done_minutes, note)
         values ($1,$2,$3,$4,'Read sources and take notes','fireplace',true,60,1200,'partial',20,$5)`,
        [req.uid, first, a.rows[0].id, ch.rows[0].id, 'Family visitors came over and I kept checking my phone. Only got through 1 of the 4 sources.']);
    }
    await client.query('commit');
  } catch (e) { await client.query('rollback'); throw e; }
  finally { client.release(); }
  res.json(await buildState(req.uid));
}));

app.post('/api/ai/recovery', (req, res, next) => aiRateLimit(req, res, next), wrap(async (req, res) => {
  const sessionId = v.uuid(req.body.sessionId, { field: 'session' });
  const note = v.text(req.body.note, { field: 'Note', max: 500 });
  const row = await loadReviewContext(req.uid, sessionId);
  const remaining = Math.max(0, row.minutes - row.done_minutes);
  if (remaining === 0) throw new v.ValidationError('This task is already finished. Nothing to recover.');
  const today = kuwaitToday();
  const later = await pool.query('select title from steps where assignment_id=$1 and user_id=$2 and ord>$3 and status<>$4 order by ord limit 6',
    [row.assignment_id, req.uid, row.ord, 'done']);
  const u = await pool.query('select daily_minutes from users where id=$1', [req.uid]);
  const daysLeft = Math.round((Date.parse(row.deadline + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
  const result = await ai.suggestRecovery({
    assignmentTitle: row.assignment_title, subject: row.subject || '', deadline: row.deadline, today, daysLeft,
    stepTitle: row.step_title, stepMinutes: row.minutes, doneMinutes: row.done_minutes, remaining, outcome: row.outcome,
    note: note || row.note, dailyMinutes: u.rows[0]?.daily_minutes ?? 60, laterSteps: later.rows.map((r) => r.title),
  });
  res.json({ ...result, remainingMinutes: remaining });
}));

app.post('/api/recovery/apply', wrap(async (req, res) => {
  const sessionId = v.uuid(req.body.sessionId, { field: 'session' });
  const source = req.body.source === 'ai' ? 'ai' : 'manual';
  const note = v.text(req.body.note, { field: 'Note', max: 500 });
  const aiMessage = v.text(req.body.aiMessage, { field: 'AI message', max: 300 });
  const aiTip = v.text(req.body.aiTip, { field: 'AI tip', max: 200 });
  const steps = v.steps(req.body.steps);
  if (steps.length > 5) throw new v.ValidationError('Keep the recovery to 5 steps or fewer.');
  const row = await loadReviewContext(req.uid, sessionId);
  if (row.reviewed) { const e = new v.ValidationError('This session was already replanned.'); e.status = 409; throw e; }

  const before = snapshot(await buildState(req.uid), row.assignment_id);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select id from steps where id=$1 and user_id=$2 for update', [row.step_id, req.uid]);
    const n = steps.length;
    // make room right after the unfinished step
    await client.query('update steps set ord = ord + $1 where assignment_id=$2 and user_id=$3 and ord > $4', [n, row.assignment_id, req.uid, row.ord]);
    for (const [i, s] of steps.entries()) {
      await client.query('insert into steps (assignment_id, user_id, ord, title, minutes, source) values ($1,$2,$3,$4,$5,$6)',
        [row.assignment_id, req.uid, row.ord + 1 + i, s.title, s.minutes, s.source === 'ai' ? 'ai' : 'recovery']);
    }
    // preserve completed work: the finished part stays as a done step; an untouched step is replaced
    if (row.done_minutes > 0) {
      await client.query("update steps set minutes=done_minutes, status='done' where id=$1 and user_id=$2", [row.step_id, req.uid]);
    } else {
      await client.query('delete from steps where id=$1 and user_id=$2', [row.step_id, req.uid]);
    }
    await client.query('update sessions set reviewed=true, note=case when $1 <> \'\' then $1 else note end where id=$2 and user_id=$3', [note, sessionId, req.uid]);
    await client.query('commit');
  } catch (e) { await client.query('rollback'); throw e; }
  finally { client.release(); }

  const state = await buildState(req.uid);
  const after = snapshot(state, row.assignment_id);
  await pool.query(
    'insert into revisions (user_id, session_id, assignment_id, source, ai_message, ai_tip, before, after) values ($1,$2,$3,$4,$5,$6,$7,$8)',
    [req.uid, sessionId, row.assignment_id, source, aiMessage, aiTip, JSON.stringify(before), JSON.stringify(after)]);
  res.json(await buildState(req.uid));
}));

// ---------- AI ----------
const aiHits = new Map(); // simple per-user rate limit: 15 calls / 10 minutes
function aiRateLimit(req, res, next) {
  const now = Date.now();
  const list = (aiHits.get(req.uid) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (list.length >= 15) return res.status(429).json({ error: 'Too many AI requests. Wait a few minutes or add steps manually.' });
  list.push(now); aiHits.set(req.uid, list); next();
}

app.post('/api/ai/suggest-steps', aiRateLimit, wrap(async (req, res) => {
  const title = v.text(req.body.title, { field: 'Assignment name', min: 1, max: 120 });
  const subject = v.text(req.body.subject, { field: 'Subject', max: 40 });
  const description = v.text(req.body.description, { field: 'Description', max: 2000 });
  const deadline = req.body.deadline ? v.isoDate(req.body.deadline, { field: 'Deadline' }) : '';
  const u = await pool.query('select daily_minutes from users where id=$1', [req.uid]);
  const result = await ai.suggestSteps({ title, subject, description, deadline, today: kuwaitToday(), dailyMinutes: u.rows[0]?.daily_minutes });
  res.json(result);
}));

// ---------- Errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That request is too large.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
  const status = err.status || 500;
  if (status >= 500 && !(err instanceof ai.AIError)) console.error(err);
  res.status(status).json({ error: status >= 500 && !(err instanceof ai.AIError) ? 'Something went wrong on the server. Please try again.' : err.message });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  migrate()
    .then(() => app.listen(PORT, () => console.log(`RKZ running on port ${PORT}`)))
    .catch((e) => { console.error('Database setup failed:', e); process.exit(1); });
}

module.exports = { app, buildState };
