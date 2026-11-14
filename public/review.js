// RKZ Progress Review + AI Recovery: rebuild the plan from what actually happened.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const R = () => window.RKZ;
  let selected = null;   // session id
  let recSteps = [];     // [{title, minutes, source}]
  let recSource = 'manual';
  let recAI = { message: '', tip: '' };

  function say(text, kind, id = 'recMsg') { const el = $(id); el.className = 'msg' + (kind ? ' ' + kind : ''); el.textContent = text; }

  function stepInfo(stepId) {
    for (const a of R().state.assignments) for (const s of a.steps) if (s.id === stepId) return { a, s };
    return null;
  }

  function pending() {
    return R().state.sessions.filter((s) => !s.reviewed && s.outcome !== 'complete' && s.stepId && stepInfo(s.stepId) && stepInfo(s.stepId).s.status !== 'done');
  }

  // ---------- list ----------
  function renderList() {
    const { esc, mins } = R();
    const list = pending();
    const box = $('reviewList');
    if (!list.length) {
      box.innerHTML = '<p class="empty">Nothing to review. Log a <b>Partial</b> or <b>Missed</b> session in the Focus Room, or tap <b>Load sample</b>.</p>';
      if (selected && !list.some((s) => s.id === selected)) closePanel();
      return;
    }
    box.innerHTML = list.map((s) => {
      const { a } = stepInfo(s.stepId);
      const badge = s.outcome === 'partial' ? `<span class="st partial">◐ Partial · ${mins(s.doneMinutes)} done</span>` : '<span class="st missed">✖ Missed</span>';
      return `<button type="button" class="item review-item${s.id === selected ? ' active' : ''}" data-session="${esc(s.id)}">
        <b>${esc(s.stepTitle)}</b>
        <span>${esc(a.subject)} · ${esc(a.title)}</span>
        <span class="review-badges">${badge}</span>
        ${s.note ? `<span class="review-note">“${esc(s.note)}”</span>` : ''}
      </button>`;
    }).join('');
  }

  $('reviewList').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-session]'); if (!b) return;
    openSession(b.dataset.session);
  });

  $('reviewSampleBtn').addEventListener('click', async () => {
    try {
      R().setState(await R().api('POST', '/api/demo/review-sample'));
      const first = pending()[0];
      if (first) openSession(first.id);
      say('Sample loaded: a partial History session with a note. Tap ✨ Suggest Recovery Plan.', 'ok', 'reviewMsg');
    } catch (e) { say(e.message, 'err', 'reviewMsg'); }
  });

  // ---------- panel ----------
  function closePanel() {
    selected = null; recSteps = [];
    $('recoveryBody').hidden = true; $('recoveryEmpty').hidden = false;
  }

  function openSession(id) {
    const s = R().state.sessions.find((x) => x.id === id); if (!s) return;
    const info = stepInfo(s.stepId); if (!info) return;
    const { mins, fmtDay } = R();
    selected = id; recSteps = []; recSource = 'manual'; recAI = { message: '', tip: '' };
    const left = Math.max(0, info.s.minutes - info.s.doneMinutes);
    $('recStep').textContent = info.s.title;
    $('recMeta').textContent = ` ${info.a.subject} · ${info.a.title} · ${mins(info.s.doneMinutes)} of ${mins(info.s.minutes)} done · ${mins(left)} left · due ${fmtDay(info.a.deadline)}`;
    const o = $('recOutcome');
    o.className = 'st ' + (s.outcome === 'partial' ? 'partial' : 'missed');
    o.textContent = s.outcome === 'partial' ? '◐ Partial' : '✖ Missed';
    $('recNote').value = s.note || '';
    $('recSuggestion').hidden = true;
    say('');
    $('recoveryEmpty').hidden = true; $('recoveryBody').hidden = false;
    renderList();
    if (window.matchMedia('(max-width: 1000px)').matches) $('recoveryCard').scrollIntoView({ behavior: 'smooth' });
  }

  function renderRecSteps(animate) {
    const { esc, mins } = R();
    const list = $('recSteps');
    list.innerHTML = '';
    recSteps.forEach((s, i) => {
      const li = document.createElement('li');
      if (animate) { li.className = 'new'; li.style.animationDelay = (i * 80) + 'ms'; }
      li.innerHTML = `<span class="num">${i + 1}${s.source === 'ai' ? '<br><span class="tag-ai">AI</span>' : ''}</span>` +
        `<input type="text" maxlength="120" aria-label="Recovery step ${i + 1}" value="${esc(s.title)}">` +
        `<span class="min-wrap"><input type="number" min="5" max="600" step="5" inputmode="numeric" aria-label="Minutes for step ${i + 1}" value="${esc(s.minutes)}"></span>` +
        `<button type="button" class="del-step" aria-label="Remove step ${i + 1}">✕</button>`;
      const [t, m] = li.querySelectorAll('input');
      t.addEventListener('input', () => { s.title = t.value; });
      m.addEventListener('input', () => { s.minutes = m.value === '' ? '' : Number(m.value); total(); });
      li.querySelector('.del-step').addEventListener('click', () => { recSteps.splice(i, 1); renderRecSteps(); });
      list.appendChild(li);
    });
    total();
    function total() { $('recTotal').textContent = recSteps.length ? `· ${mins(recSteps.reduce((t, s) => t + (Number(s.minutes) || 0), 0))}` : ''; }
  }

  $('recAiBtn').addEventListener('click', async () => {
    if (!selected) return;
    const btn = $('recAiBtn');
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Thinking…';
    say('AI is reading your note and the unfinished work…');
    try {
      const r = await R().api('POST', '/api/ai/recovery', { sessionId: selected, note: $('recNote').value.trim() });
      recSteps = r.steps; recSource = 'ai'; recAI = { message: r.message || '', tip: r.tip || '' };
      $('recMessage').textContent = r.message || 'Here’s a recovery plan for the work that’s left.';
      $('recMessage').hidden = false;
      $('recTip').textContent = r.tip ? '💡 ' + r.tip : '';
      $('recSuggestion').hidden = false;
      renderRecSteps(true);
      say('Edit the steps if you like, then tap Accept & Replan.', 'ok');
    } catch (e) {
      say(e.message + ' You can still use “Replan without AI”.', 'err');
    } finally { btn.disabled = false; btn.textContent = '✨ Suggest Recovery Plan'; }
  });

  $('recManualBtn').addEventListener('click', () => {
    if (!selected) return;
    const s = R().state.sessions.find((x) => x.id === selected);
    const info = s && stepInfo(s.stepId); if (!info) return;
    const left = Math.max(5, info.s.minutes - info.s.doneMinutes);
    recSteps = [{ title: `Finish: ${info.s.title}`.slice(0, 120), minutes: Math.round(left / 5) * 5 || 5, source: 'manual' }];
    recSource = 'manual'; recAI = { message: '', tip: '' };
    $('recMessage').hidden = true; $('recTip').textContent = '';
    $('recSuggestion').hidden = false;
    renderRecSteps(true);
    say('The remaining time becomes one step. Edit it or tap Accept & Replan.', 'ok');
  });

  $('recApplyBtn').addEventListener('click', async () => {
    if (!selected) return;
    const steps = recSteps.map((s) => ({ title: String(s.title || '').trim(), minutes: Number(s.minutes), source: s.source }));
    if (!steps.length) return say('Keep at least one recovery step.', 'err');
    if (steps.some((s) => !s.title)) return say('Every step needs a name.', 'err');
    if (steps.some((s) => !Number.isInteger(s.minutes) || s.minutes < 5 || s.minutes > 600)) return say('Each step needs 5 to 600 minutes.', 'err');
    const btn = $('recApplyBtn'); btn.disabled = true;
    try {
      const s = await R().api('POST', '/api/recovery/apply', {
        sessionId: selected, steps, source: recSource, note: $('recNote').value.trim(), aiMessage: recAI.message, aiTip: recAI.tip,
      });
      closePanel();
      R().setState(s);
      R().toast('✅ Plan rebuilt', 'Finished work kept, new steps scheduled. See Before → After.');
      say('', '', 'reviewMsg');
      $('compareCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { say(e.message, 'err'); }
    finally { btn.disabled = false; }
  });

  // ---------- before / after ----------
  const RISK = { green: '🟢 On track', yellow: '🟡 Tight', red: '🔴 Won’t fit', overdue: '🔴 Deadline passed', done: '✅ Done' };
  function planCol(snap, newIds) {
    const { esc, mins, fmtDay } = R();
    if (!snap) return '<p class="empty">—</p>';
    const steps = snap.steps.map((s) => {
      const isNew = newIds && newIds.has(s.id);
      const status = s.status === 'done' ? '✅ ' : '';
      const sess = (s.sessions || []).map((x) => `<span class="sess">${esc(fmtDay(x.date))} · ${mins(x.minutes)}</span>`).join('');
      const warn = s.unscheduledMinutes > 0 ? `<div class="wont-fit">⚠ ${mins(s.unscheduledMinutes)} won’t fit</div>` : '';
      return `<li class="${isNew ? 'is-new' : ''}${s.status === 'done' ? ' is-done' : ''}">
        <div class="p-step-title">${status}${esc(s.title)} <span class="muted">· ${mins(s.status === 'done' ? s.doneMinutes : s.minutes - s.doneMinutes)}${s.status === 'done' ? ' done' : ' left'}</span>${isNew ? ' <span class="tag-new">NEW</span>' : ''}</div>
        ${sess ? `<div class="sessions">${sess}</div>` : ''}${warn}</li>`;
    }).join('');
    return `<div class="snap-head"><span class="risk ${esc(snap.risk)}">${RISK[snap.risk] || ''}</span>
      <span class="muted">${snap.finishDate ? 'Finishes ' + esc(fmtDay(snap.finishDate)) : ''}</span></div><ol class="p-steps">${steps}</ol>`;
  }

  function renderCompare() {
    const rev = R().state.revisions[0];
    const card = $('compareCard');
    if (!rev) { card.hidden = true; return; }
    const { esc, mins, fmtDay } = R();
    card.hidden = false;
    const beforeIds = new Set(rev.before.steps.map((s) => s.id));
    const newIds = new Set(rev.after.steps.filter((s) => !beforeIds.has(s.id)).map((s) => s.id));
    $('compareBefore').innerHTML = planCol(rev.before);
    $('compareAfter').innerHTML = planCol(rev.after, newIds);
    $('compareWhen').textContent = `${rev.source === 'ai' ? '✨ AI recovery' : 'Manual replan'} · ${new Date(rev.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    const b = rev.before, a = rev.after;
    const parts = [`<b>${esc(a.title)}</b> · due ${esc(fmtDay(a.deadline))}.`];
    const kept = a.steps.filter((s) => s.status === 'done').length;
    if (kept) parts.push(`${kept} completed step${kept > 1 ? 's' : ''} kept.`);
    if (newIds.size) parts.push(`${newIds.size} recovery step${newIds.size > 1 ? 's' : ''} added.`);
    if (a.unscheduledMinutes > 0) parts.push(`<span class="bad">⚠ ${mins(a.unscheduledMinutes)} won’t fit before the deadline. Add study time or ask for an extension.</span>`);
    else if (b.finishDate !== a.finishDate && a.finishDate) parts.push(`New finish: ${esc(fmtDay(a.finishDate))}.`);
    else parts.push('Everything still fits before the deadline. ✅');
    if (rev.aiMessage) parts.push(`<br><span class="ai-inline">“${esc(rev.aiMessage)}”</span>`);
    $('compareSummary').innerHTML = parts.join(' ');
  }

  window.RKZReview = {
    render() {
      if (!R() || !R().state) return;
      renderList(); renderCompare();
    },
  };

  // hook into the shared render
  const orig = window.RKZFocus && window.RKZFocus.render;
  if (window.RKZFocus) {
    window.RKZFocus.render = function () { orig.call(this); window.RKZReview.render(); };
  }
  window.RKZReview.render();
})();
