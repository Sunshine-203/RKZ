// Apply saved theme before the page paints (avoids a flash).
(function () {
  var t = null;
  try { t = localStorage.getItem('rkz-theme'); } catch (e) {}
  if (!t) t = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
})();
