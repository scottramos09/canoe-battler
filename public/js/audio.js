'use strict';
// ============================================================
// CANOE ARENA — tiny WebAudio synth (no assets needed)
// ============================================================
let ctx = null, master = null, noiseBuf = null, muted = false;

export function initAudio() {
  if (ctx) { ctx.resume(); return; }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.35;
    master.connect(ctx.destination);
    // white noise buffer
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  } catch { /* audio unavailable */ }
}
export function toggleMute() { muted = !muted; if (master) master.gain.value = muted ? 0 : 0.35; return muted; }
export function isMuted() { return muted; }

function env(g, t0, a, peak, dec) {
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + dec);
}

function noise(t0, dur, peak, freq, q) {
  if (!ctx) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf; src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q || 1;
  const g = ctx.createGain();
  env(g, t0, 0.004, peak, dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t0); src.stop(t0 + dur + 0.1);
}

function tone(t0, dur, freq, peak, type = 'square', slide = 0) {
  if (!ctx) return;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t0 + dur);
  const g = ctx.createGain();
  env(g, t0, 0.005, peak, dur);
  o.connect(g); g.connect(master);
  o.start(t0); o.stop(t0 + dur + 0.1);
}

// ctx is null in headless/audio-less environments (TJAB validation, some
// VMs) — every SND method must tolerate it or the rAF loop dies on the
// first fx event (tone()/noise() already guard internally).
const now = () => (ctx ? ctx.currentTime : 0);

export const SND = {
  click() { tone(now(), 0.06, 660, 0.15, 'triangle'); },
  fire(kind) {
    const t = now();
    if (kind === 'rail') { tone(t, 0.12, 1400, 0.2, 'sawtooth', -900); }
    else if (kind === 'cannon' || kind === 'mortar') { noise(t, 0.3, 0.5, 220, 0.8); tone(t, 0.25, 90, 0.4, 'square', -40); }
    else if (kind === 'rocket') { noise(t, 0.5, 0.3, 600, 2); tone(t, 0.35, 300, 0.2, 'sawtooth', -150); }
    else if (kind === 'shot') { noise(t, 0.12, 0.3, 1800, 0.7); }
    else if (kind === 'torp') { tone(t, 0.3, 500, 0.15, 'sine', -300); }
    else { noise(t, 0.15, 0.25, 900, 0.6); }
  },
  boom(size) {
    const t = now();
    const s = Math.min(1.2, 0.35 + (size || 4) * 0.08);
    noise(t, 0.5 + s * 0.4, s, 160, 0.5);
    tone(t, 0.4, 70, s * 0.9, 'sine', -40);
  },
  blast() {
    // the barge's THUNDER SHOTGUN — short, BRIGHT bang. Raised pitch vs
    // the cannon boom per the user: "raise the pitch of the shotgun blast
    // a little" (tone 70→100 Hz, noise 160→420 Hz)
    noise(now(), 0.16, 0.5, 420, 0.8);
    tone(now(), 0.14, 100, 0.5, 'square', -45);
  },
  splash() { noise(now(), 0.25, 0.25, 900, 1.5); },
  hit() { tone(now(), 0.09, 240, 0.3, 'square', -120); },
  kill() { const t = now(); tone(t, 0.3, 520, 0.3, 'square'); tone(t + 0.09, 0.3, 780, 0.3, 'square'); },
  pickup(kind) {
    const t = now();
    if (kind === 'credits') { tone(t, 0.07, 880, 0.25, 'triangle'); tone(t + 0.07, 0.09, 1320, 0.25, 'triangle'); }
    else if (kind === 'heal') { tone(t, 0.12, 440, 0.2, 'sine'); tone(t + 0.12, 0.2, 660, 0.2, 'sine'); }
    else if (kind === 'upgrade') { tone(t, 0.08, 700, 0.3, 'triangle'); tone(t + 0.08, 0.12, 1050, 0.3, 'triangle'); tone(t + 0.16, 0.18, 1560, 0.3, 'triangle'); }
    else { tone(t, 0.08, 300, 0.25, 'sawtooth', 600); }
  },
  buy() { const t = now(); tone(t, 0.06, 990, 0.25, 'triangle'); tone(t + 0.06, 0.1, 1480, 0.25, 'triangle'); },
  boost() { noise(now(), 0.4, 0.2, 500, 2); },
  ability() { tone(now(), 0.25, 200, 0.25, 'sawtooth', 400); },
  count(n) { tone(now(), 0.15, n === 0 ? 880 : 440, 0.3, 'square'); },
  go() { const t = now(); tone(t, 0.4, 660, 0.35, 'square'); tone(t + 0.12, 0.5, 990, 0.35, 'square'); },
  horn() { const t = now(); tone(t, 0.8, 110, 0.3, 'sawtooth'); tone(t + 0.1, 0.8, 138, 0.3, 'sawtooth'); },
  win() { const t = now(); [523, 659, 784, 1047].forEach((f, i) => tone(t + i * 0.12, 0.25, f, 0.3, 'square')); },
  lose() { const t = now(); [400, 330, 262].forEach((f, i) => tone(t + i * 0.15, 0.3, f, 0.25, 'sawtooth')); },
  ram() { noise(now(), 0.3, 0.5, 300, 0.7); tone(now(), 0.25, 100, 0.4, 'square', -50); },
  levelup() { const t = now(); [523, 659, 784, 1047, 1319].forEach((f, i) => tone(t + i * 0.09, 0.2, f, 0.3, 'triangle')); },
  // ---- online-prep UI bites (title, lobby, chat, styles) ----
  chat() { const t = now(); tone(t, 0.09, 1180, 0.18, 'triangle'); tone(t + 0.07, 0.09, 1560, 0.16, 'triangle'); },
  send() { tone(now(), 0.07, 880, 0.18, 'triangle', 180); },
  join() { const t = now(); tone(t, 0.1, 660, 0.22, 'triangle'); tone(t + 0.1, 0.16, 990, 0.22, 'triangle'); },
  leave() { const t = now(); tone(t, 0.12, 520, 0.2, 'triangle', -120); tone(t + 0.12, 0.14, 392, 0.2, 'triangle', -120); },
  select() { const t = now(); tone(t, 0.06, 740, 0.2, 'triangle'); tone(t + 0.05, 0.08, 1108, 0.2, 'triangle'); },
  hover() { tone(now(), 0.04, 920, 0.07, 'triangle'); },
  unlock() { const t = now(); [880, 1175, 1568].forEach((f, i) => tone(t + i * 0.07, 0.16, f, 0.22, 'triangle')); },
};
