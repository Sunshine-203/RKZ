// RKZ Focus Room — subject channels (tabs), immersive timer, editable channel defaults, outcomes.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const R = () => window.RKZ;
  const SCENE = { rain: 'Rain', ocean: 'Ocean', fireplace: 'Fireplace', plain: 'Plain' };
  const SOUND = { rain: 'Rainfall', ocean: 'Ocean waves', fireplace: 'Fireplace crackle' };
  const ICON = { rain: '🌧', ocean: '🌊', fireplace: '🔥', plain: '◻' };

  let activeChannel = null;      // channel id
  let current = null;            // step id
  let session = { scene: 'plain', soundOn: false, minutes: 25, breakMinutes: 5 };
  let mode = 'pomodoro';           // 'pomodoro' (focus + break cycles) or 'custom' (one timer)
  let draft = null;              // { name, scene, soundOn, minutes } — edit panel
  let timer = { status: 'idle', phase: 'focus', round: 1, remainingMs: 25 * 60000, endAt: 0, focusedMs: 0, lastTick: 0 };
  const baseTitle = document.title;

  const fmt = (ms) => {
    const t = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };
  const channels = () => R().state.channels;
  const channelById = (id) => channels().find((c) => c.id === id);
  function findStep(stepId) {
    for (const a of R().state.assignments) for (const s of a.steps) if (s.id === stepId) return { a, s };
    return null;
  }
  function openTasks(channelId) {
    const out = [];
    for (const a of R().state.assignments) {
      if (a.channelId !== channelId) continue;
      for (const s of a.steps) if (s.status !== 'done') out.push({ a, s, next: (s.sessions && s.sessions[0] && s.sessions[0].date) || '9999' });
    }
    return out.sort((x, y) => x.next.localeCompare(y.next) || x.a.deadline.localeCompare(y.a.deadline));
  }
  function say(id, text, kind) { const el = $(id); el.className = 'msg' + (kind ? ' ' + kind : ''); el.textContent = text; }
  const busy = () => timer.status === 'running' || timer.status === 'paused';
  const fromChannel = (c) => ({ scene: c.scene, soundOn: c.soundOn, minutes: c.focusMinutes, breakMinutes: session.breakMinutes || 5 });

  // ---------- channel tabs ----------
  function renderTabs() {
    const { esc } = R();
    $('channelTabs').innerHTML = channels().map((c) =>
      `<button type="button" role="tab" class="ch-tab${c.id === activeChannel ? ' active' : ''}" aria-selected="${c.id === activeChannel}" data-ch="${esc(c.id)}">${ICON[c.scene]} ${esc(c.name)}</button>`
    ).join('') + '<button type="button" class="ch-tab add" id="addChannelBtn">＋ New Channel</button>';
  }
  $('channelTabs').addEventListener('click', (ev) => {
    if (ev.target.closest('#addChannelBtn')) { $('newChannelForm').hidden = false; $('newChannelName').focus(); return; }
    const b = ev.target.closest('[data-ch]'); if (!b) return;
    selectChannel(b.dataset.ch);
  });

  function selectChannel(id, stepId) {
    if (busy() && id !== activeChannel) { say('channelMsg', 'Finish this session first: choose Complete, Partial or Missed.', 'err'); return; }
    say('channelMsg', '');
    activeChannel = id;
    const c = channelById(id);
    draft = c ? { name: c.name, ...fromChannel(c) } : null;
    if (!busy()) {
      session = c ? fromChannel(c) : session;
      const tasks = openTasks(id);
      current = stepId || (tasks[0] && tasks[0].s.id) || null;
      resetTimer();
    }
    $('roomNote').textContent = c ? `Loaded ${c.name}’s saved setup.` : '';
    renderAll();
  }

  $('newChannelCancel').addEventListener('click', () => { $('newChannelForm').hidden = true; });
  $('newChannelForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const name = $('newChannelName').value.trim();
    if (!name) return say('channelMsg', 'Type a channel name first, e.g. Physics.', 'err');
    try {
      const s = await R().api('POST', '/api/channels', { name, scene: 'plain', soundOn: false, focusMinutes: 25 });
      $('newChannelName').value = ''; $('newChannelForm').hidden = true;
      R().setState(s);
      const c = channels().find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (c) selectChannel(c.id);
      say('channelMsg', `Added “${name}”. Choose its background, sound and length on the right, then Save as channel default.`, 'ok');
    } catch (e) { say('channelMsg', e.message, 'err'); }
  });

  $('focusSampleBtn').addEventListener('click', async () => {
    if (busy()) return say('channelMsg', 'Finish this session first.', 'err');
    try {
      R().setState(await R().api('POST', '/api/demo/focus-sample'));
      const math = channels().find((c) => c.name === 'Math');
      if (math) selectChannel(math.id);
      say('channelMsg', 'Math (Plain · 50 min) and Biology (Rain · 25 min) are ready. Switch between the tabs to see each setup load.', 'ok');
    } catch (e) { say('channelMsg', e.message, 'err'); }
  });

  // ---------- edit panel ----------
  function renderEdit() {
    const c = channelById(activeChannel);
    $('editEmpty').hidden = Boolean(c); $('editBody').hidden = !c;
    $('editTitle').textContent = c ? `Edit ${c.name}` : 'Edit channel';
    if (!c || !draft) return;
    if (document.activeElement !== $('editName')) $('editName').value = draft.name;
    if (document.activeElement !== $('editMinutes')) $('editMinutes').value = draft.minutes;
    document.querySelectorAll('#scenePicker [data-scene]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.scene === draft.scene)));
    const sb = $('editSound');
    if (draft.scene === 'plain') { sb.textContent = 'Sound: silent (Plain)'; sb.disabled = true; }
    else { sb.disabled = false; sb.textContent = draft.soundOn ? `Sound: ${SOUND[draft.scene]}` : 'Sound: off'; }
    sb.setAttribute('aria-pressed', String(draft.soundOn));
    $('saveDefaultsBtn').textContent = `Save as ${c.name} default`;
  }
  document.querySelectorAll('#scenePicker [data-scene]').forEach((b) => b.addEventListener('click', () => {
    if (!draft) return;
    draft.scene = b.dataset.scene;
    if (draft.scene !== 'plain' && !draft.soundOn) draft.soundOn = true;
    session.scene = draft.scene; session.soundOn = draft.soundOn;
    renderEdit(); applyRoom(); syncSound();
    say('editMsg', 'Showing now for this session. Tap “Save as default” to keep it for this subject.');
  }));
  $('editSound').addEventListener('click', () => { if (!draft) return; draft.soundOn = !draft.soundOn; session.soundOn = draft.soundOn; renderEdit(); applyRoom(); syncSound(); });
  $('editName').addEventListener('input', () => { if (draft) draft.name = $('editName').value; });
  $('editMinutes').addEventListener('input', () => {
    const n = Number($('editMinutes').value);
    if (draft && Number.isInteger(n) && n >= 5 && n <= 180) {
      draft.minutes = n;
      if (!busy()) { session.minutes = n; resetTimer(); applyRoom(); }
    }
  });
  $('editBreak').addEventListener('input', () => {
    const n = Number($('editBreak').value);
    if (Number.isInteger(n) && n >= 1 && n <= 30) { session.breakMinutes = n; applyRoom(); }
  });
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    if (busy()) { say('editMsg', 'Reset or finish the session to switch mode.', 'err'); return; }
    mode = b.dataset.mode; resetTimer(); applyRoom();
  }));
  $('resetBtn').addEventListener('click', () => { resetTimer(); applyRoom(); syncSound(); renderTasks(); });

  $('useSessionBtn').addEventListener('click', () => {
    if (!draft) return;
    session.scene = draft.scene; session.soundOn = draft.soundOn;
    if (!busy()) { session.minutes = draft.minutes; resetTimer(); }
    applyRoom(); syncSound();
    say('editMsg', busy() ? 'Applied to this session (length stays until the session ends).' : 'Applied to this session only. The channel default is unchanged.', 'ok');
  });

  $('saveDefaultsBtn').addEventListener('click', async () => {
    const c = channelById(activeChannel); if (!c || !draft) return;
    const n = Number($('editMinutes').value);
    if (!Number.isInteger(n) || n < 5 || n > 180) return say('editMsg', 'Focus duration must be 5 to 180 minutes.', 'err');
    const name = draft.name.trim();
    if (!name) return say('editMsg', 'Channel name is required.', 'err');
    try {
      const s = await R().api('PUT', `/api/channels/${c.id}`, { name, scene: draft.scene, soundOn: draft.soundOn, focusMinutes: n });
      session.scene = draft.scene; session.soundOn = draft.soundOn;
      if (!busy()) { session.minutes = n; resetTimer(); }
      R().setState(s);
      syncSound();
      say('editMsg', `✓ Saved as ${name}’s default. It will load every time you open a ${name} task.`, 'ok');
    } catch (e) { say('editMsg', e.message, 'err'); }
  });

  // ---------- tasks ----------
  function renderTasks() {
    const { esc, mins } = R();
    const c = channelById(activeChannel);
    $('taskListTitle').textContent = c ? `Tasks in ${c.name}` : 'Tasks';
    const tasks = c ? openTasks(c.id) : [];
    const box = $('taskList');
    if (!c) box.innerHTML = '<p class="empty">No channels yet. Tap <b>Load sample</b> or <b>＋ New Channel</b>.</p>';
    else if (!tasks.length) box.innerHTML = `<p class="empty">No open ${esc(c.name)} tasks. Plan one in the Study Planner with subject “${esc(c.name)}”.</p>`;
    else box.innerHTML = tasks.slice(0, 12).map(({ a, s }) => {
      const left = Math.max(0, s.minutes - (s.doneMinutes || 0));
      const badge = s.status === 'partial' ? ' <span class="st partial">◐ partial</span>' : s.status === 'missed' ? ' <span class="st missed">✖ missed</span>' : '';
      const on = current === s.id;
      return `<div class="task${on ? ' active' : ''}"><div><b>${esc(s.title)}</b>${badge}<span>${esc(a.title)} · ${mins(left)} left</span></div>
        <button class="btn ${on ? 'ghost' : 'mist'} small" type="button" data-open="${esc(s.id)}">${on ? 'Open now' : 'Open'}</button></div>`;
    }).join('');

    const pick = $('taskPick');
    $('taskPickWrap').hidden = true;
    pick.innerHTML = tasks.length ? '' : '<option value="">No task linked</option>';
    pick.innerHTML += tasks.map(({ s }) => `<option value="${esc(s.id)}"${s.id === current ? ' selected' : ''}>${esc(s.title)}</option>`).join('');
    pick.disabled = busy();
  }
  $('taskList').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-open]'); if (!b) return;
    openTask(b.dataset.open);
    $('room').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('taskPick').addEventListener('change', () => { if ($('taskPick').value) openTask($('taskPick').value); });

  function openTask(stepId) {
    const f = findStep(stepId); if (!f) return;
    if (busy() && stepId !== current) { say('channelMsg', 'Finish this session first: choose Complete, Partial or Missed.', 'err'); return; }
    if (f.a.channelId !== activeChannel) { selectChannel(f.a.channelId, stepId); return; }
    current = stepId;
    const c = channelById(f.a.channelId);
    if (c && !busy()) { session = fromChannel(c); resetTimer(); }
    renderAll();
  }

  // ---------- room ----------
  function applyRoom() {
    const c = channelById(activeChannel);
    const f = current && findStep(current);
    $('room').dataset.scene = session.scene;
    $('roomLabel').textContent = c ? `${c.name} — ${SCENE[session.scene]}` : 'No channel yet';
    $('phaseLabel').textContent = mode === 'custom' ? '⏱ Custom timer' : timer.phase === 'break' ? `☕ Break · ${session.breakMinutes} min` : `⏱ Focus · Session ${timer.round}`;
    $('phaseLabel').classList.toggle('break', timer.phase === 'break');
    document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    $('resetBtn').disabled = !c || timer.status === 'idle';
    const today = R().state.today;
    const n = R().state.sessions.filter((x) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuwait' }).format(new Date(x.createdAt)) === today).length;
    $('sessionsToday').textContent = `${n} session${n === 1 ? '' : 's'} logged today${timer.round > 1 ? ` · ${timer.round - 1} pomodoro${timer.round > 2 ? 's' : ''} done` : ''}`;
    $('roomTask').textContent = f ? f.s.title : c ? `No open ${c.name} tasks yet` : 'Tap “Load sample” or “+ New Channel” to start.';
    const silent = session.scene === 'plain';
    const mb = $('muteBtn');
    mb.disabled = !c || silent;
    mb.textContent = silent ? '🔇 Silent' : session.soundOn ? '🔈 Mute' : '🔊 Unmute';
    mb.setAttribute('aria-pressed', String(!session.soundOn));
    $('startBtn').disabled = !c;
    $('startBtn').textContent = timer.status === 'running' ? '❚❚ Pause' : timer.status === 'paused' ? '▷ Resume' : timer.phase === 'break' ? '▷ Start break' : '▷ Start';
    document.querySelectorAll('[data-outcome]').forEach((b) => { b.disabled = !f; });
    $('timerState').textContent = { idle: timer.phase === 'break' ? 'Break time. Stretch, drink water.' : f ? 'Ready' : (c ? 'Ready · link a task to log the outcome' : 'Create a channel to start'), running: timer.phase === 'break' ? 'On break…' : 'Focusing…', paused: 'Paused', finished: 'Time’s up!' }[timer.status];
    drawTime();
  }
  function drawTime() {
    $('timer').textContent = fmt(timer.remainingMs);
    document.title = timer.status === 'running' ? `${fmt(timer.remainingMs)} · RKZ Focus` : baseTitle;
  }
  function syncSound() {
    if (timer.status === 'running' && session.soundOn && session.scene !== 'plain') { window.RKZSound.setMuted(false); window.RKZSound.play(session.scene); }
    else window.RKZSound.stop();
  }
  $('muteBtn').addEventListener('click', () => { session.soundOn = !session.soundOn; applyRoom(); syncSound(); });

  // ---------- timer ----------
  function resetTimer() { timer = { status: 'idle', phase: 'focus', round: 1, remainingMs: session.minutes * 60000, endAt: 0, focusedMs: 0, lastTick: 0 }; }
  function pauseNow() {
    if (timer.status !== 'running') return;
    const now = Date.now(); timer.remainingMs = timer.endAt - now; if (timer.phase === 'focus') timer.focusedMs += now - timer.lastTick; timer.status = 'paused';
  }
  $('startBtn').addEventListener('click', () => {
    if (timer.status === 'running') pauseNow();
    else if (timer.status === 'finished' && mode === 'pomodoro') return;
    else {
      if (timer.status === 'finished') resetTimer();
      const now = Date.now(); timer.status = 'running'; timer.endAt = now + timer.remainingMs; timer.lastTick = now;
    }
    applyRoom(); syncSound(); renderTasks();
  });
  setInterval(() => {
    if (timer.status !== 'running') return;
    const now = Date.now();
    if (timer.phase === 'focus') timer.focusedMs += now - timer.lastTick;
    timer.lastTick = now;
    timer.remainingMs = timer.endAt - now;
    if (timer.remainingMs <= 0) {
      window.RKZSound.chime();
      if (mode === 'pomodoro' && timer.phase === 'focus') {
        // focus round done -> automatic break
        timer.phase = 'break'; timer.remainingMs = session.breakMinutes * 60000; timer.endAt = now + timer.remainingMs;
        $('roomNote').textContent = `Session ${timer.round} done! Enjoy a ${session.breakMinutes}-minute break.`;
        R().toast('☕ Break time', `Session ${timer.round} done. Stretch and drink water for ${session.breakMinutes} min.`);
        applyRoom(); syncSound(); return;
      }
      if (mode === 'pomodoro' && timer.phase === 'break') {
        // break done -> next focus round, waits for Start
        timer.phase = 'focus'; timer.round += 1; timer.status = 'paused'; timer.remainingMs = session.minutes * 60000;
        window.RKZSound.stop();
        $('roomNote').textContent = `Break over. Ready for session ${timer.round}? Or log the outcome below.`;
        applyRoom(); return;
      }
      timer.remainingMs = 0; timer.status = 'finished';
      window.RKZSound.stop();
      applyRoom(); openOutcome('complete');
      return;
    }
    drawTime();
  }, 250);

  $('fullBtn').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if ($('room').requestFullscreen) $('room').requestFullscreen().catch(() => {});
  });

  // ---------- outcome ----------
  document.querySelectorAll('[data-outcome]').forEach((b) => b.addEventListener('click', () => {
    pauseNow(); applyRoom(); syncSound();
    openOutcome(b.dataset.outcome);
  }));
  function openOutcome(kind) {
    const f = findStep(current); if (!f) return;
    const focusedMin = Math.round(timer.focusedMs / 60000);
    $('outcomeTask').textContent = `${f.a.subject} · ${f.s.title}`;
    document.querySelectorAll('#outcomeForm input[name=outcome]').forEach((r) => { r.checked = r.value === kind; });
    $('doneMinutes').value = Math.max(1, Math.min(focusedMin || Math.round(session.minutes / 2), session.minutes));
    $('outcomeNote').value = '';
    say('outcomeMsg', '');
    toggleDone();
    $('outcomeModal').hidden = false;
    document.querySelector('#outcomeForm input[name=outcome]:checked').focus();
  }
  function toggleDone() {
    const v = (document.querySelector('#outcomeForm input[name=outcome]:checked') || {}).value;
    $('doneWrap').hidden = v !== 'partial';
  }
  document.querySelectorAll('#outcomeForm input[name=outcome]').forEach((r) => r.addEventListener('change', toggleDone));
  $('outcomeCancel').addEventListener('click', () => { $('outcomeModal').hidden = true; if (timer.status === 'finished') { timer.status = 'paused'; applyRoom(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('outcomeModal').hidden) $('outcomeCancel').click(); });

  $('outcomeForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const outcome = (document.querySelector('#outcomeForm input[name=outcome]:checked') || {}).value;
    if (!outcome) return say('outcomeMsg', 'Choose Complete, Partial or Missed.', 'err');
    const doneMinutes = Number($('doneMinutes').value);
    if (outcome === 'partial' && (!Number.isInteger(doneMinutes) || doneMinutes < 1)) return say('outcomeMsg', 'Enter how many minutes you got done.', 'err');
    const body = {
      stepId: current, outcome, scene: session.scene, soundOn: session.soundOn,
      plannedMinutes: session.minutes, focusedSeconds: Math.round(timer.focusedMs / 1000),
      doneMinutes: outcome === 'complete' ? session.minutes : outcome === 'partial' ? doneMinutes : 0,
      note: $('outcomeNote').value.trim(),
    };
    try {
      const s = await R().api('POST', '/api/sessions', body);
      $('outcomeModal').hidden = true;
      window.RKZSound.stop();
      const label = { complete: '✅ Complete', partial: `◐ Partial · ${doneMinutes} min done`, missed: '✖ Missed' }[outcome];
      timer.status = 'idle';
      if (outcome === 'complete') current = null;
      R().setState(s);
      if (!current) { const t = openTasks(activeChannel); current = t[0] ? t[0].s.id : null; }
      const c = channelById(activeChannel); if (c) { session = fromChannel(c); draft = { name: c.name, ...fromChannel(c) }; }
      resetTimer(); renderAll();
      $('roomNote').textContent = outcome === 'complete' ? `Saved: ${label}. Nice work!` : `Saved: ${label}. Review it in Progress Review to replan.`;
      R().toast(outcome === 'complete' ? '🎉 Session complete' : 'Session saved', outcome === 'complete' ? 'Nice work! One step closer.' : 'Open Progress Review to get an AI recovery plan.');
    } catch (e) { say('outcomeMsg', e.message, 'err'); }
  });

  // ---------- render ----------
  function renderAll() { renderTabs(); renderEdit(); renderTasks(); applyRoom(); }

  window.RKZFocus = {
    render() {
      if (!R() || !R().state) return;
      const list = channels();
      if (!list.some((c) => c.id === activeChannel)) {
        activeChannel = null; draft = null;
        if (list[0]) { selectChannel(list[0].id); return; }
      }
      const c = channelById(activeChannel);
      if (c && draft && !busy() && document.activeElement !== $('editName')) draft.name = draft.name || c.name;
      if (current && !findStep(current)) { current = null; if (!busy()) resetTimer(); }
      renderAll();
    },
    openTask,
  };
  window.RKZFocus.render();
})();
