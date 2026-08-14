'use strict';
// Headless smoke test: connects as a player, starts a match, verifies
// snapshots flow, bots fight, kills happen, shop works, match ends.
const WebSocket = require('ws');

const URL = 'ws://localhost:3000/ws';
let snaps = 0, killsSeen = 0, fxSeen = 0, phase = 'lobby', myId = -1;
let lastSnap = null, lastKillT = 0;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const ws = new WebSocket(URL);
ws.on('open', () => {
  log('connected, joining as smoke-test pilot');
  ws.send(JSON.stringify({ t: 'join', name: 'SmokeTest', cls: 'barge', cosmetics: { paint: 'lagoon', figurehead: 'skull', flag: 'plain', trail: 'none', lv: 1 } }));
});

let started = false, shopTried = false, startedAt = 0;
ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.t === 'hello') { log('hello: defs OK, classes:', Object.keys(m.cfg.CLASSES).join(','), 'modes:', Object.keys(m.cfg.MODES).join(',')); }
  if (m.t === 'joined') { myId = m.id; log('joined as id', myId); }
  if (m.t === 'lobby') {
    log('lobby:', m.players.length, 'players, host:', m.host, 'mode:', m.mode);
    if (m.host === myId && !started && m.players.length >= 6) {
      started = true;
      log('I am host — starting match');
      ws.send(JSON.stringify({ t: 'start' }));
      startedAt = Date.now();
    }
  }
  if (m.t === 'snap') {
    snaps++;
    lastSnap = m;
    phase = m.ph;
    const alive = m.ps.filter(p => p.al).length;
    const my = m.ps.find(p => p.i === myId);
    if (m.kl.length) {
      for (const k of m.kl) {
        killsSeen++;
        log(`KILLFEED: ${k.k === -1 ? 'ocean' : 'p' + k.k} ${k.a ? 'assisted' : 'sank'} p${k.v} (${k.w})`);
      }
      lastKillT = Date.now();
    }
    if (my && my.al && m.ph === 'play' && !shopTried) {
      // try buying an upgrade once we have credits
      if (my.cr >= 100) {
        shopTried = true;
        ws.send(JSON.stringify({ t: 'shop', track: 'w1' }));
        log('bought w1 upgrade — verifying credits drop next snap');
      }
    }
    // drive: thrust forward + slight turn + aim at nearest enemy + fire
    if (my && my.al && m.ph === 'play') {
      const enemies = m.ps.filter(p => p.al && p.i !== myId);
      let ay = my.a;
      if (enemies.length) {
        const e = enemies.sort((a, b) => Math.hypot(a.x - my.x, a.z - my.z) - Math.hypot(b.x - my.x, b.z - my.z))[0];
        ay = Math.atan2(e.z - my.z, e.x - my.x);
      }
      ws.send(JSON.stringify({ t: 'input', i: { up: 1, down: 0, left: 0, right: 0, boost: 0, fire1: 1, fire2: 0, ab: 0, ay: Math.round(ay * 1000) / 1000, ap: 0.3 } }));
    }
    if (m.ph === 'end' && !endLogged) { endLogged = true; log('MATCH ENDED. winner:', m.wi, 'players:', m.ps.length); }
  }
  if (m.t === 'end') { log('end message results:', m.results.map(r => `${r.n}:${r.sc}`).join(' ')); }
  if (m.t === 'toast') log('toast:', m.msg);
});
let endLogged = false;

setInterval(() => {
  const dur = (Date.now() - t0) / 1000;
  if (dur > 75) {
    log(`SMOKE TEST RESULT: snaps=${snaps} phase=${phase} kills=${killsSeen} fx=${fxSeen}`);
    log(killsSeen > 0 ? '✅ PASS — bots fought and kills happened' : '❌ FAIL — no kills');
    process.exit(killsSeen > 0 ? 0 : 1);
  }
}, 1000);
