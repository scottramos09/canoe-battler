'use strict';
// ============================================================
// CANOE ARENA — main: boot, game loop, orchestration
// ============================================================
import * as THREE from 'three';
import { createGame, setPaintDefs, setFlagDefs, setTrailDefs } from './render.js';
import { createNet } from './net.js';
import { initInput, getInputState, computeAim, setDbgCmd, mouseScreen, getGamepad, getActiveDevice, gpDebug } from './input.js';
import { initUI } from './ui.js';
import { initAudio, toggleMute, SND, isMuted } from './audio.js';
import { solvePitch, waveH, MUZZLE_Y } from './ballistics.js';
import * as prof from './profile.js';

const params = new URLSearchParams(location.search);
const AUTO = params.has('auto');

prof.initAccounts(); // seed the test/test account (idempotent)
if (AUTO && !prof.currentUser()) prof.login('test', 'test'); // debug auto-path
const profData = prof.loadProfile();
setPaintDefs(prof.PAINTS);
setFlagDefs(prof.FLAGS);
setTrailDefs(prof.TRAILS);

const canvas = document.getElementById('c');
const game = createGame(canvas);
const net = createNet(callbacks());
const ui = initUI(actions());
ui.renderControlTips('kbm');
// login gate: a saved session goes straight to the title; otherwise the
// login screen sits over the menu until the player signs in
if (prof.currentUser()) ui.hideLogin(); else ui.showLogin();

// state
const state = {
  joined: false, myId: -1, cls: 'razorfin', cosmetics: profData.sel,
  phase: 'lobby', prevPhase: 'lobby', started: false,
  spectateIdx: 0, spectateTargets: [],
  lastCountN: -1, shakeT: 0, lastRemote: new Map(), lastTurn: new Map(),
  uiTimer: 0, endShown: false, dpUpPrev: false, dpDownPrev: false, gpScoreboard: false,
};
state.cosmetics.lv = prof.levelFromXp(profData.xp).level;

let input = { up: 0, down: 0, left: 0, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, ay: 0, ap: 0 };
let muted = false;
let keyTab = false;
let lastT = performance.now();

// ---------------- net callbacks ----------------
function callbacks() {
  return {
    status(msg) {
      ui.el.connMsg.textContent = msg;
      if (msg.startsWith('Connected') && state.joined) {
        // re-join after reconnect (net resends join itself)
      }
    },
    hello(cfg) {
      game.setMap(cfg.MAPS.lagoon);
      ui.showMenu(cfg);
      if (AUTO) {
        setTimeout(() => {
          if (!state.joined) doJoin();
          setTimeout(() => { if (net.myId === ui.UI.hostId) net.start(); }, 2500);
        }, 600);
      }
    },
    joined(id) {
      state.myId = id;
      state.joined = true;
      ui.UI.myId = id;
      game.setMyId(id);
      // title view → lobby view (canoe cards + crew + chat + style drawer)
      ui.setJoinedView(true);
      ui.setLobbyVisible(true);
      ui.showMenu(net.defs);
    },
    chat(c) {
      ui.chatMsg(c.n, c.m, c.i === state.myId);
    },
    lobby(l) {
      ui.renderLobby(l);
      if (l.phase === 'countdown' || l.phase === 'play') {
        // AA transition: the menu dissolves out as the battle begins
        ui.transition(() => ui.el.menu.classList.add('hidden'));
      }
      else ui.setHudVisible(false);
    },
    phase(m) {
      // countdown broadcast
      ui.UI.mode = m.mode; ui.UI.map = m.map;
      state.phase = 'countdown';
    },
    snap(snap) {
      const now = performance.now();
      // map rebuild on change
      if (snap.map && ui.UI.map !== snap.map && snap.ph !== 'lobby') {
        ui.UI.map = snap.map;
        game.setMap(net.defs.MAPS[snap.map]);
      }
      // fx
      for (const f of net.drainFx()) {
        game.handleFx(f);
        if (f.f === 'boom' || f.f === 'ram') {
          const own = net.own();
          if (own && own.alive) {
            const d = Math.hypot(f.x - own.x, f.z - own.z);
            if (d < 18) rumble(0.5, 0.4, 200);
            if (d < 48) SND.boom(f.f === 'ram' ? 3 : (f.s || 5));
          }
        }
        if (f.f === 'splash') {
          const own = net.own();
          if (own && own.alive) {
            const d = Math.hypot(f.x - own.x, f.z - own.z);
            if (d < 30) SND.splash();
          }
        }
        if (f.f === 'blast') {
          const own = net.own();
          if (own && own.alive) {
            const d = Math.hypot(f.x - own.x, f.z - own.z);
            if (d < 48) SND.blast();
          }
        }
        if (f.f === 'cannonFire') {
          // CANNON COVE battery: distant boom (distance-gated like the others)
          const own = net.own();
          if (own && own.alive) {
            const d = Math.hypot(f.x - own.x, f.z - own.z);
            if (d < 55) SND.fire('cannon');
          }
        }
        if (f.f === 'pickup') SND.pickup(f.k);
        if (f.f === 'hit') {
          if (f.v === state.myId) {
            ui.hitmark(); SND.hit(); rumble(0.85, 0.6, 260);
            // screen shake ONLY when the player TAKES damage — scaled by the
            // damage amount and capped (user: "inconsistent with who is taking
            // damage… higher damage should shake more, but only up to a point")
            game.shake(Math.min(0.3, 0.08 + (f.d || 0) * 0.0022));
          }
          else if (f.a === state.myId) { rumble(0.3, 0.2, 120); }
        }
      }
      // killfeed
      for (const k of net.drainKills()) {
        k.ps = snap.ps;
        ui.killfeed(k);
        if (k.v === state.myId) { SND.kill(); rumble(0.7, 0.5, 300); }
        if (k.k === state.myId) {
          // assists don't play the kill sound / shake — only a small nudge
          if (k.a) rumble(0.3, 0.2, 120);
          else { SND.kill(); rumble(1.0, 0.9, 550); }
        }
      }
      // countdown display
      if (snap.ph === 'countdown') {
        const n = Math.ceil(net.defs.PHYS.countdown - snap.spc);
        if (n !== state.lastCountN) {
          state.lastCountN = n;
          ui.countdown(String(Math.max(0, n)), 'GET READY');
          SND.count(n);
        }
      } else if (snap.ph === 'play' && state.phase !== 'play') {
        ui.countdown('GO!', '');
        SND.go();
        ui.hideDeath();
        state.lastCountN = -1;
      }
      state.phase = snap.ph;
      // match over → never stay paused
      if (snap.ph === 'lobby' || snap.ph === 'end') {
        if (state.paused) { state.paused = false; ui.hidePause(); ui.setHudVisible(false); }
      }
      // never let the menu block the match (belt & braces on top of lobby msg)
      if (snap.ph === 'countdown' || snap.ph === 'play') {
        ui.el.menu.classList.add('hidden');
        ui.el.connecting.classList.add('hidden');
        ui.setHudVisible(true);
      }
      // end-of-match screen
      if (snap.ph === 'end' && !state.endShown) {
        state.endShown = true;
        onEnd(snap);
      }
      if (snap.ph !== 'end') state.endShown = false;
      // spectate target list
      state.spectateTargets = snap.ps.filter(p => p.al && p.i !== state.myId).map(p => p.i);
      if (state.spectateIdx >= state.spectateTargets.length) state.spectateIdx = 0;
    },
    end(m) {
      // results come via snap phase 'end'; m has results
      state.endResults = m.results;
    },
    toast(msg) { ui.toast(msg); },
  };
}

// ---------------- UI actions ----------------
function actions() {
  return {
    getDefs: () => net.defs,
    selectClass(c) { state.cls = c; net.setClass(c); },
    setMode(m) { net.hostMode(m); },
    setMap(m) { net.hostMap(m); },
    setDiff(d) { net.hostDiff(d); },
    setBots(n) { net.hostBots(n); },
    hostBotsOn(v) { net.hostBotsOn(v); SND.click(); },
    join(kind) {
      SND.click();
      const p = prof.getProfile();
      state.cosmetics = { ...p.sel, lv: prof.levelFromXp(p.xp).level };
      net.join(p.name || 'Paddler', state.cls, state.cosmetics, kind);
    },
    joinLobby() {
      SND.click();
      const p = prof.getProfile();
      state.cosmetics = { ...p.sel, lv: prof.levelFromXp(p.xp).level };
      net.join(p.name || 'Paddler', state.cls, state.cosmetics, 'join');
    },
    chat(text) { net.chat(text); if (SND.send) SND.send(); },
    canoeImage(def) { return game.canoeImage(def, 0); },
    weaponImage(def) { return game.weaponImage(def); },
    clipFrame(def, t, canvas) { game.classClipFrame(def, t, canvas); },
    cosmeticPreview(def, cosmetics, canvas) { game.cosmeticPreview(def, cosmetics, canvas); },
    startMatch() { net.start(); SND.go(); },
    buy(track) { net.buy(track); SND.click(); },
    toLobby() { ui.hideEnd(); },
    cosmeticChanged() {
      const p = prof.getProfile();
      state.cosmetics = { ...p.sel, lv: prof.levelFromXp(p.xp).level };
      ui.buildCosmetics();
    },
    spectateNext(dir) { state.spectateIdx = (state.spectateIdx + dir + state.spectateTargets.length) % Math.max(1, state.spectateTargets.length); },
    // pause/exit — the UI (ESC, pause buttons, gamepad Start) calls these
    mute() { muted = toggleMute(); return muted; },
    togglePause() {
      if (!state.joined || (state.phase !== 'play' && state.phase !== 'countdown')) return;
      state.paused = !state.paused;
      if (state.paused) { ui.showPause(); ui.setHudVisible(false); }
      else { ui.hidePause(); ui.setHudVisible(true); }
    },
    leaveMatch() {
      state.paused = false;
      state.joined = false;
      // AA transition: fade to black, swap to the title underneath
      ui.transition(() => {
        ui.UI.myId = -1; // full title reset — back to CREATE/JOIN/PRACTICE
        ui.hidePause();
        ui.setLobbyVisible(false); // the lobby view hides back to the title
        ui.setJoinedView(false);
        try { net.leave(); } catch { }
        ui.updateLaunchButton(state.phase); // back to the title view
        ui.msg('Returning to title…');
      });
    },
  };
}

function doJoin(kind = 'join') {
  const p = prof.getProfile();
  state.cosmetics = { ...p.sel, lv: prof.levelFromXp(p.xp).level };
  net.join(p.name || 'Paddler', state.cls, state.cosmetics, kind);
}

// ---------------- end of match / XP ----------------
function onEnd(snap) {
  const defs = net.defs;
  const rows = [...snap.ps].sort((a, b) => b.sc - a.sc);
  const results = (state.endResults || []).map(r => {
    const p = snap.ps.find(x => x.i === r.i) || {};
    return { i: r.i, n: r.n, c: defs.CLASSES[r.c] ? `${defs.CLASSES[r.c].icon} ${defs.CLASSES[r.c].name}` : r.c, sc: r.sc, k: r.k };
  }).sort((a, b) => b.sc - a.sc);
  if (!results.length) {
    for (const r of rows) {
      const cls = defs.CLASSES[r.c];
      results.push({ i: r.i, n: r.n, c: cls ? cls.icon + ' ' + cls.name : r.c, sc: r.sc, k: r.k });
    }
  }
  const myRank = Math.max(0, results.findIndex(r => r.i === state.myId));
  const win = snap.wi === state.myId;
  const own = snap.ps.find(p => p.i === state.myId) || { k: 0, sc: 0 };
  const rankBonus = [120, 80, 50, 20][Math.min(3, myRank)] || 10;
  const base = 40, kxp = own.k * 20, sxp = Math.round(own.sc / 10);
  const xp = base + kxp + sxp + (win ? 120 : rankBonus);
  const rec = prof.recordMatch({ kills: own.k, win, streak: own.k }); // streak approx
  const { leveled, newLevel, unlocks } = prof.addXp(xp);
  if (leveled) { SND.levelup(); }
  // AA transition: fade the battle out, then raise the results screen
  ui.transition(() => { ui.showEnd(results, { xp, base, kxp, win, rkxp: win ? 0 : rankBonus, unlocks }, myRank, win); });
  if (win) SND.win(); else SND.lose();
  state.endShown = true;
}

// ---------------- input & aiming ----------------
// predicted ballistic arc for the aim-line (mirrors server integration)
function computeAimPath(own, w1) {
  const defs = net.defs;
  const pts = [];
  const g = w1.grav || 24, dt = 0.08;
  const cy = Math.cos(own.ty), sy = Math.sin(own.ty);
  const cp = Math.cos(own.tp), sp = Math.sin(own.tp);
  // start at the barrel tip (matches server muzzle: the barrel pivots at the
  // mount, so the tip is mount + cos(pitch)*tip ahead, sin(pitch)*tip up —
  // `tip`/`tipY` are measured from the built weapon meshes)
  const tz = 3.3 * defs.CLASSES[own.cls].size * 0.2;
  const tip = w1.tip || w1.barrelLen || 1.5;
  const tipY = w1.tipY ?? 0.25;
  let x = own.x + cy * (tz + cp * tip);
  let y = own.y + MUZZLE_Y + (tipY - 0.25) + sp * tip;
  let z = own.z + sy * (tz + cp * tip);
  let vx = cy * cp * w1.spd, vy = sp * w1.spd, vz = sy * cp * w1.spd;
  pts.push([x, y, z]);
  // integrate the FULL flight (shell life), not a fixed 1.6 s: a fixed
  // time cap pinned the reticle at ~176 u (spd 110) and hid the real
  // landing — the barge's long reach never showed on the impact X
  const life = w1.life || 8;
  for (let t = 0; t < life; t += dt) {
    vy -= g * dt;
    x += vx * dt; y += vy * dt; z += vz * dt;
    pts.push([x, y, z]);
    if (y <= 0) break;
  }
  return pts;
}

// vibration — throttled + guaranteed stop.
// Some platforms (Windows/Xbox controllers under Chromium) ignore the effect
// duration and keep the motor spinning until the next playEffect/reset — so
// every pulse schedules a forced motor-off. The cooldown stops rapid-fire
// weapons from turning haptics into a continuous buzz.
let lastRumbleT = -1;
function vibrationStop() {
  // Synchronous hard-stop — MUST be callable from focus/visibility events:
  // Chromium re-applies the last vibration effect when the page regains
  // focus, and setTimeout stops get throttled while the tab is unfocused.
  try {
    const gp = navigator.getGamepads && navigator.getGamepads()[0];
    if (gp && gp.vibrationActuator) {
      if (gp.vibrationActuator.reset) gp.vibrationActuator.reset();
      else if (gp.vibrationActuator.playEffect) {
        gp.vibrationActuator.playEffect('dual-rumble', { startDelay: 0, duration: 1, strongMagnitude: 0, weakMagnitude: 0 });
      }
    }
  } catch { }
}
document.addEventListener('visibilitychange', () => { vibrationStop(); if (!document.hidden) vibrationStop(); });
window.addEventListener('blur', vibrationStop);
window.addEventListener('pagehide', vibrationStop);
vibrationStop(); // clear any stale motor state at boot
function rumble(strong, weak, ms) {
  const now = performance.now();
  if (now - lastRumbleT < 90) return;
  lastRumbleT = now;
  try {
    const gp = navigator.getGamepads && navigator.getGamepads()[0];
    if (gp && gp.vibrationActuator && gp.vibrationActuator.playEffect) {
      gp.vibrationActuator.playEffect('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: strong, weakMagnitude: weak });
      setTimeout(() => {
        try {
          const g2 = navigator.getGamepads && navigator.getGamepads()[0];
          if (g2 && g2.vibrationActuator && g2.vibrationActuator.playEffect) {
            g2.vibrationActuator.playEffect('dual-rumble', { startDelay: 0, duration: 1, strongMagnitude: 0, weakMagnitude: 0 });
          }
        } catch { }
      }, ms + 30);
    }
  } catch { }
}

function buildInput(dt, camYaw) {
  const own = net.own();
  let input;
  if (!own || !own.alive || state.phase !== 'play' || own.spectating) {
    input = { up: 0, down: 0, left: 0, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, jump: 0, ay: own ? own.ang : 0, ap: 0 };
    return input;
  }
  const raw = getInputState({ x: own.x, z: own.z, a: own.ang }, camYaw);
  const defs = net.defs;
  const w1 = defs.CLASSES[own.cls].w1.tiers[own.w[0]];
  // smooth the wave-bob out of our own height so the pitch solve doesn't jitter
  if (state.smoothY === undefined) state.smoothY = own.y;
  state.smoothY += (own.y - state.smoothY) * Math.min(1, 0.15);
  let ay = own.ang, ap = 0;
  // ---- PERSISTENT STICKY AIM ----
  // The turret direction (yaw + elevation) is a held target: it moves ONLY
  // while you input and never drifts back toward the bow or a resting spot.
  // Mouse deltas steer it; the gamepad right stick sets it absolutely.
  const msNow = mouseScreen();
  if (state.lastMX === undefined) { state.lastMX = msNow.x; state.lastMY = msNow.y; }
  const mdx = msNow.x - state.lastMX;
  const mdy = msNow.y - state.lastMY;
  state.lastMX = msNow.x; state.lastMY = msNow.y;
  const mouseMoving = Math.hypot(mdx, mdy) > 0.4;
  if (state.aimYaw === undefined) state.aimYaw = own.ang;
  if (state.aimHsm === undefined) state.aimHsm = 0;
  // device ownership for the AIM: the last-used device holds the aim for a
  // 4 s window (so a released stick never snaps the pitch back, and an idle
  // gamepad never hijacks the cursor). Mouse movement hands it to the cursor.
  const gpUsing = !!raw.gpAimTurn || (raw.gpPitch !== undefined && Math.abs(raw.gpPitch) > 0.15);
  const nowMs = performance.now();
  const mouseMoved = Math.abs(mdx) > 0.5 || Math.abs(mdy) > 0.5;
  if (mouseMoved) state.gpAimT = -1e9;
  const gpAimActive = gpUsing || (nowMs - (state.gpAimT || -1e9)) < 4000;
  let mouseAim = null;
  if (raw.gpAimTurn) {
    // gamepad horizontal: hold to rotate the aim through the full 360°
    // (~2.2 s per revolution — deliberate, turret-like)
    state.aimYaw += raw.gpAimTurn * 2.8 * dt;
    state.gpAimT = nowMs;
  } else if (!gpAimActive) {
    // MOUSE: the reticle follows the cursor — the aim is the ray from the
    // camera through the cursor to the water (absolute, every frame)
    mouseAim = computeAim(own.x, own.z);
    if (mouseAim) state.aimYaw = mouseAim.aim;
  }
  if (raw.gpPitch !== undefined && Math.abs(raw.gpPitch) > 0.15) {
    // gamepad: ABSOLUTE stick elevation — the stick directly owns where the
    // aim sits (fast EMA; the linear rate limit below provides the weight)
    const aimH = Math.max(-1, Math.min(1, raw.gpPitch));
    state.aimHsm += (aimH - state.aimHsm) * Math.min(1, 20 * dt);
    state.gpAimT = nowMs;
  }
  state.gpAimActive = gpAimActive;
  ay = state.aimYaw;
  // base pitch: waterline solve at the aim range — mouse: the cursor's water
  // point; gamepad: fixed engage range (the elevation stick dials the arc).
  // NO auto-aim: no enemy-range scanning, no magnets — the player owns the
  // aim entirely.
  // ray-miss (cursor above the horizon while aiming at a distant target)
  // must lob toward max range — the old flat 60 u default read as "a gun".
  // (theta(d) = asin(d/maxRange)/2: the arc look lives in the RANGE
  //  FRACTION, so maxRange 300 gives real cannon arcs at arena ranges)
  let d = w1.maxRange || 60;
  if (mouseAim) d = Math.hypot(mouseAim.worldX - own.x, mouseAim.worldZ - own.z);
  const drop0 = -(state.smoothY + MUZZLE_Y);
  let p0 = solvePitch(d, drop0, w1.spd, !!w1.high, w1.grav);
  if (p0 === null) p0 = w1.maxPitch * 0.85;
  p0 = Math.max(-0.3, Math.min(w1.maxPitch, p0));
  // persistent gamepad elevation: once the stick has been used, the offset
  // STAYS applied through the ownership window — it never snaps back while
  // you play. The cursor owns elevation through the ray when aiming by mouse.
  ap = Math.max(-0.3, Math.min(w1.maxPitch, p0 + (gpAimActive ? state.aimHsm * 0.35 : 0)));
  // LINEAR pitch rate limit — the turret moves at a fixed max speed and
  // arrives decisively (an EMA eases asymptotically and reads as "floaty")
  const maxPitchRate = 3.0; // rad/s
  if (state.pitchSm === undefined) state.pitchSm = ap;
  const dP = ap - state.pitchSm;
  state.pitchSm += Math.max(-maxPitchRate * dt, Math.min(maxPitchRate * dt, dP));
  ap = state.pitchSm;
  input = {
    up: raw.up ? 1 : 0, down: raw.down ? 1 : 0, left: raw.left ? 1 : 0, right: raw.right ? 1 : 0,
    boost: raw.boost ? 1 : 0, fire1: raw.fire1 ? 1 : 0, fire2: raw.fire2 ? 1 : 0, ab: raw.ab ? 1 : 0,
    jump: raw.jump ? 1 : 0,
    ay, ap, st: raw.st,
  };
  // ORIENTATION GUARD: while the camera orbits (MMB drag), the aim is frozen
  // to its pre-drag world anchor. The cursor ray swings with the camera, so
  // without this the turret/ship orientation gets dragged along with the view.
  if (dragging && !state.gpAimActive && heldAim) {
    input.ay = heldAim.ay;
    input.ap = heldAim.ap;
  } else {
    heldAim = { ay: input.ay, ap: input.ap };
  }
  return input;
}

let heldAim = null; // camera-drag guard: aim anchor before the orbit started

// PERF LOG — every 10 s during a match the client reports its frame stats
// to the server, which appends one line to perf.log (checked after a test
// run to spot late-match lag: climbing textures/memory, falling fps)
let perfT = 0;
function reportPerf(dt) {
  perfT += dt;
  if (perfT < 10) return;
  perfT = 0;
  if (!state.joined) return;
  // gate on the SNAP's phase, not state.phase — the state mirror can lag
  // behind the latest snap and silently silenced the whole reporter
  const snapNow = net.snapInfo();
  if (!snapNow || snapNow.ph !== 'play') return;
  try {
    const st = game.stats();
    net.sendRaw({
      t: 'perf', fps: st.fps, draws: st.draws, tris: st.tris,
      parts: st.parts, tex: st.tex, ql: st.ql,
      mem: (performance.memory && performance.memory.usedJSHeapSize) || 0,
      ps: [...game.players.keys()].length,
      projs: (snapNow.pr && snapNow.pr.length) || 0,
    });
  } catch { }
}

// ---------------- render loop ----------------
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  const defs = net.defs;
  if (!defs) return;

  // input
  const own = net.own();
  reportPerf(dt);
  let camYaw = own && own.alive ? own.ang : 0;
  if (state.joined) {
    if (state.paused) {
      // paused: stop the boat (send zeros)
      net.sendInput({ up: 0, down: 0, left: 0, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, ay: 0, ap: 0 }, dt);
    } else {
      const inp = buildInput(dt, camYaw);
      net.predict(dt, inp);
      net.sendInput(inp, dt);
    }
  }
  // gamepad: Start button toggles pause; menu/pause navigation
  const gpNow = getGamepad();
  const gpStart = !!(gpNow && gpNow.buttons[9] && (gpNow.buttons[9].pressed || gpNow.buttons[9].value > 0.5));
  if (gpStart && !state.gpStartPrev) actions().togglePause();
  state.gpStartPrev = gpStart;
  if (state.paused || (state.joined && state.phase === 'lobby' && !ui.el.menu.classList.contains('hidden'))) {
    ui.gamepadMenuTick(gpNow, net.defs);
  }
  // live device detection → the control tip sheet follows whichever input
  // the player is actually using (flips mid-match, both directions)
  const dev = getActiveDevice();
  if (dev !== state.tipDev) { state.tipDev = dev; ui.renderControlTips(dev); }
  // reticle: mouse aim = the crosshair rides the cursor; gamepad = centered
  if (!state.gpAimActive) {
    const msPos = mouseScreen();
    ui.el.crosshair.style.left = msPos.x + 'px';
    ui.el.crosshair.style.top = msPos.y + 'px';
  } else {
    ui.el.crosshair.style.left = '50%';
    ui.el.crosshair.style.top = '50%';
  }
  // gamepad Y = mute (mirrors M on keyboard)
  const gpY = gpNow && gpNow.buttons[3] && (gpNow.buttons[3].pressed || gpNow.buttons[3].value > 0.4);
  if (gpY && !state.gpYPrev) {
    actions.mute();
  }
  state.gpYPrev = !!gpY;

  // gamepad d-pad: up = shop toggle, down = scoreboard hold
  const gp = gpNow;
  const dpUp = gp ? (gp.buttons[12] || {}).pressed === true : false;
  const dpDown = gp ? (gp.buttons[13] || {}).pressed === true : false;
  if (dpUp && !state.dpUpPrev) ui.el.shop.classList.toggle('hidden');
  if (!dpDown) state.gpScoreboard = false;
  else if (dpDown && !state.dpDownPrev) state.gpScoreboard = true;
  state.dpUpPrev = dpUp;
  state.dpDownPrev = dpDown;

  // ---- players rendering ----
  const seen = new Set();
  if (own && own.alive) {
    seen.add(own.id);
    // CRITICAL: the own canoe needs a visual too (upsert before apply!)
    game.upsertPlayer(own.id, { clsDef: defs.CLASSES[own.cls], cosmetics: own.cs || state.cosmetics, name: own.name });
    game.applyPlayer(own.id, {
      x: own.x, y: own.y, z: own.z, vx: own.vx, vz: own.vz,
      yaw: own.ang, ty: own.ty, tp: own.tp,
      hp: own.hp, maxHp: own.maxHp, alive: true, boost: own.boostT > 0,
      w: own.w, turn: 0, ds: own.ds,
      sh: own.sh || 0, u1: own.u1 || 0, u2: own.u2 || 0,
    }, state.myId);
    // aim-line: faint box trail along the predicted ballistic arc
    const w1 = defs.CLASSES[own.cls].w1.tiers[own.w[0]];
    const aimPts = computeAimPath(own, w1);
    game.setAimPath(aimPts);
    // WoWS-style markers: yellow X at the shell's water impact, red X at the
    // predicted intercept (flight-time lead) of the nearest enemy on-target
    const impact = aimPts.length > 1 ? { x: aimPts[aimPts.length - 1][0], z: aimPts[aimPts.length - 1][2] } : null;
    let lead = null;
    const snapNow = net.snapInfo();
    if (snapNow && snapNow.ps) {
      let best = null, bestD = 0.22;
      for (const p of snapNow.ps) {
        if (!p.al || p.i === state.myId) continue;
        const eAng = Math.atan2(p.z - own.z, p.x - own.x);
        let dd = eAng - own.ty;
        while (dd > Math.PI) dd -= Math.PI * 2;
        while (dd < -Math.PI) dd += Math.PI * 2;
        if (Math.abs(dd) < bestD) { bestD = Math.abs(dd); best = p; }
      }
      if (best) {
        const d = Math.hypot(best.x - own.x, best.z - own.z);
        const lt = Math.max(0.25, Math.min(1.5, d / Math.max(1, w1.spd)));
        lead = { x: best.x + (best.vx || 0) * lt, z: best.z + (best.vz || 0) * lt };
      }
    }
    game.setAimMarkers(impact, lead);
  } else {
    game.setAimPath([]);
    game.setAimMarkers(null, null);
  }
  for (const r of net.remote(now)) {
    seen.add(r.i);
    if (!r.al) { game.removePlayer(r.i); continue; }
    const prev = state.lastRemote.get(r.i);
    let turn = 0;
    if (prev) {
      let d = r.a - prev.a;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      turn = d / Math.max(dt, 0.001);
    }
    state.lastRemote.set(r.i, { a: r.a });
    game.upsertPlayer(r.i, { clsDef: defs.CLASSES[r.c], cosmetics: r.cs || {}, name: r.n });
    game.applyPlayer(r.i, {
      x: r.x, y: r.y, z: r.z, vx: r.vx, vz: r.vz,
      yaw: r.a, ty: r.ty, tp: r.tp,
      hp: r.hp, maxHp: r.mx, alive: true, boost: r.bt > 0,
      w: r.w, turn,
      sh: r.sh || 0, u1: r.u1 || 0, u2: r.u2 || 0,
    }, state.myId);
  }
  for (const [id, pv] of game.players) {
    if (!seen.has(id) && pv) game.removePlayer(id);
  }

  // projectiles + crates
  game.syncProjectiles(net.projectiles());
  // weapon fire sounds — SND.fire was DEAD CODE (zero callers): every
  // gun was silent. The snap's own projectile spawn is the server-confirmed
  // shot moment; play once per NEW id, rate-gated (a 9-pellet volley spawns
  // in one tick — it must bang once, not nine times)
  if (!state.ownProjSeen) state.ownProjSeen = new Set();
  if (!state.lastFireSndT) state.lastFireSndT = -1e9;
  for (const q of net.projectiles()) {
    if (q.o === state.myId && !state.ownProjSeen.has(q.i)) {
      state.ownProjSeen.add(q.i);
      if (performance.now() - state.lastFireSndT > 90) {
        state.lastFireSndT = performance.now();
        SND.fire(q.k);
      }
    }
  }
  // prune WITHOUT re-arming old ids: a full clear made every live shell
  // look "new" again — with the 90 ms rate gate that became a constant
  // quiet tick ("a faded machine gun constantly going off"). Projectile
  // ids are monotonic, so keeping ONLY the highest id preserves the floor:
  // genuinely new shells always have larger ids.
  if (state.ownProjSeen.size > 4096) {
    state.ownProjSeen = new Set([Math.max(...state.ownProjSeen)]);
  }
  game.syncCrates(net.crates());
  game.syncPickups(net.pickups());
  game.syncUpgradePickup((net.snapInfo() || {}).up || null);

  // ---- camera ----
  let focus = own && own.alive ? { x: own.x, y: own.y, z: own.z } : null;
  let camMode = 'chase';
  // per-frame yaw rate (drives centrifugal camera lean)
  if (own && own.alive) {
    let d = own.ang - (state.lastOwnAng === undefined ? own.ang : state.lastOwnAng);
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    state.turnNow = d / Math.max(dt, 0.001);
    state.lastOwnAng = own.ang;
  }
  const snap = net.snapInfo();
  const inPlay = snap && (snap.ph === 'play' || snap.ph === 'countdown');
  if (state.joined && inPlay) {
    if (own && !own.alive && own.spectating) {
      camMode = 'orbit';
      const targets = state.spectateTargets;
      if (targets.length) {
        const tid = targets[state.spectateIdx % targets.length];
        const t = snap.ps.find(p => p.i === tid);
        if (t) {
          focus = { x: t.x, y: t.y, z: t.z };
          const tp = snap.ps.find(p => p.i === tid);
          ui.showSpectate(tp.n);
          camYaw = t.a;
        }
      } else {
        focus = { x: 0, y: 1, z: 0 };
        ui.showSpectate('the arena');
      }
      // death overlay text
      if (own.respawnT > 0) {
        ui.showDeath(`Respawn in ${Math.ceil(own.respawnT)}…`);
      } else {
        ui.showDeath(`You sank! Spectating…`);
      }
    } else if (own && own.alive) {
      ui.hideDeath();
      ui.hideSpectate();
    }
  }
  // camera: gamepad aim owns the view (swings with the turret); mouse aim
  // keeps a stable ship-relative camera so the cursor ray stays anchored
  const camFollow = state.gpAimActive && input && input.ay !== undefined ? input.ay : camYaw;
  if (focus) game.updateCamera(focus, camFollow, dt, {
    mode: camMode,
    turn: state.turnNow || 0,
    boost: !!(own && own.boostT > 0),
  });

  // ---- UI (throttled) ----
  state.uiTimer -= dt;
  if (state.uiTimer <= 0) {
    state.uiTimer = 0.1;
    // KOTH zone marker (rebuilt only when the zone definition changes)
    if (snap && snap.zn !== state.znSig) {
      state.znSig = snap.zn;
      game.setZone(snap.zn || null);
    }
    if (snap && snap.zn) {
      // in-zone banner while HOLDING THE HILL
      ui.setZoneBanner(!!(own && own.alive && own.iz));
    } else {
      ui.setZoneBanner(false);
    }
    if (inPlay && own) {
      ui.updateHud(own, snap, defs);
      ui.UI.cls = own.cls;
    }
    // crosshair
    if (own && own.alive && state.phase === 'play') {
      const aim = computeAim(own.x, own.z);
      if (aim) {
        const v = new THREE.Vector3(aim.worldX, 0, aim.worldZ).project(game.camera);
        ui.setCrosshair((v.x * 0.5 + 0.5) * window.innerWidth, (-v.y * 0.5 + 0.5) * window.innerHeight);
      }
    }
    // scoreboard
    if ((keyTab || state.gpScoreboard || ui.UI.sbBtn) && snap && snap.ps) {
      const rows = [...snap.ps].sort((a, b) => b.sc - a.sc).map(p => ({
        i: p.i, n: p.n, c: defs.CLASSES[p.c] ? defs.CLASSES[p.c].name : p.c,
        sc: p.sc, k: p.k, d: p.d, cr: p.cr, hp: p.hp, al: !!p.al,
      }));
      ui.showScoreboard(rows);
    } else ui.hideScoreboard();
  }

  game.render(dt);
}

// ---------------- boot ----------------
initInput(game.camera, canvas);
// Server endpoint: same-origin by default; override via /js/server-config.js
// (generated by scripts/build.js from the CANOE_SERVER env var for Netlify).
const SERVER_HOST = (window.CANOE_SERVER || '').trim() || location.host;
net.connect(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${SERVER_HOST}/ws`);

document.addEventListener('keydown', (e) => {
  if (e.code === 'Tab') keyTab = true;
  if (e.code === 'KeyM' && !e.repeat) {
    muted = toggleMute();
    if (ui.el.btnMuteT) ui.el.btnMuteT.textContent = muted ? '🔇 MUTED' : '🔊 MUTE';
  }
});
document.addEventListener('keyup', (e) => { if (e.code === 'Tab') keyTab = false; });
document.addEventListener('mousedown', (e) => {
  initAudio();
  if (e.button === 1) { e.preventDefault(); }
});
window.addEventListener('wheel', (e) => { game.zoom(e.deltaY > 0 ? 1.5 : -1.5); }, { passive: true });
window.addEventListener('mousedown', (e) => {
  if (e.button === 1) dragging = true;
});
window.addEventListener('mouseup', (e) => { if (e.button === 1) dragging = false; });
let dragging = false;
window.addEventListener('mousemove', (e) => {
  if (dragging) game.setCameraDrag(e.movementX, e.movementY);
});

// ---------------- debug hooks ----------------
window.__dbg = {
  get net() { return net; },
  get ui() { return ui; },
  get game() { return game; },
  get state() { return state; },
  waveH(x, z, t) { return waveH(x, z, t === undefined ? game.time() : t); },
  gp() { return gpDebug(); },
  setCmd(c) { setDbgCmd(c); },
  buy(t) { net.buy(t); },
  shot() { game.shot(); },
  sample() { return game.sample(); },
  setMode(m) { net.hostMode(m); },
  setMap(m) { net.hostMap(m); },
  bots(n) { net.hostBots(n); },
  start() { net.start(); },
  join() { doJoin(); },
  spec(n) { state.spectateIdx = n || 0; },
  mute() { muted = toggleMute(); return muted; },
  // pause/exit
  togglePause() {
    if (!state.joined || (state.phase !== 'play' && state.phase !== 'countdown')) return;
    state.paused = !state.paused;
    if (state.paused) { ui.showPause(); ui.setHudVisible(false); }
    else { ui.hidePause(); ui.setHudVisible(true); }
  },
  leaveMatch() {
    state.paused = false;
    ui.hidePause();
    try { net.sendRaw({ t: 'leave' }); } catch { }
    ui.msg('Leaving match…');
  },
  info() {
    const own = net.own();
    return {
      myId: state.myId, phase: state.phase, own,
      players: net.snapInfo() ? net.snapInfo().ps.map(p => ({ i: p.i, n: p.n, x: p.x, z: p.z, hp: p.hp, al: p.al })) : [],
      projs: (net.projectiles() || []).length,
    };
  },
};

requestAnimationFrame(frame);
