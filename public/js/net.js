'use strict';
// ============================================================
// CANOE ARENA — networking: WS, client-side prediction,
// reconciliation, remote interpolation, snapshot bookkeeping.
// ============================================================

import { solvePitch, MUZZLE_Y, waveH } from './ballistics.js';

const TAU = Math.PI * 2;
function angDiff(a, b) { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function createNet(cb) {
  let ws = null;
  let defs = null;
  let myId = -1;
  let connected = false;
  let joinArgs = null;

  const snapHist = [];          // [{t, ps: Map}]
  let latest = null;            // latest snap (raw)
  let srvTime = 0;              // server wave clock (ticks/30), for prediction
  const fxQueue = [];
  const killQueue = [];
  const csStore = new Map(); // playerId -> cosmetics (server sends once per change)
  let inputTimer = 0;

  // ---- predicted own state (mirrors server integration) ----
  const local = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ang: 0, ty: 0, tp: 0,
    boostT: 0, boostCd: 0, fireCd1: 0, fireCd2: 0, abilityCd: 0, overclockT: 0,
    hopT: 0, hopV: 0, rampT: 0, jumpCd: 0, collideT: 0, lastInput: null,
  };
  let ownServer = null; // last server entry for own player
  let lastInputSent = {};
  let lastPh = 'lobby'; // phase of the previous snap — match-start detection

  function connect(url) {
    ws = new WebSocket(url);
    ws.onopen = () => {
      connected = true;
      cb.status && cb.status('Connected!');
      if (joinArgs) { send({ t: 'join', ...joinArgs }); } // rejoin after reconnect
    };
    ws.onclose = () => {
    connected = false;
    myId = -1;
    cb.status && cb.status('Connection lost — reconnecting…');
    setTimeout(() => { try { connect(url); } catch { } }, 1500);
  };
    ws.onerror = () => {};
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      handle(m);
    };
  }

  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

  function handle(m) {
    switch (m.t) {
      case 'hello':
        defs = m.cfg;
        cb.hello && cb.hello(m.cfg);
        break;
      case 'joined':
        myId = m.id;
        cb.joined && cb.joined(m.id);
        break;
      case 'lobby':
        cb.lobby && cb.lobby(m);
        break;
      case 'chat':
        cb.chat && cb.chat(m);
        break;
      case 'phase':
        cb.phase && cb.phase(m);
        break;
      case 'toast':
        cb.toast && cb.toast(m.msg);
        break;
      case 'snap': {
        const t = performance.now();
        latest = m;
        srvTime = m.tick / 30;
        // lock the prediction's wave clock to the SERVER clock every snap —
        // a free-running predT drifts (frame-time variance) and the wave-follow
        // y fights the reconcile every snap: the hull/title-plate jitter on
        // the chop octave (user: "canoe shakes on the waves — remove it").
        if (local.predT === undefined) local.predT = srvTime;
        else local.predT += (srvTime - local.predT) * 0.5;
        // cosmetics arrive ONCE per player (server dirty-flag) — persist
        // them per id so omitted entries keep rendering their hull paint
        for (const p of m.ps) {
          if (p.cs) csStore.set(p.i, p.cs);
          else p.cs = csStore.get(p.i);
        }
        snapHist.push({ t, ps: new Map(m.ps.map(p => [p.i, p])) });
        if (snapHist.length > 12) snapHist.shift();
        const me = m.ps.find(p => p.i === myId);
        if (m.ph === 'play' && lastPh !== 'play' && me) {
          // FRESH MATCH: seed the prediction from server truth. The predicted
          // state was still at the old position — without this, the first
          // seconds fight a teleport (the start-of-match jank).
          local.x = me.x; local.y = me.y; local.z = me.z;
          local.vx = me.vx || 0; local.vz = me.vz || 0; local.vy = 0;
          local.ang = me.a; local.ty = me.ty; local.tp = me.tp;
          local.boostT = 0; local.boostCd = 0; local.abilityCd = 0;
          local.rampT = 0; local.hopT = 0; local.hopF = 0; local.boostPadT = 0; local.jumpCd = 0;
        }
        lastPh = m.ph;
        if (me) reconcile(me);
        for (const f of m.fx) fxQueue.push(f);
        for (const k of m.kl) killQueue.push(k);
        cb.snap && cb.snap(m);
        break;
      }
      case 'end':
        cb.end && cb.end(m);
        break;
    }
  }

  // ---- reconciliation: blend prediction toward server truth ----
  function reconcile(me) {
    ownServer = me;
    // hard snap if way off
    const dx = me.x - local.x, dz = me.z - local.z, dy = me.y - local.y;
    const err = Math.hypot(dx, dz);
    if (err > 6 || Math.abs(dy) > 4) {
      local.x = me.x; local.y = me.y; local.z = me.z;
      local.vx = 0; local.vy = 0; local.vz = 0;
      local.ang = me.a; local.ty = me.ty; local.tp = me.tp;
    } else {
      local.x += dx * 0.22; local.z += dz * 0.22; local.y += dy * 0.3;
    }
    // ANG RECONCILIATION (soft) — the predicted heading used to reconcile
    // ONLY on the hard snap, so it could sit >1.5 rad off the server's while
    // the position stayed close (measured 1.68 rad through a graze: digital
    // steering near a rock flips the bearing, the two integrators steer
    // opposite ways for a beat, and the mirror never pulled the bow back).
    // The own hull's VISUAL orientation is the predicted ang — this blend
    // bounds the divergence like the position blend does.
    const dA = angDiff(me.a, local.ang);
    if (Math.abs(dA) > 0.6) local.ang = me.a;
    else local.ang += dA * 0.3;
    // server-authoritative stats
    local.hp = me.hp; local.maxHp = me.mx; local.credits = me.cr;
    local.iz = me.iz || 0;
    local.w = me.w; local.boostCd = me.bcd; local.abilityCd = me.acd;
    local.overclockT = me.oc ? 999 : 0;
    local.alive = !!me.al; local.respawnT = me.rt;
    local.score = me.sc; local.kills = me.k; local.deaths = me.d;
    local.spawnProtect = me.sp;
    local.spectating = !!me.spct;
    local.ds = me.ds || [];
    local.ch = me.ch || 0; // barge MINE LAYER charges
  }

  // ---- own prediction integration (30 Hz, mirrors server) ----
  function predict(dt, input) {
    if (!ownServer || !local.alive) return;
    // contact-ease rate matched to the server's 35%/TICK in continuous time
    // (35%/frame at 60 fps = ~70%/tick — the predicted bow swung twice as
    // fast as the authority's through a contact and led it visibly)
    const easeK = 1 - Math.pow(0.65, 30 * dt);
    const cls = defs.CLASSES[ownServer.c];
    const P = defs.PHYS;
    local.boostT = Math.max(0, local.boostT - dt);
    local.boostCd = Math.max(0, local.boostCd - dt);
    local.abilityCd = Math.max(0, local.abilityCd - dt);
    local.fireCd1 -= dt; local.fireCd2 -= dt;
    local.hopT = Math.max(0, local.hopT - dt);
    local.hopF = Math.max(0, local.hopF - dt);
    local.boostPadT = Math.max(0, (local.boostPadT || 0) - dt); // boost window
    local.rampT = Math.max(0, local.rampT - dt);

    // wave-relative airborne (mirrors server): riding the swell is NOT airborne
    let wy0 = 0;
    if (local.predT === undefined) local.predT = srvTime;
    local.predT += dt;
    wy0 = Math.max(0, waveH(local.x, local.z, local.predT));
    const airborne = local.y > wy0 + 0.35;
    const onRamp = local.rampT > 0;
    // steering ramp + speed-scaled turn (mirrors server)
    let steerTarget;
    if (typeof input.st === 'number') steerTarget = input.st;
    else steerTarget = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    steerTarget = Math.max(-1, Math.min(1, steerTarget));
    local.steer = (local.steer || 0) + (steerTarget - (local.steer || 0)) * Math.min(1, 20 * dt);
    const spdNow = Math.hypot(local.vx, local.vz);
    const speedFactor = Math.max(0.45, Math.min(1, spdNow / Math.max(1, cls.speed)));
    local.ang += local.steer * cls.turn * speedFactor * ((airborne && !onRamp) ? P.airTurnMul : 1) * dt;

    let thrust = 0;
    if (!airborne || onRamp || local.hopT > 0 || local.hopF > 0) {
      if (input.up) thrust = cls.speed;
      else if (input.down) thrust = -cls.reverse;
      if (input.boost && local.boostCd <= 0 && local.boostT <= 0) {
        local.boostT = P.boostTime;
        local.boostCd = cls.boostCd;
      }
      if (input.ab && local.abilityCd <= 0) {
        // ability mirror — the special is SERVER-SIDE PROJECTILES only
        // (razorfin gatling burst, barge thunder shotgun, rocket missile
        // rain): the own hull gets NO velocity/boost/hop kick. The old
        // mirror applied stale pre-rework effects (razorfin air dash 16 u/s,
        // barge boostT 1.4, rocket hop 9.5) — the hull lurched on every
        // special and the reconcile had to claw it back.
        local.abilityCd = cls.ability.cd;
      }
    } else if (input.ab && local.abilityCd <= 0 && cls.id === 'razorfin') {
      // airborne razorfin can still fire the gatling burst (server branch);
      // no movement effect to mirror
      local.abilityCd = cls.ability.cd;
    }
    // jump mirror (server: Space/A hop on the water — forward kick + higher arc)
    local.jumpCd = Math.max(0, local.jumpCd - dt);
    if (input.jump && local.jumpCd <= 0 && local.hopT <= 0 && local.rampT <= 0 && !airborne) {
      local.vy = P.jumpVy;
      local.vx += Math.cos(local.ang) * P.jumpFwd;
      local.vz += Math.sin(local.ang) * P.jumpFwd;
      local.hopT = 0.35; local.hopF = 0.85; local.jumpCd = P.jumpCd;
    }
    // boost (ramped, mirrors server)
    local.boostEff = local.boostEff === undefined ? 1 : local.boostEff;
    local.boostEff += ((local.boostT > 0 ? cls.boostMul : 1) - local.boostEff) * Math.min(1, 6 * dt);
    const spd = thrust * local.boostEff;
    const k = Math.min(1, cls.accel * dt);
    // BOOST-RAMP spring (mirrors server): engine holds ~2.2x top speed along
    // your heading while the boost window lasts — steerable, persistent
    const boostSpd = (local.boostPadT || 0) > 0 ? cls.speed * P.rampBoostSpd : 0;
    const target = thrust < 0 ? thrust * local.boostEff : Math.max(thrust * local.boostEff, boostSpd);
    if (target > 0) {
      local.vx += (Math.cos(local.ang) * target - local.vx) * k;
      local.vz += (Math.sin(local.ang) * target - local.vz) * k;
    }
    const damp = Math.max(0, 1 - (((local.boostPadT || 0) > 0 ? P.rampBoostDrag : cls.drag) + ((airborne && local.hopT <= 0 && local.hopF <= 0 && (local.boostPadT || 0) <= 0) ? P.airDrag : 0)) * dt);
    local.vx *= damp; local.vz *= damp;
    local.vy *= Math.max(0, 1 - 0.6 * dt);
    if (local.y > 0) local.vy -= P.gravity * dt;
    local.x += local.vx * dt;
    local.y += local.vy * dt;
    local.z += local.vz * dt;

    // platform mirror (matches server ridePlatforms): drive onto the surface,
    // ride it like water, and crossing the pad launches forward + up
    {
      const mp = defs.MAPS[(latest && latest.map) || 'lagoon'];
      for (const z of mp.boostZones || []) {
        const h = z.h || 1.3;
        const along = z.dir === 'x' ? local.x - z.x : local.z - z.z;
        const across = z.dir === 'x' ? local.z - z.z : local.x - z.x;
        if (Math.abs(across) > z.w / 2 + 0.6) continue;
        const prog = (along * z.sign + z.d / 2) / z.d;
        if (prog < -0.02 || prog > 1.05) continue;
        if (local.hopT > 0 || local.hopF > 0) continue;
        const surf = h * Math.max(0, Math.min(1, prog / 0.3));
        if (local.y < surf) { local.y = surf; local.vy = Math.max(0, local.vy); }
        local.rampT = 0.4;
        // pad strip only (mirrors server — riding the platform alone doesn't
        // trigger; crossing the exit pad launches forward + up)
        if ((local.boostPadT || 0) <= 0 && prog > 0.65 && local.y <= surf + 0.5) {
          const spd = Math.hypot(local.vx, local.vz);
          const surge = Math.max(spd, cls.speed * P.rampBoostSpd);
          local.vx = Math.cos(local.ang) * surge;
          local.vz = Math.sin(local.ang) * surge;
          local.vy = Math.min(11, 6 + spd * 0.15);
          local.boostPadT = P.rampBoostT;
        }
        break;
      }
    }
    // terrain mirror — ported EXACTLY from server collideTerrain +
    // collideSlide (normal-based closest-point push, into-component kill,
    // contact-gated heading ease). The old axis-based push diverged from the
    // server by ~6.7 u over 1.3 s of grazing (measured: probe-drive.js) —
    // past the 6 u reconcile hard-snap — so every rock graze ended in a
    // visible teleport = the canoe "not driving straight".
    {
      const mp = defs.MAPS[(latest && latest.map) || 'lagoon'];
      const obs = [];
      for (const rk of mp.rocks || []) obs.push({ x: rk.x, z: rk.z, w: rk.w, d: rk.d, top: rk.h + 0.4 });
      for (const isl of mp.isles || []) obs.push({ x: isl.x, z: isl.z, w: isl.w + 1.2, d: isl.d + 1.2, top: isl.y + 2.3 });
      for (const ob of obs) {
        if (local.y > ob.top) continue;
        const cx = clamp(local.x, ob.x - ob.w / 2, ob.x + ob.w / 2);
        const cz = clamp(local.z, ob.z - ob.d / 2, ob.z + ob.d / 2);
        const dx = local.x - cx, dz = local.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= P.playerR * P.playerR) continue;
        const dist = Math.sqrt(d2) || 0.001;
        const push = (P.playerR - dist) / dist;
        local.x += dx * push; local.z += dz * push;
        // kill only the INTO-obstacle component + heading ease (collideSlide)
        const nx = dx / dist, nz = dz / dist;
        const into = local.vx * nx + local.vz * nz;
        if (into < 0) { local.vx -= nx * into; local.vz -= nz * into; }
        // ease gated on forward throttle (mirrors server DRIFT HARDENING):
        // a drifting hull keeps its orientation
        if (input.up && Math.hypot(local.vx, local.vz) > 1.5) {
          const dA = angDiff(Math.atan2(local.vz, local.vx), local.ang);
          if (Math.abs(dA) > 0.2) {
            local.ang = ((local.ang + dA * easeK) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
            local.collideT = 0.5;
          }
        }
      }
    }
    // buoyancy spring — mirrors server exactly (k=30, c=8, keel limit 0.55)
    const wy = wy0;
    const swimming = local.hopT <= 0 && local.rampT <= 0;
    if (swimming) {
      if (local.y >= wy + 0.02 && local.vy < 0 && local.y - wy < 1.1) {
        local.y = wy; local.vy = 0; local.hopT = 0; local.hopF = 0;
      } else if (local.y <= wy + 0.7) {
        local.vy += (30.0 * (wy - local.y) - 8.0 * local.vy) * dt;
        local.y += local.vy * dt;
        if (local.y < wy - 0.55) { local.y = wy - 0.55; local.vy = Math.max(0, local.vy); }
      }
    }
    if (local.y < 0) { local.y = 0; local.vy = 0; }

    // walls — kill INTO-component only + the SAME heading ease the server's
    // collideSlide applies on contact (the old 0.35 reverse-bounce was server
    // behavior years ago). The ease is CONTACT-GATED like the server's — the
    // old unconditional ease fired during reverse/coast too and spun the
    // predicted hull away from the server's heading. ALSO gated on forward
    // throttle (mirrors the server's DRIFT HARDENING): a drifting hull keeps
    // its orientation.
    const slideAlign = () => {
      if (!input.up) return;
      if (Math.hypot(local.vx, local.vz) > 1.5) {
        const dA = angDiff(Math.atan2(local.vz, local.vx), local.ang);
        if (Math.abs(dA) > 0.2) {
          local.ang = ((local.ang + dA * easeK) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
          local.collideT = 0.5;
        }
      }
    };
    const A = P.arena;
    if (local.y < P.wallH) {
      if (local.x < -A + 2) { local.x = -A + 2; if (local.vx < 0) local.vx = 0; slideAlign(); }
      if (local.x > A - 2) { local.x = A - 2; if (local.vx > 0) local.vx = 0; slideAlign(); }
      if (local.z < -A + 2) { local.z = -A + 2; if (local.vz < 0) local.vz = 0; slideAlign(); }
      if (local.z > A - 2) { local.z = A - 2; if (local.vz > 0) local.vz = 0; slideAlign(); }
    }
    // collision-recovery window (mirrors server, gated on forward throttle):
    // keep aligning for 0.5 s after contact ends
    if (local.collideT > 0) {
      local.collideT -= dt;
      if (input.up) {
        const spdC = Math.hypot(local.vx, local.vz);
        if (spdC > 1.5) {
          const dC = angDiff(Math.atan2(local.vz, local.vx), local.ang);
          if (Math.abs(dC) > 0.2) local.ang = ((local.ang + dC * easeK) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
        }
      }
    }
    // turret
    const w1 = cls.w1.tiers[local.w ? local.w[0] : 0];
    const maxP = Math.max(w1.maxPitch, 0.5);
    const wantP = clamp(input.ap, -0.3, maxP);
    const maxT = cls.turretTurn * dt;
    let d = angDiff(input.ay, local.ty);
    local.ty += clamp(d, -maxT, maxT);
    d = angDiff(wantP, local.tp);
    local.tp += clamp(d, -maxT, maxT);
    // fire cooldowns
    const cdMul = local.overclockT > 0 ? P.overclockMul : 1;
    if (input.fire1 && local.fireCd1 <= 0) local.fireCd1 = w1.cd * cdMul;
    const w2 = cls.w2.tiers[local.w ? local.w[1] : 0];
    if (input.fire2 && local.fireCd2 <= 0) local.fireCd2 = w2.cd * cdMul;
  }

  // ---- input sender ----
  function sendInput(input, dt) {
    if (!connected || !ownServer) return;
    inputTimer += dt;
    if (inputTimer < 1 / 30) return;
    inputTimer = 0;
    // only send deltas when changed, but aim always
    const msg = {
      up: input.up ? 1 : 0, down: input.down ? 1 : 0, left: input.left ? 1 : 0,
      right: input.right ? 1 : 0, boost: input.boost ? 1 : 0, fire1: input.fire1 ? 1 : 0,
      fire2: input.fire2 ? 1 : 0, ab: input.ab ? 1 : 0, jump: input.jump ? 1 : 0,
      ay: Math.round(input.ay * 1000) / 1000, ap: Math.round(input.ap * 1000) / 1000,
    };
    if (typeof input.st === 'number') msg.st = Math.round(input.st * 100) / 100;
    send({ t: 'input', i: msg });
    local.lastInput = input;
  }

  // ---- public API ----
  return {
    get defs() { return defs; },
    get myId() { return myId; },
    get connected() { return connected; },
    connect, send,
    sendRaw(msg) { send(msg); },
    join(name, cls, cosmetics, kind) { joinArgs = { name, cls, cosmetics, kind }; send({ t: 'join', name, cls, cosmetics, kind }); },
    // canoe selection after joining: updates the server's class (and the
    // auto-rejoin args) so the right canoe enters the scene at match start
    setClass(cls) { if (joinArgs) joinArgs.cls = cls; send({ t: 'class', cls }); },
    // leave: clear the auto-rejoin so a reconnect lands in the LOBBY (title),
    // not straight back into the match
    leave() { joinArgs = null; myId = -1; send({ t: 'leave' }); },
    buy(track) { send({ t: 'shop', track }); },
    hostMode(mode) { send({ t: 'host', mode }); },
    hostMap(map) { send({ t: 'host', map }); },
    hostBots(n) { send({ t: 'host', bots: n }); },
    hostBotsOn(v) { send({ t: 'host', botsOn: v }); },
    chat(text) { send({ t: 'chat', m: text }); },
    hostDiff(d) { send({ t: 'host', diff: d }); },
    start() { send({ t: 'start' }); },
    predict, sendInput,
    // own predicted state for rendering
    own() {
      if (!ownServer) return null;
      return {
        id: myId, x: local.x, y: local.y, z: local.z,
        vx: local.vx, vz: local.vz, ang: local.ang, ty: local.ty, tp: local.tp,
        hp: local.hp, maxHp: local.maxHp, credits: local.credits,
        w: local.w, alive: local.alive, respawnT: local.respawnT,
        boostT: local.boostT, boostCd: local.boostCd, abilityCd: local.abilityCd,
        overclockT: local.overclockT, score: local.score, kills: local.kills,
        deaths: local.deaths, spawnProtect: local.spawnProtect, spectating: local.spectating,
        iz: local.iz || 0,
        sh: (ownServer && ownServer.sh) || 0,
        u1: (ownServer && ownServer.u1) || 0,
        u2: (ownServer && ownServer.u2) || 0,
        ds: local.ds || [],
        ch: local.ch || 0,
        cs: ownServer.cs || {},
        name: ownServer.n, cls: ownServer.c,
      };
    },
    ownServerEntry() { return ownServer; },
    // remote state at render time (interpolated)
    remote(now, interpMs = 120) {
      if (!latest) return [];
      const t = now - interpMs;
      let s0 = null, s1 = null;
      for (let i = snapHist.length - 1; i >= 0; i--) {
        if (snapHist[i].t <= t) { s0 = snapHist[i]; s1 = snapHist[i + 1] || null; break; }
      }
      if (!s0) s0 = snapHist[0];
      const out = [];
      for (const p of (s1 ? s1.ps.values() : s0.ps.values())) {
        if (p.i === myId) continue;
        const e0 = s0.ps.get(p.i);
        if (!e0) { out.push(p); continue; }
        let f = 0, span = 40;
        if (s1) {
          span = Math.max(1, s1.t - s0.t);
          f = clamp((t - s0.t) / span, 0, 1);
        }
        const da = angDiff(p.a, e0.a);
        const dtp = p.tp - e0.tp;
        out.push({
          ...p,
          x: e0.x + (p.x - e0.x) * f,
          z: e0.z + (p.z - e0.z) * f,
          y: e0.y + (p.y - e0.y) * f,
          a: e0.a + da * f,
          ty: e0.ty + (p.ty - e0.ty) * f,
          tp: e0.tp + dtp * f,
          vx: ((p.x - e0.x) / span) * 1000,
          vz: ((p.z - e0.z) / span) * 1000,
        });
      }
      return out;
    },
    projectiles() { return latest ? latest.pr : []; },
    crates() { return latest ? latest.cr : []; },
    pickups() { return latest ? latest.pk : []; },
    snapInfo() { return latest; },
    drainFx() { const q = fxQueue.splice(0); return q; },
    drainKills() { const q = killQueue.splice(0); return q; },
    phase() { return latest ? latest.ph : 'lobby'; },
    timer() { return latest ? latest.tm : 0; },
    leader() { return latest ? latest.ldr : null; },
    winner() { return latest ? latest.wi : null; },
    modeId() { return latest ? latest.mode : 'rumble'; },
    mapId() { return latest ? latest.map : 'lagoon'; },
  };
}
