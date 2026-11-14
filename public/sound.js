// RKZ ambient sound engine — 100% original audio generated live with the Web Audio API.
// Nothing plays until the student presses Start (browser autoplay rules + user control).
window.RKZSound = (function () {
  'use strict';
  let ctx = null, master = null, nodes = [], timers = [], muted = false, current = null;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function noise(kind, seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else d[i] = w;
    }
    return buf;
  }

  function loop(buf) {
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true; src.start();
    nodes.push(src);
    return src;
  }

  function filter(type, freq, q) {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; if (q) f.Q.value = q;
    nodes.push(f);
    return f;
  }

  function gain(v) { const g = ctx.createGain(); g.gain.value = v; nodes.push(g); return g; }

  function chain(...list) { for (let i = 0; i < list.length - 1; i++) list[i].connect(list[i + 1]); return list[list.length - 1]; }

  const scenes = {
    rain() {
      chain(loop(noise('white', 3)), filter('highpass', 500), filter('lowpass', 6000), gain(0.18), master);
      chain(loop(noise('brown', 4)), filter('lowpass', 900), gain(0.35), master);
      // individual drops
      const dropBuf = noise('white', 0.03);
      timers.push(setInterval(() => {
        if (Math.random() < 0.6) return;
        const s = ctx.createBufferSource(); s.buffer = dropBuf;
        const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2000 + Math.random() * 3000; f.Q.value = 3;
        const g = ctx.createGain(); g.gain.value = 0.05 + Math.random() * 0.1;
        s.connect(f).connect(g).connect(master); s.start();
      }, 40));
    },
    ocean() {
      const g = gain(0.25);
      chain(loop(noise('brown', 6)), filter('lowpass', 700), g, master);
      chain(loop(noise('white', 4)), filter('bandpass', 1500, 0.5), gain(0.04), g);
      // slow swell like waves
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.09;
      const depth = ctx.createGain(); depth.gain.value = 0.22;
      lfo.connect(depth).connect(g.gain); lfo.start();
      nodes.push(lfo, depth);
    },
    fireplace() {
      chain(loop(noise('brown', 5)), filter('lowpass', 350), gain(0.5), master);
      const crackle = noise('white', 0.02);
      timers.push(setInterval(() => {
        if (Math.random() < 0.55) return;
        const s = ctx.createBufferSource(); s.buffer = crackle;
        const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1500 + Math.random() * 2500;
        const g = ctx.createGain(); const t = ctx.currentTime; const peak = 0.08 + Math.random() * 0.25;
        g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05 + Math.random() * 0.08);
        s.connect(f).connect(g).connect(master); s.start();
      }, 70));
    },
  };

  function stop() {
    timers.forEach(clearInterval); timers = [];
    nodes.forEach((n) => { try { if (n.stop) n.stop(); } catch (e) {} try { n.disconnect(); } catch (e) {} });
    nodes = []; current = null;
    if (master) master.gain.value = 0;
  }

  function play(scene) {
    if (!scenes[scene]) { stop(); return; }
    if (!ensure()) return;
    if (current === scene) { setMuted(muted); return; }
    stop();
    current = scene;
    scenes[scene]();
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(0, t);
    master.gain.linearRampToValueAtTime(muted ? 0 : 0.7, t + 1.2); // gentle fade in
  }

  function setMuted(m) {
    muted = m;
    if (master && ctx) master.gain.setTargetAtTime(m || !current ? 0 : 0.7, ctx.currentTime, 0.15);
  }

  function chime() {
    if (!ensure()) return;
    [660, 880].forEach((f, i) => {
      const o = ctx.createOscillator(); const g = ctx.createGain(); const t = ctx.currentTime + i * 0.25;
      o.frequency.value = f; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 1);
    });
  }

  return { play, stop, setMuted, chime, get playing() { return current; } };
})();
