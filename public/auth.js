// RKZ login / sign up — optional. Guests can use everything; direct feature links skip this screen.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const R = () => window.RKZ;
  let mode = 'login';
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

  function setMode(m) {
    mode = m;
    document.querySelectorAll('[data-auth]').forEach((b) => b.classList.toggle('active', b.dataset.auth === m));
    $('nameWrap').hidden = m !== 'register';
    $('authSubmit').textContent = m === 'register' ? 'Create account' : 'Log in';
    $('authPass').autocomplete = m === 'register' ? 'new-password' : 'current-password';
    $('authMsg').textContent = '';
  }
  document.querySelectorAll('[data-auth]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.auth)));

  function show() { $('authScreen').hidden = false; setTimeout(() => $('authUser').focus(), 50); }
  function hide() { $('authScreen').hidden = true; }

  $('guestBtn').addEventListener('click', () => { store.set('rkz-entered', '1'); hide(); welcome(); });

  $('authForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = { username: $('authUser').value.trim(), password: $('authPass').value };
    if (mode === 'register') body.name = $('authName').value.trim();
    const msg = $('authMsg');
    if (mode === 'register' && !body.name) { msg.className = 'msg err'; msg.textContent = 'Add your name.'; return; }
    if (!body.username || !body.password) { msg.className = 'msg err'; msg.textContent = 'Enter your email (or username) and password.'; return; }
    $('authSubmit').disabled = true;
    try {
      const s = await R().api('POST', mode === 'register' ? '/api/auth/register' : '/api/auth/login', body);
      store.set('rkz-entered', '1');
      $('authPass').value = '';
      R().setState(s);
      hide();
      R().toast(mode === 'register' ? `Welcome, ${s.profile.name}! 🎉` : `Welcome back, ${s.profile.name || s.profile.username}!`, mode === 'register' ? 'Your plans are now saved to your account.' : 'Your plans are loaded.');
    } catch (e) {
      msg.className = 'msg err'; msg.textContent = e.message;
    } finally { $('authSubmit').disabled = false; }
  });

  $('userBtn').addEventListener('click', async () => {
    const st = R().state;
    if (st && st.profile && !st.profile.guest) {
      try { R().setState(await R().api('POST', '/api/auth/logout')); R().toast('Logged out', 'You are now a guest.'); setMode('login'); show(); } catch (e) { R().toast('Could not log out', e.message, 'warn'); }
    } else { setMode('register'); show(); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('authScreen').hidden && store.get('rkz-entered')) hide(); });

  function welcome() {
    const st = R().state; if (!st) return;
    const overdue = st.assignments.filter((a) => a.risk !== 'done' && a.deadline < st.today).length;
    const today = st.agenda.find((d) => d.date === st.today);
    const n = today ? today.items.length : 0;
    R().toast('☀️ Your study reminder',
      overdue ? `${overdue} overdue. Start with the smallest step.` : n ? `${n} study block${n > 1 ? 's' : ''} planned today. Take a deep breath, then begin.` : 'Plan your first assignment to get started.');
  }

  // first visit on the home page → show the login screen; feature links (#planner, #focus, #review) skip it for judges
  const wait = setInterval(() => {
    if (!R() || !R().state) return;
    clearInterval(wait);
    const deep = ['#planner', '#focus', '#review'].includes(location.hash);
    if (R().state.profile && !R().state.profile.guest) { welcome(); return; }
    if (!store.get('rkz-entered') && !deep) show(); else welcome();
  }, 100);
  setTimeout(() => clearInterval(wait), 15000);
})();
