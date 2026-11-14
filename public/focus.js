// RKZ Focus Room — subject channels with saved setups, timer, outcomes.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const R = () => window.RKZ;
  const SCENES = { fireplace: '🔥 Fireplace', ocean: '🌊 Ocean', rain: '🌧 Rain', plain: '◻ Plain' };

  let current = null;          // { stepId, channelId }
  let session = { scene: 'plain', soundOn: false, minutes: 25 };
  let timer = { status: 'idle', remainingMs: 25 * 60000, endAt: 0, focusedMs: 0, lastTick: 0 };
  let editingChannel = null;
  const baseTitle = document.title;

  // ---------- helpers ----------
  const fmt = (ms) => {
    const t = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };
  function findStep(stepId) {
    for (const a of R().state.assignments) for (const s of a.steps) if (s.id === stepId) return { a, s };
    return null;
  }
  const channelById = (id) => R().state.channels.find((c) => c.id === id);
  function say(id, text, kind) { const el = $(id); el.className = 'msg' + (kind ? ' ' + kind : ''); el.textContent = text; }
  const sceneLabel = (c) => `${SCENES[c.scene]} · ${c.scene === 'plain' ? 'silent' : c.soundOn ? '🔊 sound' : '🔇 muted'} · ${c.focusMinutes} min`;

  // ---------- channels ----------
  function renderChannels() {
    const { esc } = R();
    const list = R().state.channels;
    const box = $('channelList');
    if (!list.length) { box.innerHTML = '<p class="empty">No channels yet. Tap <b>Load sample</b>, or add one below.</p>'; return; }
    box.innerHTML = list.map((c) => {
      if (editingChannel === c.id) {
        return `<form class="channel editing" data-id="${esc(c.id)}">
          <label class="field">Name <input name="name" maxlength="40" value="${esc(c.name)}"></label>
          <div class="row2">
            <label class="field">Background
              <select name="scene">${Object.keys(SCENES).map((k) => `<option value="${k}"${k === c.scene ? ' selected' : ''}>${SCENES[k]}</option>`).join('')}</select>
            </label>
            <label class="field">Focus (min) <input name="focusMinutes" type="number" min="5" max="180" step="5" value="${c.focusMinutes}"></label>
          </div>
          <label class="check"><input name="soundOn" type="checkbox"${c.soundOn ? ' checked' : ''}> Play background sound</label>
          <div class="actions"><button class="btn primary small" type="submit">Save channel</button><button class="btn ghost small" type="button" data-cancel>Cancel</button></div>
        </form>`;
      }
      const active = current && current.channelId === c.id ? ' active' : '';
      return `<div class="channel${active}" data-id="${esc(c.id)}">
        <div><b>${esc(c.name)}</b><span>${sceneLabel(c)}</span></div>
        <button class="btn ghost small" type="button" data-edit>Edit</button>
      </div>`;
    }).join('');
  }

  $('channelList').addEventListener('click', (ev) => {
    const card = ev.target.closest('[data-id]'); if (!card) return;
    if (ev.target.closest('[data-edit]')) { editingChannel = card.dataset.id; renderChannels(); card && $('channelList').querySelector('input[name=name]').focus(); }
    if (ev.target.closest('[data-cancel]')) { editingChannel = null; renderChannels(); }
  });

  $('channelList').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const body = {
      name: f.name.value.trim(), scene: f.scene.value, soundOn: f.soundOn.checked, focusMinutes: Number(f.focusMinutes.value),
    };
    if (!body.name) return say('channelMsg', 'Channel name is required.', 'err');
    if (!Number.isInteger(body.focusMinutes) || body.focusMinutes < 5 || body.focusMinutes > 180) return say('channelMsg', 'Focus length must be 5 to 180 minutes.', 'err');
    try {
      const id = f.dataset.id;
      const s = await R().api('PUT', `/api/channels/${id}`, body);
      editingChannel = null;
      R().setState(s);
      if (current && current.channelId === id && timer.status === 'idle') loadChannelSetup();
      say('channelMsg', `Saved “${body.name}”.`, 'ok');
    } catch (e) { say('channelMsg', e.message, 'err'); }
  });

  $('newChannelForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const name = $('newChannelName').value.trim();
    if (!name) return say('channelMsg', 'Type a channel name first, e.g. Physics.', 'err');
    try {
      R().setState(await R().api('POST', '/api/channels', { name, scene: 'plain', soundOn: false, focusMinutes: 25 }));
      $('newChannelName').value = '';
      say('channelMsg', `Added “${name}”. Tap Edit to choose its background, sound and length.`, 'ok');
    } catch (e) { say('channelMsg', e.message, 'err'); }
  });

  $('focusSampleBtn').addEventListener('click', async () => {
    try {
      R().setState(await R().api('POST', '/api/demo/focus-sample'));
      say('channelMsg', 'Math (Plain · 50 min) and Biology (Rain · 25 min) are ready. Open a Math task, then a Biology task.', 'ok');
    } catch (e) { say('channelMsg', e.message, 'err'); }
  });

  // ---------- tasks ----------
  function renderTasks() {
    const { esc, mins } = R();
    const rows = [];
    for (const a of R().state.assignments) {
      for (const s of a.steps) {
        if (s.status === 'done') continue;
        rows.push({ a, s, next: (s.sessions && s.sessions[0] && s.sessions[0].date) || '9999' });
      }
    }
    rows.sort((x, y) => x.next.localeCompare(y.next) || x.a.deadline.localeCompare(y.a.deadline));
    const box = $('taskList');
    if (!rows.length) { box.innerHTML = '<p class="empty">No open tasks. Tap <b>Load sample</b> above, or plan an assignment in the Study Planner.</p>'; return; }
    box.innerHTML = rows.slice(0, 12).map(({ a, s }) => {
      const ch = channelById(a.channelId);
      const left = Math.max(0, s.minutes - (s.doneMinutes || 0));
      const badge = s.status === 'partial' ? ' <span class="st partial">◐ partial</span>' : s.status === 'missed' ? ' <span class="st missed">✖ missed</span>' : '';
      const on = current && current.stepId === s.id;
      return `<div class="task${on ? ' active' : ''}">
        <div><b>${esc(s.title)}</b>${badge}<span>${esc(a.subject)} · ${ch ? SCENES[ch.scene] : ''} · ${mins(left)} left</span></div>
        <button class="btn ${on ? 'ghost' : 'mist'} small" type="button" data-open="${esc(s.id)}">${on ? 'Open' : 'Open'}</button>
      </div>`;
    }).join('');
  }

  $('taskList').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-open]'); if (!b) return;
    if (timer.status === 'running' || timer.status === 'paused') {
      say('channelMsg', 'Finish this session first: tap ■ End and save the outcome.', 'err');
      return;
    }
    openTask(b.dataset.open);
    if (window.matchMedia('(max-width: 900px)').matches) $('room').scrollIntoView({ behavior: 'smooth' });
  });

  function openTask(stepId) {
    const found = findStep(stepId); if (!found) return;
    current = { stepId, channelId: found.a.channelId };
    loadChannelSetup();
    renderTasks(); renderChannels();
  }

  function loadChannelSetup() {
    const ch = channelById(current.channelId);
    session = ch ? { scene: ch.scene, soundOn: ch.soundOn, minutes: ch.focusMinutes } : { scene: 'plain', soundOn: false, minutes: 25 };
    resetTimer();
    applyRoom();
  }

  // ---------- room ----------
  function differsFromDefault() {
    const ch = current && channelById(current.channelId);
    return ch && (ch.scene !== session.scene || ch.soundOn !== session.soundOn || ch.focusMinutes !== session.minutes);
  }

  function applyRoom() {
    const room = $('room');
    room.dataset.scene = session.scene;
    document.querySelectorAll('.scene-picker [data-scene]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.scene === session.scene)));
    const found = current && findStep(current.stepId);
    const ch = current && channelById(current.channelId);
    $('roomChannel').textContent = ch ? ch.name : 'No task open';
    $('roomTask').textContent = found ? found.s.title : 'Open a task to load its subject’s setup.';
    $('roomMinutes').value = session.minutes;
    $('roomMinutes').disabled = timer.status !== 'idle' || !current;
    const silent = session.scene === 'plain';
    const mb = $('muteBtn');
    mb.disabled = !current || silent;
    mb.textContent = silent ? '🔇 Plain is silent' : session.soundOn ? '🔊 Sound on' : '🔇 Muted';
    mb.setAttribute('aria-pressed', String(!session.soundOn));
    $('startBtn').disabled = !current;
    $('endBtn').disabled = !current || timer.status === 'idle';
    $('startBtn').textContent = timer.status === 'running' ? '❚❚ Pause' : timer.status === 'paused' ? '▶ Resume' : '▶ Start';
    $('timerState').textContent = { idle: current ? 'Ready' : 'Pick a task', running: 'Focusing…', paused: 'Paused', finished: 'Time’s up!' }[timer.status];
    const changed = differsFromDefault();
    $('saveDefaultsBtn').disabled = !changed;
    $('saveDefaultsBtn').textContent = ch ? `Save as ${ch.name} default` : 'Save as channel default';
    $('roomNote').textContent = changed
      ? 'Changed for this session only. Tap “Save as default” to keep it for next time.'
      : (ch ? `Loaded ${ch.name}’s saved setup.` : 'Changes apply to this session only, unless you save them as the channel’s default.');
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

  document.querySelectorAll('.scene-picker [data-scene]').forEach((b) => b.addEventListener('click', () => {
    if (!current) return;
    session.scene = b.dataset.scene;
    applyRoom(); syncSound();
  }));

  $('muteBtn').addEventListener('click', () => { session.soundOn = !session.soundOn; applyRoom(); syncSound(); });

  $('roomMinutes').addEventListener('input', () => {
    const n = Number($('roomMinutes').value);
    if (Number.isInteger(n) && n >= 5 && n <= 180) { session.minutes = n; resetTimer(); applyRoom(); }
  });

  $('saveDefaultsBtn').addEventListener('click', async () => {
    const ch = current && channelById(current.channelId); if (!ch) return;
    try {
      R().setState(await R().api('PUT', `/api/channels/${ch.id}`, { scene: session.scene, soundOn: session.soundOn, focusMinutes: session.minutes }));
      applyRoom();
      $('roomNote').textContent = `✓ Saved as ${ch.name}’s new default.`;
    } catch (e) { $('roomNote').textContent = e.message; }
  });

  // ---------- timer ----------
  function resetTimer() { timer = { status: 'idle', remainingMs: session.minutes * 60000, endAt: 0, focusedMs: 0, lastTick: 0 }; }

  $('startBtn').addEventListener('click', () => {
    const now = Date.now();
    if (timer.status === 'running') {          // pause
      timer.remainingMs = timer.endAt - now; timer.focusedMs += now - timer.lastTick; timer.status = 'paused';
    } else {                                   // start or resume
      if (timer.status === 'finished') resetTimer();
      timer.status = 'running'; timer.endAt = now + timer.remainingMs; timer.lastTick = now;
    }
    applyRoom(); syncSound();
  });

  $('endBtn').addEventListener('click', () => {
    if (timer.status === 'running') { const now = Date.now(); timer.remainingMs = timer.endAt - now; timer.focusedMs += now - timer.lastTick; timer.status = 'paused'; }
    applyRoom(); syncSound();
    const focusedMin = Math.round(timer.focusedMs / 60000);
    openOutcome(timer.focusedMs < 60000 ? 'missed' : focusedMin >= session.minutes ? 'complete' : 'partial', Math.max(1, focusedMin));
  });

  setInterval(() => {
    if (timer.status !== 'running') return;
    const now = Date.now();
    timer.focusedMs += now - timer.lastTick; timer.lastTick = now;
    timer.remainingMs = timer.endAt - now;
    if (timer.remainingMs <= 0) {
      timer.remainingMs = 0; timer.status = 'finished';
      window.RKZSound.stop(); window.RKZSound.chime();
      applyRoom();
      openOutcome('complete', session.minutes);
      return;
    }
    drawTime();
  }, 250);

  $('fullBtn').addEventListener('click', () => {
    const room = $('room');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (room.requestFullscreen) room.requestFullscreen().catch(() => {});
  });

  // ---------- outcome ----------
  function openOutcome(kind, doneMin) {
    const found = findStep(current.stepId);
    $('outcomeTask').textContent = found ? `${found.a.subject} · ${found.s.title}` : '';
    document.querySelectorAll('#outcomeForm input[name=outcome]').forEach((r) => { r.checked = r.value === kind; });
    $('doneMinutes').value = doneMin;
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
      stepId: current.stepId, outcome, scene: session.scene, soundOn: session.soundOn,
      plannedMinutes: session.minutes, focusedSeconds: Math.round(timer.focusedMs / 1000),
      doneMinutes: outcome === 'complete' ? session.minutes : outcome === 'partial' ? doneMinutes : 0,
      note: $('outcomeNote').value.trim(),
    };
    try {
      const s = await R().api('POST', '/api/sessions', body);
      $('outcomeModal').hidden = true;
      window.RKZSound.stop();
      const label = { complete: '✅ Complete', partial: `◐ Partial · ${doneMinutes} min done`, missed: '✖ Missed' }[outcome];
      const stillOpen = outcome !== 'complete';
      R().setState(s);
      if (stillOpen && findStep(current.stepId)) { resetTimer(); applyRoom(); }
      else { current = null; resetTimer(); applyRoom(); }
      renderTasks(); renderChannels();
      $('roomNote').textContent = `Saved: ${label}. You can see it on the task in the Study Planner.`;
    } catch (e) { say('outcomeMsg', e.message, 'err'); }
  });

  // ---------- public ----------
  window.RKZFocus = {
    render() {
      if (!R() || !R().state) return;
      if (current && !findStep(current.stepId)) { current = null; resetTimer(); }
      renderChannels(); renderTasks(); applyRoom();
    },
  };
  window.RKZFocus.render();
})();
