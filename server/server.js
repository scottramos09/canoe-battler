'use strict';
// ============================================================
// CANOE ARENA — server: static files + WebSocket + game loop
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Game } = require('./game');
const { BotBrain } = require('./bots');
const { PHYS, CLASSES, MODES, MAPS, CRATE_KINDS, BOT_NAMES } = require('./defs');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..', 'public');
const THREE_FILE = path.join(__dirname, '..', 'node_modules', 'three', 'build', 'three.module.js');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg',
};
const CACHE = {};
// mtime-revalidated cache: a long-lived dev server must serve the CURRENT
// files — an unconditional cache silently served stale JS/CSS for the whole
// session after any edit (the FFT ocean probes "still zero" ran against the
// pre-fix module because the server never re-read it)
function readCached(p) {
  const st = fs.statSync(p);
  const c = CACHE[p];
  if (c && c.mtimeMs === st.mtimeMs) return c.buf;
  const buf = fs.readFileSync(p);
  if (p.endsWith('.js') || p.endsWith('.css') || p.endsWith('.html')) CACHE[p] = { buf, mtimeMs: st.mtimeMs };
  return buf;
}

// ---------------- HTTP ----------------
const server = http.createServer((req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/admin/reset') {
      // Test-only: hard-reset the lobby (requires ALLOW_ADMIN=1 env).
      if (process.env.ALLOW_ADMIN !== '1') { res.writeHead(403); res.end('admin disabled'); return; }
      for (const [ws] of conns) { try { ws.close(); } catch { } }
      conns.clear();
      brains.clear();
      game = new Game();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'POST' && req.url === '/admin/start') {
      // Test-only: force the countdown (requires ALLOW_ADMIN=1 env).
      if (process.env.ALLOW_ADMIN !== '1') { res.writeHead(403); res.end('admin disabled'); return; }
      game.startCountdown();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'POST' && req.url === '/shot') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const b64 = body.split(',')[1] || body;
          const dir = path.join(__dirname, '..', 'shots');
          if (!fs.existsSync(dir)) fs.mkdirSync(dir);
          const f = path.join(dir, 'shot_' + Date.now() + '.png');
          fs.writeFileSync(f, Buffer.from(b64, 'base64'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, file: f }));
        } catch (e) { res.writeHead(500); res.end('bad'); }
      });
      return;
    }
    let url = req.url.split('?')[0];
    if (url === '/') url = '/index.html';
    let file;
    if (url === '/vendor/three.module.js') file = THREE_FILE;
    else file = path.join(ROOT, url);
    if (!file.startsWith(ROOT) && file !== THREE_FILE) { res.writeHead(403); res.end('nope'); return; }
    const ext = path.extname(file);
    const buf = readCached(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  } catch (e) {
    res.writeHead(404); res.end('not found');
  }
});

// ---------------- WebSocket ----------------
let game = new Game();
const brains = new Map(); // playerId -> BotBrain
const conns = new Map();  // ws -> playerId

// perMessageDeflate: snap JSON (repeated rounded floats + names) compresses
// ~4-6×, cutting per-client bandwidth from ~70 KB/s to ~15 KB/s — the ws
// module negotiates it automatically with browsers; threshold skips tiny
// messages where deflate overhead would lose.
const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: { threshold: 512 } });

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function fillBotsIfNeeded() {
  game.fillBots();
  for (const p of game.players.values()) {
    if (p.bot && !brains.has(p.id)) brains.set(p.id, new BotBrain(p));
  }
}

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const [ws] of conns) if (ws.readyState === 1) ws.send(s);
}

wss.on('connection', (ws) => {
  send(ws, { t: 'hello', cfg: { PHYS, CLASSES, MODES, MAPS, CRATE_KINDS, BOT_NAMES } });
  let myId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const p = game.players.get(myId);
    switch (msg.t) {
      case 'join': {
        if (myId !== null) return;
        const cosmetics = msg.cosmetics || {};
        const name = String(msg.name || 'Paddler').slice(0, 18) || 'Paddler';
        // kind: 'create' (host a lobby) | 'join' | 'practice' (solo-host
        // lobby, bots default ON, PRACTICE banner in the lobby UI)
        if (msg.kind === 'practice') { game.practice = true; game.botsOn = true; }
        const pl = game.addPlayer(name, msg.cls, cosmetics, false);
        myId = pl.id;
        conns.set(ws, myId);
        fillBotsIfNeeded();
        send(ws, { t: 'joined', id: myId, kind: msg.kind || 'join' });
        broadcast(game.lobbyInfo());
        break;
      }
      case 'leave': {
        // player quit: out of the match, back to title. In SINGLEPLAYER
        // (the leaver is the only human) the match ends immediately and the
        // game resets to a FRESH LOBBY — no ghost match to get stuck in when
        // they rejoin, no 480 s of bots grinding a match nobody watches.
        if (myId !== null) {
          const onlyHuman = ![...game.players.values()].some(p => !p.bot && p.id !== myId);
          game.removePlayer(myId);
          if (onlyHuman && (game.phase === 'play' || game.phase === 'countdown')) game.toLobby();
          if (![...game.players.values()].some(x => !x.bot)) { game.clearChat(); game.practice = false; } // lobby closed
          conns.delete(ws);
        }
        try { ws.close(); } catch { }
        break;
      }
      case 'input': {
        if (!p) return;
        const i = p.input;
        if (msg.i) {
          i.up = msg.i.up ? 1 : 0; i.down = msg.i.down ? 1 : 0;
          i.left = msg.i.left ? 1 : 0; i.right = msg.i.right ? 1 : 0;
          i.boost = msg.i.boost ? 1 : 0; i.fire1 = msg.i.fire1 ? 1 : 0;
          i.fire2 = msg.i.fire2 ? 1 : 0; i.ab = msg.i.ab ? 1 : 0;
          i.jump = msg.i.jump ? 1 : 0;
          if (typeof msg.i.ay === 'number') i.aimYaw = msg.i.ay;
          if (typeof msg.i.ap === 'number') i.aimPitch = msg.i.ap;
          if (typeof msg.i.st === 'number') i.steer = msg.i.st; else delete i.steer;
        }
        break;
      }
      case 'shop': {
        if (!p) return;
        const r = game.tryBuy(p, msg.track);
        if (!r.ok) send(ws, { t: 'toast', msg: r.why === 'max' ? 'Already maxed!' : r.why === 'credits' ? 'Not enough booty!' : 'Can\'t do that.' });
        break;
      }
      case 'host': {
        if (!p) return;
        // host-only: mode/map/diff (a stale auto-reconnected tab can hold
        // the host slot — the user's fresh window must still configure)
        if (p.id === hostId()) {
          if (msg.mode && MODES[msg.mode]) game.modeId = msg.mode;
          if (msg.map && MAPS[msg.map]) game.mapId = msg.map;
          if (msg.diff && ['low', 'med', 'high'].includes(msg.diff)) game.botDiff = msg.diff;
          // Add Bots? Yes/No + count — host-only (online-prep spec)
          if (typeof msg.botsOn === 'boolean') game.setBotsOn(msg.botsOn);
          if (typeof msg.bots === 'number') game.botTarget = Math.max(0, Math.min(PHYS.maxPlayers, Math.round(msg.bots)));
        }
        fillBotsIfNeeded();
        broadcast(game.lobbyInfo());
        break;
      }
      case 'class': {
        // canoe selection AFTER joining: swap the player's class in the lobby
        if (!p || game.phase !== 'lobby') return;
        if (!msg.cls || !CLASSES[msg.cls]) return;
        const def = CLASSES[msg.cls];
        p.cls = msg.cls; p.def = def;
        p.hp = def.hp; p.maxHp = def.hp;
        broadcast(game.lobbyInfo());
        break;
      }
      case 'chat': {
        // lobby-scoped chat — broadcast to everyone in THIS lobby only.
        // History lives in game.chat and dies with the lobby.
        if (!p) return;
        const text = String(msg.m || '').slice(0, 140).trim();
        if (!text) return;
        const e = game.chatMsg(p.name, text);
        broadcast({ t: 'chat', i: p.id, n: p.name, m: e.m });
        break;
      }
      case 'perf': {
        // PERF LOG — the client reports its frame stats every 10 s during a
        // match; each report appends one line to perf.log. After a test run
        // the log shows how fps/draws/textures/memory drift over the match
        // (late-match lag shows up as a climbing mem/tex with falling fps).
        // NOTE: the handler's message variable is `msg`, not `m` — the old
        // template referencing `m` threw a silent ReferenceError and the
        // whole log never wrote a line.
        const t = new Date().toISOString().slice(11, 19);
        try {
          fs.appendFileSync(path.join(__dirname, '..', 'perf.log'),
            `[${t}] phase=${game.phase} fps=${msg.fps} draws=${msg.draws} tris=${msg.tris} parts=${msg.parts} tex=${msg.tex} ql=${msg.ql || '?'} mem=${msg.mem} ps=${msg.ps} projs=${msg.projs}\n`);
        } catch (e) { console.log('perf append FAILED:', e.message); }
        break;
      }
      case 'start': {
        if (!p || p.id !== hostId()) return;
        if (game.phase === 'lobby' || game.phase === 'end' || game.phase === 'play') {
          // fresh match from ANY settled state (return-to-title → rejoin → start)
          fillBotsIfNeeded();
          game.startCountdown();
          broadcast(game.lobbyInfo());
          broadcast({ t: 'phase', ph: 'countdown', dur: PHYS.countdown, mode: game.modeId, map: game.mapId });
        }
        break;
      }
      case 'lobby': {
        if (p) send(ws, game.lobbyInfo());
        break;
      }
    }
  });

  ws.on('close', () => {
    if (myId !== null) {
      // same singleplayer rule as 'leave': when the last human disconnects
      // (refresh, tab close, crash) the match must NOT keep grinding — the
      // next join would be slammed into the old running match ("can't let go
      // of the old lobby"). Reset to a fresh lobby instead.
      const onlyHuman = ![...game.players.values()].some(p => !p.bot && p.id !== myId);
      game.removePlayer(myId);
      if (onlyHuman && (game.phase === 'play' || game.phase === 'countdown')) game.toLobby();
      if (![...game.players.values()].some(x => !x.bot)) { game.clearChat(); game.practice = false; } // lobby closed
      conns.delete(ws);
      brains.delete(myId);
      broadcast(game.lobbyInfo());
    }
  });
});

function hostId() {
  for (const [id, p] of game.players) if (!p.bot) return id;
  return null;
}

// ---------------- game loop (30 Hz) ----------------
let last = Date.now();
game.endSent = true;
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  // bots think
  for (const [pid, brain] of brains) {
    const p = game.players.get(pid);
    if (p) brain.think(dt, game);
  }
  const prevPhase = game.phase;
  game.update(dt);
  if (game.phase === 'end' && prevPhase !== 'end' && !game.endSent) {
    game.endSent = true;
    const results = [...game.players.values()]
      .map(p => ({ i: p.id, n: p.name, c: p.cls, sc: p.score, k: p.kills, d: p.deaths }))
      .sort((a, b) => b.sc - a.sc);
    broadcast({ t: 'end', results, wi: game.winnerId });
  }
  if (game.phase !== 'end') game.endSent = false;
  broadcast(game.snap());
}, 1000 / 30);

server.listen(PORT, () => {
  console.log(`🛶 CANOE ARENA running at http://localhost:${PORT}`);
  console.log(`   Open in 1+ browser tabs — first player is host. Bots fill the rest.`);
});
