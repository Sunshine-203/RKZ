// RKZ frontend — Study Planner + AI Study Steps
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let state = null;
  let editingId = null;
  let formSteps = []; // [{id?, title, minutes, source}]
  let sampleIdx = 0;

  // ---------- API ----------
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  // ---------- Dates ----------
  const fmtDay = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const daysLeft = (iso) => Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(state.today + 'T00:00:00Z')) / 86400000);
  const mins = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ' ' + (m % 60) + ' min' : ''}` : `${m} min`);

  // ---------- Messages ----------
  function say(text, kind) {
    const el = $('formMsg');
    el.className = 'msg' + (kind ? ' ' + kind : '');
    el.textContent = text;
  }

  // ---------- Theme ----------
  const themeIcon = () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    $('themeLabel').textContent = dark ? 'Light mode' : 'Dark mode';
    $('themeBtn').querySelector('svg').innerHTML = dark
      ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'
      : '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>';
  };
  themeIcon();
  $('themeBtn').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('rkz-theme', next); } catch (e) {}
    themeIcon();
  });

  // ---------- Steps editor ----------
  function renderSteps(animate) {
    const list = $('stepsList');
    list.innerHTML = '';
    formSteps.forEach((s, i) => {
      const li = document.createElement('li');
      if (animate) { li.className = 'new'; li.style.animationDelay = (i * 60) + 'ms'; }
      li.innerHTML =
        `<span class="num">${i + 1}</span>` +
        `<input type="text" maxlength="120" aria-label="Step ${i + 1} name" value="${esc(s.title)}" placeholder="What will you do?">` +
        `<span class="min-wrap"><input type="number" min="5" max="600" step="5" inputmode="numeric" aria-label="Step ${i + 1} minutes" value="${esc(s.minutes)}"></span>` +
        `<button type="button" class="del-step" aria-label="Remove step ${i + 1}" title="Remove">✕</button>`;
      const [titleIn, minIn] = li.querySelectorAll('input');
      titleIn.addEventListener('input', () => { s.title = titleIn.value; });
      minIn.addEventListener('input', () => { s.minutes = minIn.value === '' ? '' : Number(minIn.value); updateTotal(); });
      li.querySelector('.del-step').addEventListener('click', () => { formSteps.splice(i, 1); renderSteps(); });
      if (s.source === 'ai') {
        const tag = document.createElement('span');
        tag.className = 'tag-ai'; tag.textContent = 'AI';
        li.querySelector('.num').appendChild(document.createElement('br'));
        li.querySelector('.num').appendChild(tag);
      }
      list.appendChild(li);
    });
    $('stepsEmpty').hidden = formSteps.length > 0;
    updateTotal();
  }

  function updateTotal() {
    const total = formSteps.reduce((t, s) => t + (Number(s.minutes) || 0), 0);
    $('stepsTotal').textContent = formSteps.length ? `${formSteps.length} steps · ${mins(total)} total` : '';
  }

  $('addStep').addEventListener('click', () => {
    formSteps.push({ title: '', minutes: 30, source: 'manual' });
    renderSteps();
    const inputs = $('stepsList').querySelectorAll('li:last-child input');
    if (inputs[0]) inputs[0].focus();
  });

  // ---------- Sample (for judges) ----------
  const SAMPLES = [
    {
      title: 'Biology Lab Report: Enzyme Activity', subject: 'Biology', days: 3,
      description: 'Write a 1500-word lab report on how temperature affects enzyme activity. Needs introduction, method, results with two graphs, discussion and at least 5 references.',
    },
    {
      title: 'Calculus II Midterm Prep', subject: 'Math', days: 5,
      description: 'Midterm covers integration by parts, trig substitution, partial fractions and improper integrals. I am weakest at partial fractions.',
    },
  ];
  $('sampleBtn').addEventListener('click', () => {
    if (editingId) resetForm(); // never overwrite the assignment being edited
    const s = SAMPLES[sampleIdx % SAMPLES.length]; sampleIdx++;
    $('title').value = s.title; $('subject').value = s.subject;
    $('description').value = s.description;
    $('deadline').value = addDays(state.today, s.days);
    formSteps = []; renderSteps();
    say('Sample loaded. Now tap ✨ Suggest Study Steps.', 'ok');
    $('aiBtn').focus();
  });

  // ---------- AI: Suggest Study Steps ----------
  $('aiBtn').addEventListener('click', async () => {
    const title = $('title').value.trim();
    if (!title) { say('Add the assignment name first, then ask AI.', 'err'); $('title').focus(); return; }
    const btn = $('aiBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Thinking…';
    say('AI is reading your assignment…');
    try {
      const data = await api('POST', '/api/ai/suggest-steps', {
        title, subject: $('subject').value.trim(), description: $('description').value.trim(), deadline: $('deadline').value || undefined,
      });
      formSteps = data.steps.map((s) => ({ title: s.title, minutes: s.minutes, source: 'ai' }));
      renderSteps(true);
      say(`AI suggested ${formSteps.length} steps. Edit anything you like, then tap Save Plan.`, 'ok');
      toast('✨ AI study steps ready', `${formSteps.length} steps. Edit them, then Save Plan.`);
    } catch (e) {
      say(e.message + ' You can type your own steps with “+ Add step”.', 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ Suggest Study Steps';
    }
  });

  // ---------- Save plan ----------
  function resetForm() {
    editingId = null;
    $('assignmentForm').reset();
    formSteps = []; renderSteps();
    $('formTitle').textContent = 'New assignment';
    $('saveBtn').textContent = 'Save Plan';
    $('cancelEdit').hidden = true;
    $('deadline').min = state.today;
  }

  $('cancelEdit').addEventListener('click', () => { resetForm(); say(''); });

  $('assignmentForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const payload = {
      title: $('title').value.trim(),
      subject: $('subject').value.trim(),
      deadline: $('deadline').value,
      description: $('description').value.trim(),
      steps: formSteps.map((s) => ({ id: s.id, title: String(s.title || '').trim(), minutes: Number(s.minutes), source: s.source })),
    };
    // quick friendly checks (the server validates everything again)
    if (!payload.title) return say('Add the assignment name.', 'err');
    if (!payload.subject) return say('Add a subject (e.g. Math).', 'err');
    if (!payload.deadline) return say('Pick a deadline.', 'err');
    if (!payload.steps.length) return say('Add at least one study step, or tap ✨ Suggest Study Steps.', 'err');
    if (payload.steps.some((s) => !s.title)) return say('Every step needs a name.', 'err');
    if (payload.steps.some((s) => !Number.isInteger(s.minutes) || s.minutes < 5 || s.minutes > 600)) return say('Each step needs 5 to 600 minutes.', 'err');

    const btn = $('saveBtn'); btn.disabled = true;
    try {
      const data = editingId ? await api('PUT', `/api/assignments/${editingId}`, payload) : await api('POST', '/api/assignments', payload);
      state = data;
      const wasEdit = Boolean(editingId);
      resetForm();
      renderAll(data.savedId);
      const a = state.assignments.find((x) => x.id === data.savedId);
      if (a && a.risk === 'red') say(`Plan ${wasEdit ? 'updated' : 'saved'}, but ${mins(a.unscheduledMinutes)} won’t fit before the deadline. See the red warning.`, 'err');
      else say(`Plan ${wasEdit ? 'updated' : 'saved'}! Your steps are scheduled.`, 'ok');
      toast(a && a.risk === 'red' ? '⚠️ Plan saved, but it won’t all fit' : '✅ Plan saved', a ? `${a.title} · ${a.steps.length} steps scheduled` : '', a && a.risk === 'red' ? 'warn' : '');
    } catch (e) {
      say(e.message, 'err');
    } finally { btn.disabled = false; }
  });

  // ---------- Daily study time ----------
  $('saveDaily').addEventListener('click', async () => {
    const n = Number($('dailyMinutes').value);
    if (!Number.isInteger(n) || n < 10 || n > 720) { say('Study time must be 10 to 720 minutes per day.', 'err'); return; }
    try {
      state = await api('PUT', '/api/settings', { dailyMinutes: n });
      renderAll();
      say(`Updated to ${n} minutes per day. Your plan was rescheduled.`, 'ok');
    } catch (e) { say(e.message, 'err'); }
  });

  // ---------- Plan rendering ----------
  const RISK = {
    green: () => '🟢 On track',
    yellow: () => '🟡 Tight',
    red: (a) => `🔴 ${mins(a.unscheduledMinutes)} won’t fit`,
    overdue: () => '🔴 Deadline passed',
    done: () => '✅ Done',
  };

  function renderPlan(flashId) {
    const box = $('planList');
    if (!state.assignments.length) {
      box.innerHTML = '<p class="empty">No plans yet. Add an assignment, or tap <b>Load sample</b> to try it.</p>';
      return;
    }
    box.innerHTML = state.assignments.map((a) => {
      const dl = daysLeft(a.deadline);
      const due = dl === 0 ? 'today' : dl === 1 ? 'tomorrow' : dl < 0 ? `${-dl} days ago` : `in ${dl} days`;
      const steps = a.steps.map((s) => {
        const sess = (s.sessions || []).map((x) => `<span class="sess">${esc(fmtDay(x.date))} · ${mins(x.minutes)}</span>`).join('');
        const statusTxt = s.status === 'done' ? ' ✅'
          : s.status === 'partial' ? ` <span class="st partial">◐ ${mins(s.doneMinutes)} done</span>`
          : s.status === 'missed' ? ' <span class="st missed">✖ missed</span>' : '';
        const warn = s.unscheduledMinutes > 0 ? `<div class="wont-fit">⚠ ${mins(s.unscheduledMinutes)} won’t fit before the deadline</div>` : '';
        return `<li><div class="p-step-title">${esc(s.title)}${statusTxt}${s.source === 'ai' ? '<span class="tag-ai">AI</span>' : ''} <span class="muted">· ${mins(s.minutes)}</span></div>` +
          (sess ? `<div class="sessions">${sess}</div>` : '') + warn + '</li>';
      }).join('');
      return `<article class="assignment${a.id === flashId ? ' flash' : ''}" id="a-${esc(a.id)}">
        <div class="a-head">
          <div>
            <div class="a-title">${esc(a.title)}</div>
            <div class="a-meta"><span class="chip">${esc(a.subject)}</span> Due ${esc(fmtDay(a.deadline))} (${due}) · ${mins(a.remainingMinutes)} left</div>
          </div>
          <span class="risk ${esc(a.risk)}">${(RISK[a.risk] || RISK.green)(a)}</span>
        </div>
        <ol class="p-steps">${steps}</ol>
        <div class="a-actions">
          ${a.risk !== 'done' ? `<button class="btn mist small" type="button" data-focus="${esc(a.id)}">Open ${esc(a.subject)} Focus Room</button>` : ''}
          <button class="btn ghost small" type="button" data-edit="${esc(a.id)}">Edit</button>
          <button class="btn ghost small" type="button" data-del="${esc(a.id)}">Delete</button>
        </div>
      </article>`;
    }).join('');
    if (flashId) { const el = document.getElementById('a-' + flashId); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  }

  $('planList').addEventListener('click', async (ev) => {
    const edit = ev.target.closest('[data-edit]');
    const del = ev.target.closest('[data-del]');
    const foc = ev.target.closest('[data-focus]');
    if (foc && window.RKZFocus) {
      const a = state.assignments.find((x) => x.id === foc.dataset.focus);
      const step = a && a.steps.find((s) => s.status !== 'done');
      if (step) { showTab('focus'); window.RKZFocus.openTask(step.id); }
      return;
    }
    if (edit) {
      const a = state.assignments.find((x) => x.id === edit.dataset.edit);
      if (!a) return;
      editingId = a.id;
      $('title').value = a.title; $('subject').value = a.subject; $('deadline').value = a.deadline; $('description').value = a.description;
      $('deadline').min = a.deadline < state.today ? a.deadline : state.today;
      formSteps = a.steps.map((s) => ({ id: s.id, title: s.title, minutes: s.minutes, source: s.source }));
      renderSteps();
      $('formTitle').textContent = 'Edit assignment';
      $('saveBtn').textContent = 'Update Plan';
      $('cancelEdit').hidden = false;
      say('Editing — change anything, then tap Update Plan.');
      $('assignmentForm').scrollIntoView({ behavior: 'smooth' });
    }
    if (del) {
      if (del.dataset.confirm !== '1') { del.dataset.confirm = '1'; del.textContent = 'Tap again to delete'; del.classList.add('danger'); return; }
      try {
        state = await api('DELETE', `/api/assignments/${del.dataset.del}`);
        if (editingId === del.dataset.del) resetForm();
        renderAll(); say('Assignment deleted.', 'ok');
      } catch (e) { say(e.message, 'err'); }
    }
  });

  function renderAgenda() {
    const box = $('agenda');
    if (!state.agenda.length) { box.innerHTML = '<p class="empty">Your study days will show here.</p>'; return; }
    const names = {};
    for (const a of state.assignments) for (const s of a.steps) names[s.id] = { a, s };
    box.innerHTML = state.agenda.map((d) => {
      const used = d.items.reduce((t, i) => t + i.minutes, 0);
      const items = d.items.map((i) => {
        const n = names[i.stepId]; if (!n) return '';
        return `<li><b>${esc(n.a.subject)}</b> · ${esc(n.s.title)} — ${mins(i.minutes)}</li>`;
      }).join('');
      return `<div class="day"><div class="day-head"><span>${esc(fmtDay(d.date))}${d.date === state.today ? '<span class="today-tag">Today</span>' : ''}</span>` +
        `<span class="muted">${mins(used)} of ${mins(state.settings.dailyMinutes)}</span></div><ul>${items}</ul></div>`;
    }).join('');
  }

  function renderAll(flashId) {
    $('dailyMinutes').value = state.settings.dailyMinutes;
    $('deadline').min = editingId ? $('deadline').min : state.today;
    $('subjectList').innerHTML = state.channels.map((c) => `<option value="${esc(c.name)}"></option>`).join('');
    renderPlan(flashId);
    renderAgenda();
    renderDashboard();
    if (window.RKZFocus) window.RKZFocus.render();
  }

  // ---------- Dashboard ----------
  const SCENE_NAME = { plain: 'Plain', fireplace: 'Fireplace', ocean: 'Ocean', rain: 'Rain' };
  function renderDashboard() {
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuwait', hour: 'numeric', hour12: false }).format(new Date()));
    const first = (state.profile && state.profile.name ? state.profile.name.split(' ')[0] : '');
    $('greeting').textContent = (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening') + (first ? `, ${first}` : '');
    $('userName').textContent = state.profile && !state.profile.guest ? (state.profile.name || state.profile.username) : 'Guest';
    $('userBtn').textContent = state.profile && !state.profile.guest ? 'Log out' : 'Sign in';
    const open = state.assignments.filter((a) => a.risk !== 'done');
    $('statDue').textContent = open.filter((a) => a.deadline === state.today).length;
    $('statOverdue').textContent = open.filter((a) => a.deadline < state.today).length;
    const weekAgo = Date.now() - 7 * 86400000;
    const focusMin = Math.round(state.sessions.filter((s) => Date.parse(s.createdAt) >= weekAgo).reduce((t, s) => t + s.focusedSeconds, 0) / 60);
    $('statFocus').textContent = mins(focusMin);
    $('statDone').textContent = state.assignments.reduce((t, a) => t + a.steps.filter((s) => s.status === 'done').length, 0);

    const names = {};
    for (const a of state.assignments) for (const s of a.steps) names[s.id] = { a, s };
    const todayItems = [];
    for (const a of open.filter((x) => x.deadline < state.today)) {
      for (const s of a.steps.filter((x) => x.status !== 'done')) todayItems.push({ title: s.title, meta: `${a.subject} · Overdue` });
    }
    const today = state.agenda.find((d) => d.date === state.today);
    for (const i of (today ? today.items : [])) {
      const n = names[i.stepId]; if (!n) continue;
      todayItems.push({ title: n.s.title, meta: `${n.a.subject} · ${n.a.deadline === state.today ? 'Due today' : mins(i.minutes)}` });
    }
    $('dashToday').innerHTML = todayItems.length
      ? todayItems.slice(0, 5).map((t) => `<div class="item"><b>${esc(t.title)}</b><span>${esc(t.meta)}</span></div>`).join('')
      : '<p class="empty">Nothing planned for today. Add an assignment in the Study Planner.</p>';

    const upcoming = open.filter((a) => a.deadline >= state.today).slice(0, 4);
    $('dashDeadlines').innerHTML = upcoming.length
      ? upcoming.map((a) => `<div class="item"><b>${esc(a.title)}</b><span>${esc(fmtDay(a.deadline))} · ${esc(a.subject)}</span></div>`).join('')
      : '<p class="empty">No upcoming deadlines.</p>';

    $('dashChannels').innerHTML = state.channels.length
      ? state.channels.map((c) => `<span class="pill">${esc(c.name)} · ${SCENE_NAME[c.scene]} · ${c.focusMinutes} min</span>`).join('')
      : '<span class="muted">No channels yet.</span>';
  }
  $('openPlannerBtn').addEventListener('click', () => showTab('planner'));
  $('editChannelsBtn').addEventListener('click', () => showTab('focus'));

  // ---------- Tabs (deep-linkable: /#dashboard, /#planner, /#focus) ----------
  const TITLES = { dashboard: 'Dashboard', planner: 'Study Planner', focus: 'Focus Room', review: 'Progress Review' };
  function showTab(name) {
    const tabs = document.querySelectorAll('.tab[data-tab]');
    if (![...tabs].some((t) => t.dataset.tab === name)) name = 'dashboard';
    $('pageTitle').textContent = TITLES[name] || '';
    const SUBS = { planner: 'Plan your assignments around the time you actually have.', focus: 'Your subject, your setup.', review: 'Pick up where you left off.' };
    document.querySelector('.main-top').classList.toggle('big', name !== 'dashboard');
    $('pageSub').hidden = !SUBS[name];
    $('pageSub').textContent = SUBS[name] || '';
    $('openPlannerBtn').hidden = name !== 'dashboard';
    window.scrollTo(0, 0);
    tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== name; });
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  }
  document.querySelectorAll('.tab[data-tab]').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

  // Shared helpers for the other screens
  function toast(title, body, kind) {
    const box = $('toasts'); const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.innerHTML = `<b>${esc(title)}</b>${body ? `<span>${esc(body)}</span>` : ''}<button type="button" aria-label="Close">×</button>`;
    el.querySelector('button').addEventListener('click', () => el.remove());
    box.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 5200);
  }
  window.RKZ = {
    api, esc, mins, fmtDay, toast,
    get state() { return state; },
    setState(s) { state = s; renderAll(); },
    showTab,
  };

  // ---------- Start ----------
  (async function init() {
    showTab(location.hash.slice(1) || 'dashboard');
    renderSteps();
    try {
      state = await api('GET', '/api/state');
      renderAll();
      $('deadline').min = state.today;
    } catch (e) {
      say('Could not load your plan. Check your connection and refresh. (' + e.message + ')', 'err');
    }
  })();
})();
