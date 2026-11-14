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
  return { today, settings: { dailyMinutes }, channels, assignments, agenda: plan.agenda };
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
