'use strict';
// ============================================================
// CANOE ARENA — authoritative 3D simulation (server side)
// World: x/z horizontal, y = height above water. All physics 3D.
// ============================================================
const { PHYS, CLASSES, MODES, MAPS, CRATE_KINDS, SPAWNS, BOT_NAMES } = require('./defs');

const TAU = Math.PI * 2;
function angDiff(a, b) { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }
const r2 = (n) => Math.round(n * 100) / 100;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---- volumetric swell: canoes RIDE this wave field (server-authoritative) ----
// MUST match public/js/ballistics.js waveH() and the water shader primary
// octaves. ±~2.8 max (RMS ~0.9) — big swells that throw off aim at range,
// heave the hulls, and read as waves.
function waveH(x, z, t) {
  // 08-13: octave amps ×1.25 → max ~±3.5 (user: "increase wave magnitude
  // instead of volume of waves" — same 6 octaves, taller). KEEP IN SYNC
  // with public/js/ballistics.js + the WATER_VERT fallback in render.js.
  const w = Math.sin(x * 0.045 + t * 0.7) * 0.8
          + Math.sin(z * 0.055 + t * 0.85) * 0.65
          + Math.sin(x * 0.10 + t * 1.1) * 0.55
          + Math.sin(z * 0.08 + t * 0.9) * 0.45
          + Math.sin((x + z) * 0.05 + t * 0.6) * 0.35
          + Math.sin(x * 0.31 + z * 0.19 + t * 2.7) * 0.28;
  return w * 1.125;
}

// ---- ballistic launch-pitch solver (MUST match public/js/ballistics.js) ----
// Solve pitch angle so a projectile from height muzzleY hits target at
// horizontal distance d and vertical drop `drop` (targetY - muzzleY).
// `high` selects the high-arc solution (mortars). Returns radians or null.
function solvePitch(d, drop, speed, g, high) {
  if (d < 0.001) return high ? Math.PI / 4 : 0;
  const A = (g * d * d) / (2 * speed * speed);
  const disc = d * d - 4 * A * (A + drop);
  if (disc < 0) return null;
  const u = high
    ? (d + Math.sqrt(disc)) / (2 * A)
    : (d - Math.sqrt(disc)) / (2 * A);
  return Math.atan(u);
}

class Game {
  constructor() {
    this.players = new Map();
    this.nextId = 1;
    this.projectiles = [];
    this.nextPid = 1;
    this.crates = [];
    this.nextCid = 1;
    this.pickups = []; // shield pickups — {x, z, t: respawn timer (0 = live)}
    this.upgradePickup = null; // ramp-top weapon-upgrade pickup — {x, z, y, t}
    this.cannons = []; // CANNON COVE batteries — environmental hazard state
    this.fxQueue = [];
    this.killFeed = [];
    this.phase = 'lobby';          // lobby | countdown | play | end
    this.phaseT = 0;
    this.modeId = 'ffa';
    this.mapId = 'lagoon';
    this.botDiff = 'med';          // low | med | high — bot aim/pursuit skill
    this.timer = 0;
    this.winnerId = null;
    this.tickN = 0;
    this.crateT = 10;
    this.trickleT = 0;
    this.botTarget = 6;
    this.botsOn = true;      // Add Bots? Yes/No (host-only lobby setting)
    this.practice = false;   // practice-lobby flag (solo host, bots default ON)
    this.chat = [];          // lobby-scoped chat — cleared ONLY when the lobby closes
    this.botCount = 0;
    this.time = 0; // wave clock
  }

  get mode() { return MODES[this.modeId]; }
  get map() { return MAPS[this.mapId]; }

  addPlayer(name, clsId, cosmetics, bot) {
    const cls = CLASSES[clsId] || CLASSES.razorfin;
    const id = this.nextId++;
    const sp = this.pickSpawn();
    const p = {
      id, name: name || 'Paddler', bot: !!bot, cls: cls.id, def: cls,
      x: sp.x, y: 0, z: sp.z, vx: 0, vy: 0, vz: 0,
      ang: Math.random() * TAU, turretYaw: Math.random() * TAU, turretPitch: 0,
      hp: cls.hp, maxHp: cls.hp, credits: 0,
      w1: 0, w2: 0, hull: 0,
      score: 0, kills: 0, deaths: 0, streak: 0,
      alive: true, spectating: false, respawnT: 0,
      boostT: 0, boostCd: 0, fireCd1: 0, fireCd2: 0, abilityCd: 0,
      overclockT: 0, spawnProtect: 0, invulnT: 0, ramCd: 0, hopT: 0, hopF: 0, rampT: 0, jumpCd: 0, boostPadT: 0, collideT: 0,
      shield: 0, upg1: 0, upg2: 0, upgAcc: 0, lastHitSlot: 'w1',
      steer: 0, boostEff: 1,
      inZone: 0, zoneT: 0,
      lastHitBy: null, lastHitT: -99, dmgDone: new Map(),
      slotsBy: new Map(),
      dmgSpots: [], // local-space visual damage: {x, z, s}
      cosmetics: cosmetics || {},
      csDirty: true, // cosmetics sent once per change (see snap())
      charges: (cls.ability && cls.ability.charges) || 0, // barge MINE LAYER
      chargeCd: 0,
      input: { up: 0, down: 0, left: 0, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, aimYaw: 0, aimPitch: 0 },
    };
    if (bot) this.botCount++;
    this.players.set(id, p);
    if (this.phase === 'play') p.spectating = true; // late joiners spectate
    this.fx('join', p.x, 0, p.z);
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (p.bot) this.botCount--;
    this.players.delete(id);
    if (this.phase === 'play') this.tickZone();
  }

  pickSpawn() {
    let best = SPAWNS[Math.floor(Math.random() * SPAWNS.length)], bestD = -1;
    for (const s of SPAWNS) {
      let d = Infinity;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        d = Math.min(d, Math.hypot(s.x - p.x, s.z - p.z));
      }
      if (d > bestD) { bestD = d; best = s; }
    }
    return best;
  }

  fx(f, x, y, z, extra) { this.fxQueue.push(Object.assign({ f, x: r2(x), y: r2(y || 0), z: r2(z || 0) }, extra || {})); }

  // ---------------- match flow ----------------
  resetMatch() {
    this.projectiles = [];
    this.crates = [];
    this.pickups = (this.map.pickups || []).map(pk => ({ x: pk.x, z: pk.z, t: 0 })); // shield pickups live at match start
    this.sanitizePickups(); // enforce collectible spacing (see sanitizePickups)
    this.upgradePickup = null; // placed on the first tickPickups
    // CANNON COVE batteries: staggered idle timers so the bay mouth doesn't
    // fire everything at once (phase: idle → warn → fire → idle)
    this.cannons = (this.map.cannons || []).map((c, i) => ({ i, def: c, t: 2.5 + i * 2.2, phase: 'idle', aim: null, aimIdx: 0 }));
    this.fxQueue = [];
    this.killFeed = [];
    this.winnerId = null;
    this.crateT = 8;
    this.trickleT = 0;
    let i = 0;
    for (const p of this.players.values()) {
      const sp = SPAWNS[i++ % SPAWNS.length];
      p.x = sp.x + (Math.random() - 0.5) * 6; p.y = 0; p.z = sp.z + (Math.random() - 0.5) * 6;
      p.vx = 0; p.vy = 0; p.vz = 0;
      p.ang = Math.random() * TAU; p.turretYaw = p.ang; p.turretPitch = 0;
      p.hp = p.def.hp; p.maxHp = p.def.hp; p.credits = 0;
      p.w1 = 0; p.w2 = 0; p.hull = 0;
      p.score = 0; p.kills = 0; p.deaths = 0; p.streak = 0;
      p.alive = true; p.spectating = false; p.respawnT = 0;
      p.boostT = 0; p.boostCd = 0; p.fireCd1 = 0; p.fireCd2 = 0; p.abilityCd = 0;
      p.overclockT = 0; p.spawnProtect = PHYS.spawnProtect; p.invulnT = 0; p.ramCd = 0; p.burst = null;
      p.hopT = 0; p.hopF = 0; p.rampT = 0; p.boostPadT = 0; p.steer = 0; p.boostEff = 1; p.collideT = 0;
      p.shield = 0; p.upg1 = 0; p.upg2 = 0; p.upgAcc = 0; p.lastHitSlot = 'w1';
      p.lastHitBy = null; p.lastHitT = -99; p.dmgDone = new Map();
      p.slotsBy = new Map();
      p.dmgSpots = [];
    }
  }

  startCountdown() {
    this.fillBots();
    this.resetMatch();
    this.phase = 'countdown';
    this.phaseT = 0;
    this.fx('horn', 0, 0, 0);
  }

  startPlay() {
    this.phase = 'play';
    this.phaseT = 0;
    this.timer = this.mode.time;
  }

  endMatch(winnerId) {
    this.phase = 'end';
    this.phaseT = 0;
    this.winnerId = winnerId || null;
    this.fx('horn', 0, 0, 0);
  }

  toLobby() {
    this.phase = 'lobby';
    this.phaseT = 0;
    this.fillBots();
  }

  fillBots() {
    if (!this.botsOn) return; // Add Bots = No — the lobby stays bot-free
    const target = Math.min(this.botTarget, PHYS.maxPlayers);
    let guard = 0;
    while (this.players.size < target && guard++ < 50) {
      const cls = Object.keys(CLASSES)[Math.floor(Math.random() * 3)];
      const p = this.addPlayer(BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)], cls, {}, true);
      if (this.phase === 'lobby') p.alive = true;
    }
    if (this.phase === 'lobby') {
      for (const p of [...this.players.values()]) {
        if (p.bot && this.players.size > target) this.removePlayer(p.id);
      }
    }
  }

  tryBuy(p, track) {
    if (PHYS.shopDisabled) return { ok: false, why: 'shop-disabled' };
    if (!p || !p.alive) return { ok: false, why: 'dead' };
    const key = track === 'hull' ? 'hull' : track;
    const tiers = p.def[key].tiers;
    const cur = p[key];
    if (cur >= tiers.length - 1) return { ok: false, why: 'max' };
    const next = tiers[cur + 1];
    if (p.credits < next.cost) return { ok: false, why: 'credits' };
    p.credits -= next.cost;
    p[key] = cur + 1;
    if (key === 'hull') {
      p.maxHp = p.def.hp + next.hp;
      p.hp = Math.min(p.maxHp, p.hp + next.hp * 0.6);
    }
    this.fx('buy', p.x, 0.5, p.z);
    return { ok: true };
  }

  // ---------------- update ----------------
  update(dt) {
    this.tickN++;
    this.time += dt;
    this.phaseT += dt;
    this.killFeed = [];
    if (this.phase === 'countdown') {
      if (this.phaseT >= PHYS.countdown) this.startPlay();
      this.simulatePlayers(dt);
    } else if (this.phase === 'play') {
      this.timer -= dt;
      this.simulatePlayers(dt);
      this.tickPickups(dt);
      this.tickCannons(dt);
      this.simulateProjectiles(dt);
      this.simulateCrates(dt);
      this.tickZone();
      this.checkRumble();
    } else if (this.phase === 'end') {
      if (this.phaseT >= PHYS.endTime) this.toLobby();
    }
  }

  checkLastStand() {
    let alive = 0, last = null;
    for (const p of this.players.values()) {
      if (p.alive) { alive++; last = p; }
    }
    if (alive <= 1) this.endMatch(alive === 1 ? last.id : null);
    else if (this.timer <= 0) {
      let lead = null;
      for (const p of this.players.values()) if (!lead || p.score > lead.score) lead = p;
      this.endMatch(lead.id);
    }
  }

  checkRumble() {
    if (this.timer <= 0) {
      let lead = null;
      for (const p of this.players.values()) if (!lead || p.score > lead.score) lead = p;
      this.endMatch(lead.id);
      return;
    }
    for (const p of this.players.values()) {
      if (this.mode.scoreCap > 0 && p.score >= this.mode.scoreCap) { this.endMatch(p.id); return; }
    }
  }

  simulatePlayers(dt) {
    for (const p of this.players.values()) {
      if (!p.alive) {
        if (p.respawnT > 0) {
          p.respawnT -= dt;
          if (p.respawnT <= 0 && this.mode.respawn > 0) this.respawn(p);
        }
        continue;
      }
      const inp = p.input;
      p.fireCd1 -= dt; p.fireCd2 -= dt; p.boostCd -= dt; p.abilityCd -= dt; p.ramCd -= dt; p.chargeCd -= dt;
      // GATLING BURST queue: churn out the staggered slugs machine-gun style
      if (p.burst && p.burst.n > 0) {
        p.burst.t -= dt;
        while (p.burst.t <= 0 && p.burst.n > 0) {
          this.burstShot(p, p.burst);
          p.burst.t += p.burst.step;
          p.burst.n--;
        }
        if (p.burst.n <= 0) p.burst = null;
      }
      p.spawnProtect = Math.max(0, p.spawnProtect - dt);
      p.invulnT = Math.max(0, p.invulnT - dt);
      p.overclockT = Math.max(0, p.overclockT - dt);
      p.boostT = Math.max(0, p.boostT - dt);
      p.hopT = Math.max(0, p.hopT - dt);
      p.hopF = Math.max(0, p.hopF - dt); // full-hop-flight timer (momentum guard)
      p.boostPadT = Math.max(0, p.boostPadT - dt); // racing-style boost window
      p.rampT = Math.max(0, p.rampT - dt);

      // wave-relative airborne: riding the swell (y ≈ waveH) is NOT airborne —
      // the hull keeps thrust and full turn authority on the water.
      const wy = Math.max(0, waveH(p.x, p.z, this.time));
      const airborne = p.y > wy + 0.35;
      const onRamp = p.rampT > 0;

      // steering — ramped, analog (gamepad) or digital (keys), and scaled by
      // speed so the hull feels weighty: barely rotates when stopped, bites at
      // speed. The only traversal difficulty is the water itself.
      let steerTarget;
      if (typeof inp.steer === 'number') steerTarget = inp.steer;
      else steerTarget = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
      steerTarget = clamp(steerTarget, -1, 1);
      p.steer += (steerTarget - p.steer) * Math.min(1, 20 * dt); // snappy ramp
      const spdNow = Math.hypot(p.vx, p.vz);
      const speedFactor = clamp(spdNow / Math.max(1, p.def.speed), 0.45, 1);
      p.ang += p.steer * p.def.turn * speedFactor * ((airborne && !onRamp) ? PHYS.airTurnMul : 1) * dt;

      // thrust — water only (ramps included: you drive up them; a hop keeps
      // the throttle so momentum carries through the air)
      let thrust = 0;
      if (!airborne || onRamp || p.hopT > 0 || p.hopF > 0) {
        if (inp.up) thrust = p.def.speed;
        else if (inp.down) thrust = -p.def.reverse;
        if (inp.boost && p.boostCd <= 0 && p.boostT <= 0) {
          p.boostT = PHYS.boostTime;
          p.boostCd = p.def.boostCd;
          this.fx('boost', p.x, 0.4, p.z, { a: p.ang });
        }
        if (inp.ab && p.abilityCd <= 0) this.useAbility(p);
      } else {
        if (inp.ab && p.abilityCd <= 0 && p.cls === 'razorfin') this.useAbility(p); // gatling works airborne too
      }
      // boost (ramped so the surge doesn't jerk)
      p.boostEff += ((p.boostT > 0 ? p.def.boostMul : 1) - p.boostEff) * Math.min(1, 6 * dt);
      const spd = thrust * p.boostEff;
      const k = Math.min(1, p.def.accel * dt);
      // BOOST-RAMP (racing-game reference — Mario Kart/TrackMania pads): the
      // hull gets a fixed forward surge at ~2.2x its top speed plus a boost
      // WINDOW during which the engine holds that speed along your heading —
      // steerable, persistent, then it decays. Not a one-frame spike.
      const boostSpd = p.boostPadT > 0 ? p.def.speed * PHYS.rampBoostSpd : 0;
      const target = thrust < 0 ? thrust * p.boostEff : Math.max(thrust * p.boostEff, boostSpd);
      if (target > 0) {
        p.vx += (Math.cos(p.ang) * target - p.vx) * k;
        p.vz += (Math.sin(p.ang) * target - p.vz) * k;
      }

      // jump — Space/A: hop out of the water with a FORWARD KICK (the hull
      // carries its momentum — no pop-in-place) and a higher arc
      p.jumpCd = Math.max(0, p.jumpCd - dt);
      if (inp.jump && p.jumpCd <= 0 && p.hopT <= 0 && p.rampT <= 0 && !airborne) {
        p.vy = PHYS.jumpVy;
        p.vx += Math.cos(p.ang) * PHYS.jumpFwd;
        p.vz += Math.sin(p.ang) * PHYS.jumpFwd;
        p.hopT = 0.35;
        p.hopF = 0.85; // momentum protection lasts the WHOLE flight (rise + fall)
        p.jumpCd = PHYS.jumpCd;
        this.fx('hop', p.x, 0.4, p.z);
      }

      // drag: glide while the boost window lasts, water drag normally, and
      // the extra air drag only for true airborne (platforms/ramps ride as
      // onRamp — water-like; hops are protected by their flight timer)
      const damp = Math.max(0, 1 - ((p.boostPadT > 0 ? PHYS.rampBoostDrag : p.def.drag) + ((airborne && !onRamp && p.hopT <= 0 && p.hopF <= 0 && p.boostPadT <= 0) ? PHYS.airDrag : 0)) * dt);
      p.vx *= damp; p.vz *= damp;
      p.vy *= Math.max(0, 1 - 0.6 * dt);

      // gravity
      if (p.y > 0) p.vy -= PHYS.gravity * dt;

      // integrate
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      // traversable platforms (rideable under the boost pads)
      this.ridePlatforms(p, dt);

      // solid terrain: rocks + island beaches push the hull out — boats slide
      // around them instead of clipping through (movement geometry stays clean)
      this.collideTerrain(p);

      // buoyancy spring (MarineSim3D concept): the hull settles toward the
      // swell with momentum — lags crests, plunges into troughs. Boat feel.
      const swimming = p.hopT <= 0 && p.rampT <= 0;
      if (swimming) {
        if (p.y >= wy + 0.02 && p.vy < 0 && p.y - wy < 1.1) {
          const impact = -p.vy;
          p.y = wy; p.vy = 0; p.hopT = 0; p.hopF = 0;
          if (impact > 7) {
            this.fx('land', p.x, 0, p.z, { s: impact });
            for (const o of this.players.values()) {
              if (o === p || !o.alive || o.y > 0.5) continue;
              const d = Math.hypot(o.x - p.x, o.z - p.z);
              if (d < PHYS.playerR * 2.4) {
                this.damage(o, p, PHYS.airSlamDmg, 'slam', 1, p.x, p.z);
                this.fx('ram', p.x, 0.4, p.z);
              }
            }
          } else if (impact > 2) this.fx('splash', p.x, 0, p.z);
        } else if (p.y <= wy + 0.7) {
          p.vy += (30.0 * (wy - p.y) - 8.0 * p.vy) * dt;
          p.y += p.vy * dt;
          if (p.y < wy - 0.55) { p.y = wy - 0.55; p.vy = Math.max(0, p.vy); }
        }
      }
      if (p.y < 0) { p.y = 0; p.vy = 0; }

      // turret: yaw + pitch (clamped to weapon 1 envelope)
      p.turretYaw = (p.turretYaw + clamp(angDiff(inp.aimYaw, p.turretYaw), -p.def.turretTurn * dt, p.def.turretTurn * dt)) % TAU;
      const w1 = p.def.w1.tiers[p.w1];
      const maxP = Math.max(w1.maxPitch, 0.5);
      const wantP = clamp(inp.aimPitch, -0.3, maxP);
      p.turretPitch += clamp(angDiff(wantP, p.turretPitch), -p.def.turretTurn * dt, p.def.turretTurn * dt);

      // firing
      const cdMul = p.overclockT > 0 ? PHYS.overclockMul : 1;
      if (inp.fire1 && p.fireCd1 <= 0) { p.fireCd1 = this.fireWeapon(p, 'w1') * cdMul; }
      if (inp.fire2 && p.fireCd2 <= 0) { p.fireCd2 = this.fireWeapon(p, 'w2') * cdMul; }

      // walls (only when below wall height) — kill the INTO-component only:
      // the boat slides along the boundary; the old 0.35 reverse-bounce
      // fought the drive every frame (oscillating at the wall = choppy)
      const A = PHYS.arena;
      if (p.y < PHYS.wallH) {
        if (p.x < -A + 2) { p.x = -A + 2; this.collideSlide(p, 1, 0); }
        if (p.x > A - 2) { p.x = A - 2; this.collideSlide(p, -1, 0); }
        if (p.z < -A + 2) { p.z = -A + 2; this.collideSlide(p, 0, 1); }
        if (p.z > A - 2) { p.z = A - 2; this.collideSlide(p, 0, -1); }
      }

      // skyisles only — rocks + island beaches are handled by collideTerrain
      // (a single pass; the old double-push here fought it and tripped boats)
      for (const si of this.map.skyisles || []) {
        if (p.y < si.y - 1 || p.y > si.y + 2) continue; // only collide when flying at that height
        this.aabbPush(p, si.x, si.z, si.w, si.d);
      }

      // collision-recovery window: for 0.5 s after a solid hit, keep easing
      // the heading toward the actual motion so a violent redirect (rock
      // corner, wall, boat ram) never leaves the hull crab-walking once the
      // contact ends (the event-time snap alone can't finish a full
      // reversal while the pair drifts apart below the snap threshold).
      // Gated on forward throttle (same as collideSlide): releasing W during
      // the window pauses the easing — a drifting hull keeps its orientation.
      if (p.collideT > 0) {
        p.collideT -= dt;
        if (p.input && p.input.up) {
          const spdC = Math.hypot(p.vx, p.vz);
          if (spdC > 1.5) {
            const dC = angDiff(Math.atan2(p.vz, p.vx), p.ang);
            if (Math.abs(dC) > 0.2) p.ang = ((p.ang + dC * 0.35) % TAU + TAU) % TAU;
          }
        }
      }

      // credit trickle (once per frame, not per player)
      this.trickleT += dt;
      if (this.trickleT >= PHYS.trickleEvery) {
        this.trickleT = 0;
        for (const q of this.players.values()) if (q.alive) q.credits += PHYS.trickleCredits;
      }
    }
    this.ramCheck();
  }

  aabbPush(p, rx, rz, w, d) {
    const cx = Math.max(rx - w / 2, Math.min(p.x, rx + w / 2));
    const cz = Math.max(rz - d / 2, Math.min(p.z, rz + d / 2));
    const dx = p.x - cx, dz = p.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 < PHYS.playerR * PHYS.playerR) {
      const dist = Math.sqrt(d2) || 0.001;
      const push = (PHYS.playerR - dist) / dist;
      p.x += dx * push; p.z += dz * push;
      this.collideSlide(p, dx / dist, dz / dist);
    }
  }

  // COLLISION PROTECTION — every solid hit (terrain, skyisles, walls,
  // boat-boat) funnels through here. Two jobs: (1) kill ONLY the
  // into-obstacle velocity component so the hull slides at speed, and
  // (2) ease the hull's HEADING toward the actual slide direction while in
  // contact. Without (2), the drive keeps pulling velocity back into the
  // obstacle for ~5 ticks after every hit — velocity swings up to ~1 rad
  // off the heading (measured: t11 div 1.06, speed 13→6.5) and the canoe
  // crabs sideways: "off balance / not driving correctly during collision".
  collideSlide(p, nx, nz) {
    const into = p.vx * nx + p.vz * nz;
    if (into < 0) { p.vx -= nx * into; p.vz -= nz * into; }
    // DRIFT HARDENING (user: "times when drifting the orientation changes
    // and it no longer drives straight"): the heading ease is a DRIVING aid.
    // Measured (probe-drift.js): a coasting hull touching a wall obliquely
    // got its bow eased 45.7° off course — the ship then drove that new
    // direction on throttle. A hull with NO forward throttle (drifting)
    // keeps its orientation: the velocity kill still slides it, and the
    // drive re-converges to the frozen heading when W returns.
    if (!(p.input && p.input.up)) return;
    const spd = Math.hypot(p.vx, p.vz);
    if (spd > 1.5) {
      const d = angDiff(Math.atan2(p.vz, p.vx), p.ang);
      if (Math.abs(d) > 0.2) {
        p.ang = ((p.ang + d * 0.35) % TAU + TAU) % TAU;
        p.collideT = 0.5; // collision-recovery window: keep aligning below
      }
    }
  }

  // solid terrain: rocks + island beaches are AABBs that push the hull out.
  // NORMAL-based push (stable at corners — no axis flipping) that kills ONLY
  // the INTO-obstacle velocity component, so the boat SLIDES around the
  // obstacle at full speed instead of tripping on it (the old dual system —
  // this + a second aabbPush pass — fought itself: the canoe bled speed,
  // rattled at corners, and crabbed off-heading = "tripped up, won't drive
  // straight, choppy").
  collideTerrain(p) {
    const r = PHYS.playerR;
    const obs = [];
    for (const rk of this.map.rocks) obs.push({ x: rk.x, z: rk.z, w: rk.w, d: rk.d, top: rk.h + 0.4 });
    for (const isl of this.map.isles) obs.push({ x: isl.x, z: isl.z, w: isl.w + 1.2, d: isl.d + 1.2, top: isl.y + 2.3 });
    for (const ob of obs) {
      if (p.y > ob.top) continue; // flying over
      const cx = Math.max(ob.x - ob.w / 2, Math.min(p.x, ob.x + ob.w / 2));
      const cz = Math.max(ob.z - ob.d / 2, Math.min(p.z, ob.z + ob.d / 2));
      const dx = p.x - cx, dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      const dist = Math.sqrt(d2) || 0.001;
      const push = (r - dist) / dist;
      p.x += dx * push; p.z += dz * push;
      // kill only the INTO-obstacle component + heading snap — the boat
      // slides, never trips (collideSlide = collision protection)
      const nx = dx / dist, nz = dz / dist;
      this.collideSlide(p, nx, nz);
    }
  }

  // TRAVERSABLE PLATFORM + BOOST PAD (racing-slide reference): under each
  // boost zone sits a solid platform the hull can drive ONTO — an entry
  // slope rises from the water to a flat top, and the canoe rides it and
  // moves across it exactly like water (full thrust + steering, no air drag).
  // Crossing the pad while riding launches the canoe FORWARD AND UP at an
  // angle, held by the boost window.
  ridePlatforms(p, dt) {
    for (const z of this.map.boostZones || []) {
      const h = z.h || 1.3;
      const along = z.dir === 'x' ? p.x - z.x : p.z - z.z;
      const across = z.dir === 'x' ? p.z - z.z : p.x - z.x;
      if (Math.abs(across) > z.w / 2 + 0.6) continue;
      const prog = (along * z.sign + z.d / 2) / z.d; // 0 = entry edge, 1 = exit
      if (prog < -0.02 || prog > 1.05) continue;
      if (p.hopT > 0 || p.hopF > 0) continue; // hops fly over it
      // entry slope (first 30%) rises from the water to the flat top
      const surf = h * Math.max(0, Math.min(1, prog / 0.3));
      if (p.y < surf) { p.y = surf; p.vy = Math.max(0, p.vy); }
      p.rampT = 0.4; // "on a ramp": full thrust/steering, no air drag — water-like
      // crossing the PAD (the exit strip past 65%, where the pad is rendered)
      // while riding → launch forward AND up at an angle. Driving onto the
      // platform alone does NOT trigger — you ride across it first.
      if (p.boostPadT <= 0 && prog > 0.65 && p.y <= surf + 0.5) {
        const spd = Math.hypot(p.vx, p.vz);
        const surge = Math.max(spd, p.def.speed * PHYS.rampBoostSpd);
        p.vx = Math.cos(p.ang) * surge;
        p.vz = Math.sin(p.ang) * surge;
        p.vy = Math.min(13.5, 7.5 + spd * 0.18);
        p.boostPadT = PHYS.rampBoostT;
        this.fx('launch', p.x, surf, p.z, { a: p.ang });
        return;
      }
      return;
    }
  }

  ramCheck() {
    const arr = [...this.players.values()].filter(p => p.alive && p.ramCd <= 0);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        const dx = b.x - a.x, dz = b.z - a.z, dy = (b.y + 0.4) - (a.y + 0.4);
        const dist = Math.hypot(dx, dz);
        const minD = PHYS.playerR * 2 * 0.85;
        if (dist >= minD || dist === 0) continue;
        if (Math.abs(dy) > 2.6) continue; // vertically separated
        const nx = dx / dist, nz = dz / dist;
        const overlap = (minD - dist) / 2;
        a.x -= nx * overlap; a.z -= nz * overlap;
        b.x += nx * overlap; b.z += nz * overlap;
        const relvx = b.vx - a.vx, relvz = b.vz - a.vz;
        const relSpd = relvx * nx + relvz * nz;
        if (relSpd > PHYS.ramMinRelSpeed) {
          const faster = relSpd > 0 ? b : a;
          const mul = faster.def.ramMul * (faster.boostT > 0 ? 2 : 1) * (faster.y > 0.5 ? 1.5 : 1);
          const dmg = (PHYS.ramBase + relSpd * PHYS.ramSpeedMul) * mul;
          const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
          this.damage(b, faster, dmg, 'ram', 0.6, mx, mz);
          this.damage(a, faster, dmg * 0.35, 'ram', 0.6, mx, mz);
          faster.ramCd = 0.8;
          this.fx('ram', mx, Math.max(a.y, b.y) + 0.4, mz);
        }
        const mSum = a.def.mass + b.def.mass;
        const am = b.def.mass / mSum, bm = a.def.mass / mSum;
        // momentum exchange — symmetric impulse that AVERAGES the relative
        // velocity so the pair separates (the old sign convention diverged:
        // head-on rams accelerated BOTH hulls into each other every tick —
        // the "rubbing" jitter between boats). 1.15 = slightly elastic, so a
        // head-on approach actually reverses instead of settling at the
        // equilibrium distance and rubbing.
        a.vx += relvx * am * 1.15; a.vz += relvz * am * 1.15;
        b.vx -= relvx * bm * 1.15; b.vz -= relvz * bm * 1.15;
        // collision protection: ease both hulls' headings toward their
        // post-hit slide directions — a ram must not leave either boat
        // crab-walking (heading still pointed into the other hull while the
        // velocity slides sideways)
        this.collideSlide(a, -nx, -nz);
        this.collideSlide(b, nx, nz);
      }
    }
  }

  // ALTERNATE ABILITY — every canoe has its own ATTACK form on a cooldown
  // timer, fired from the turret toward the aim:
  //   razorfin → GATLING BURST (10 rail slugs churned out over ~0.6 s)
  //   barge    → THUNDER SHOTGUN (9 pellets, blank range, waterline rake)
  //   rocket   → MISSILE RAIN  (4 rockets, wide fan — explosive sweep)
  useAbility(p) {
    p.abilityCd = p.def.ability.cd;
    this.fx('ability', p.x, p.y + 0.5, p.z, { a: p.ang, c: p.cls });
    const w1 = p.def.w1.tiers[0]; // the class's own base weapon drives the burst
    if (p.cls === 'razorfin') {
      // GATLING BURST — the machine-gun churn: 10 fast rail slugs staggered
      // over ~0.6 s (not a single simultaneous volley), tight random cone
      p.burst = { kind: 'rail', tier: w1, n: 10, t: 0, spread: 0.05, lift: -0.02, step: 0.065 };
    } else if (p.cls === 'barge') {
      // MINE LAYER — the barge is the mine canoe (retired: the THUNDER
      // SHOTGUN blast, user: "the barge should be the one canoe that can
      // drop mines"). 3 charges, 0.5 s between drops, 10 s refill (user:
      // "reduce barge special main cooldown from 60 sec to 10 sec"). Each
      // press drops ONE mine behind the hull; the refill re-grants all 3.
      if (!(p.charges > 0)) {
        // exhausted (or first use) → the 10 s cd just expired: refill
        p.charges = p.def.ability.charges;
        p.chargeCd = 0;
      }
      if (p.charges > 0 && p.chargeCd <= 0) {
        p.charges--;
        p.chargeCd = p.def.ability.chargeCd;
        this.dropMine(p);
        // dry → the 10 s refill starts; otherwise the 0.5 s charge gap
        // paces the next drop (no long cd consumed yet)
        p.abilityCd = p.charges <= 0 ? p.def.ability.cd : 0;
      } else {
        // blocked by the 0.5 s charge gap: no cd consumed
        p.abilityCd = 0;
      }
    } else this.abilityBurst(p, w1, 'rocket', 4, 0.15, 0.02);
  }

  // drop one sea mine behind the hull (the barge's MINE LAYER special)
  dropMine(p) {
    const m = p.def.ability.mine;
    const bx = p.x - Math.cos(p.ang) * 2.6, bz = p.z - Math.sin(p.ang) * 2.6;
    this.projectiles.push({
      id: this.nextPid++, x: bx, y: 0, z: bz, vx: 0, vy: 0, vz: 0,
      ax: p.ang, ap: 0, owner: p.id, tier: m, ttl: m.life, life: m.life, age: 0, hit: new Set(),
      kind: 'mine', split: 0, dead: false, hp: m.hp, hpMax: m.hp,
    });
    this.fx('splash', bx, 0.2, bz, { s: 1 });
  }

  // one staggered GATLING slug — spawned at the turret muzzle with a small
  // random cone; the burst queue in tickProjectiles paces them machine-gun style
  burstShot(p, b) {
    const yaw = p.turretYaw + (Math.random() - 0.5) * b.spread * 2;
    const pitch = Math.max(-0.3, Math.min(b.tier.maxPitch || 0.6, p.turretPitch + b.lift));
    const cy = Math.cos(pitch), sy = Math.sin(pitch);
    const tz = 3.3 * p.def.size * 0.2;
    const tip = b.tier.tip || b.tier.barrelLen || 1.5;
    const mx = p.x + Math.cos(yaw) * (tz + cy * tip);
    const my = p.y + PHYS.muzzleY + ((b.tier.tipY ?? 0.25) - 0.25) + sy * tip;
    const mz = p.z + Math.sin(yaw) * (tz + cy * tip);
    this.projectiles.push({
      id: this.nextPid++, x: mx, y: my, z: mz,
      vx: Math.cos(yaw) * cy * b.tier.spd, vy: sy * b.tier.spd, vz: Math.sin(yaw) * cy * b.tier.spd,
      ax: yaw, ap: pitch, owner: p.id, tier: b.tier, ttl: b.tier.life, life: b.tier.life, age: 0, hit: new Set(),
      kind: b.kind, split: 0, kback: b.tier.kback || 0, slot: 'w1', tierN: 0, lv: p.upg1,
    });
  }

  abilityBurst(p, tier, kind, count, yawSpread, pitchLift, lifeOverride, absPitch) {
    for (let i = 0; i < count; i++) {
      const off = i - (count - 1) / 2;
      const yaw = p.turretYaw + off * yawSpread;
      // absPitch (the barge shotgun): the blast is pinned at −0.12 rad ≈ 7°
      // DOWN regardless of the aim elevation — a relative rake lets the burst
      // point UP whenever the turret is raised, which reads as "not angled
      // down" no matter how deep the rake is (measured live via TJAB).
      const pitch = absPitch ? -0.12 : Math.max(-0.3, Math.min(tier.maxPitch || 0.6, p.turretPitch + pitchLift));
      const cy = Math.cos(pitch), sy = Math.sin(pitch);
      const tz = 3.3 * p.def.size * 0.2;
      const tip = tier.tip || tier.barrelLen || 1.5;
      const mx = p.x + Math.cos(yaw) * (tz + cy * tip);
      const my = p.y + PHYS.muzzleY + ((tier.tipY ?? 0.25) - 0.25) + sy * tip;
      const mz = p.z + Math.sin(yaw) * (tz + cy * tip);
      const life = lifeOverride || tier.life;
      this.projectiles.push({
        id: this.nextPid++, x: mx, y: my, z: mz,
        vx: Math.cos(yaw) * cy * tier.spd, vy: sy * tier.spd, vz: Math.sin(yaw) * cy * tier.spd,
        ax: yaw, ap: pitch, owner: p.id, tier, ttl: life, life, age: 0, hit: new Set(),
        kind, split: 0, kback: tier.kback || 0, slot: 'w1', tierN: 0, lv: p.upg1,
      });
    }
  }

  // King of the Hill: hold the zone to earn points (respawn mode, timer decides)
  tickZone() {
    const z = this.mode.zone;
    if (!z || this.phase !== 'play') return;
    for (const p of this.players.values()) {
      if (!p.alive || p.spectating) { p.inZone = 0; continue; }
      const d = Math.hypot(p.x - z.x, p.z - z.z);
      p.inZone = d < z.r ? 1 : 0;
      if (p.inZone) {
        p.score += z.rate * dt;
        p.zoneT = (p.zoneT || 0) + dt;
      }
    }
  }

  // barrel-accurate muzzle: projectile leaves the VISUAL barrel tip.
  // The barrel pivots at the mount (turretZ forward), so the tip is
  // (turretZ + cos(pitch)*tip) ahead and muzzleY + (tipY-0.25) + sin(pitch)*tip
  // up — `tip`/`tipY` are measured from the built weapon meshes.
  fireWeapon(p, slot) {
    const tier = p.def[slot].tiers[p[slot]];
    const n = tier.count || 1;
    const cd = tier.cd;
    const cy = Math.cos(p.turretPitch), sy = Math.sin(p.turretPitch);
    const tip = tier.tip || tier.barrelLen || 1.5;
    const tipY = tier.tipY ?? 0.25;
    const tz = 3.3 * p.def.size * 0.2;
    const mx = p.x + Math.cos(p.turretYaw) * (tz + cy * tip);
    const my = p.y + PHYS.muzzleY + (tipY - 0.25) + sy * tip;
    const mz = p.z + Math.sin(p.turretYaw) * (tz + cy * tip);
    this.fx('muzzle', mx, my, mz, { a: p.turretYaw, p: p.turretPitch, c: p.cls, s: slot });

    if (tier.kind === 'mine') {
      const bx = p.x - Math.cos(p.ang) * 2.6, bz = p.z - Math.sin(p.ang) * 2.6;
      this.projectiles.push({
        id: this.nextPid++, x: bx, y: 0, z: bz, vx: 0, vy: 0, vz: 0,
        ax: p.ang, ap: 0, owner: p.id, tier, ttl: tier.life, life: tier.life, age: 0, hit: new Set(),
        kind: 'mine', split: 0, dead: false,
        hp: tier.hp || 30, hpMax: tier.hp || 30,
      });
      return cd;
    }
    for (let i = 0; i < n; i++) {
      const off = (n - 1) / 2;
      const spreadYaw = (i - off) * ((tier.spread || 0) / Math.max(1, n - 1));
      const yaw = p.turretYaw + spreadYaw + (Math.random() - 0.5) * 0.03;
      // FIRE AT THE LIVE AIM: the shell spawns at the clamped INPUT pitch, not
      // the converged turretPitch — the turret lags one round-trip behind the
      // client's prediction, so firing at it made every quick shot leave
      // flatter than the barrel/arc ("the cannon asset isn't matching the
      // pitch of the shot"). Muzzle POSITION stays at the physical barrel.
      const inpAim = p.input && typeof p.input.aimPitch === 'number' ? p.input.aimPitch : p.turretPitch;
      const maxP = Math.max(tier.maxPitch || 0.6, 0.5);
      const pitch = Math.max(-0.3, Math.min(maxP, inpAim)) + (Math.random() - 0.5) * 0.02;
      const c2 = Math.cos(pitch), s2 = Math.sin(pitch);
      this.projectiles.push({
        id: this.nextPid++, x: mx, y: my, z: mz,
        vx: Math.cos(yaw) * c2 * tier.spd, vy: s2 * tier.spd, vz: Math.sin(yaw) * c2 * tier.spd,
        ax: yaw, ap: pitch, owner: p.id, tier, ttl: tier.life, life: tier.life, age: 0, hit: new Set(),
        kind: tier.kind, split: 0, kback: tier.kback || 0, slot,
        arm: tier.arm || 0,
        // DEFINED range window: arm = min (fly through everything until
        // traveled), maxRange = hard cap (detonate at the max — the barge's
        // shells are a long-range specialist: 15 u min (close edge), 500 u max)
        maxRange: tier.maxRange || 0, travel: 0,
        tierN: p[slot], lv: slot === 'w2' ? p.upg2 : p.upg1,
      });
    }
    return cd;
  }

  simulateProjectiles(dt) {
    const alive = [...this.players.values()];
    const next = [];
    for (const q of this.projectiles) {
      q.age += dt;
      q.ttl -= dt;
      if (q.ttl <= 0) { this.explode(q, q.x, q.y, q.z); continue; }

      if (q.kind === 'mine') {
        let popped = false;
        if (q.age > 0.6) {
          for (const p of alive) {
            if (!p.alive || p.id === q.owner) continue;
            const d = Math.hypot(p.x - q.x, p.z - q.z);
            if (d < 4.2) { this.explode(q, q.x, 0.3, q.z); popped = true; break; }
            if (d < 6.5) {
              p.vx += (p.x - q.x) / d * 2.2;
              p.vz += (p.z - q.z) / d * 2.2;
            }
          }
        }
        if (!popped && !q.dead) next.push(q);
        continue;
      }

      if (q.kind === 'torp') {
        // torpedoes fly STRAIGHT (no homing — the user vetoed the steering
        // missile mechanic); they accelerate as they run
        const spd = Math.min(22, (q.tier.spd || 17) + (q.life - q.ttl) * 0.7);
        q.vx = Math.cos(q.ax) * Math.cos(q.ap) * spd;
        q.vy = Math.sin(q.ap) * spd;
        q.vz = Math.sin(q.ax) * Math.cos(q.ap) * spd;
        q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
        if (q.y < 0.1) { q.y = 0.1; q.vy = Math.abs(q.vy) * 0.5; } // torps skip on water
        for (const p of alive) {
          if (!p.alive || p.id === q.owner) continue;
          if (Math.hypot(p.x - q.x, p.z - q.z) < 2.6 && Math.abs(p.y + 0.4 - q.y) < 2.4) { this.explode(q, q.x, q.y, q.z); break; }
        }
        if (this.hitWalls(q)) this.explode(q, q.x, q.y, q.z);
        next.push(q);
        continue;
      }

      // cluster split
      if (q.split === 0 && q.tier.split && q.age > q.life - 0.35) {
        q.split = 1;
        for (let i = 0; i < 3; i++) {
          const a = q.ax + (i - 1) * 0.5;
          next.push({
            id: this.nextPid++, x: q.x, y: q.y, z: q.z,
            vx: Math.cos(a) * 24, vy: 5, vz: Math.sin(a) * 24,
            ax: a, ap: 0.2, owner: q.owner,
            tier: { dmg: 8, spd: 24, splash: 2.5, life: 1.3, maxPitch: 0.5 },
            ttl: 1.3, life: 1.3, age: 0, hit: new Set(), kind: 'bomblet', split: 0,
          });
        }
        continue;
      }

      // gravity + integrate (3D ballistic)
      q.vy -= (q.tier && q.tier.grav ? q.tier.grav : PHYS.gravity) * dt; // per-tier grav (barge lobs)
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      q.ax = Math.atan2(q.vz, q.vx);
      q.ap = Math.atan2(q.vy, Math.hypot(q.vx, q.vz));

      // arming distance — the barge cannon is a LONG-RANGE specialist: its
      // shells fly through everything (players, mines, water) until they've
      // traveled the arming distance (the DEFINED minimum range), so the
      // close range belongs to the shotgun and the cannon's usable window
      // starts at minRange
      if (q.arm > 0) {
        q.arm -= Math.hypot(q.vx, q.vz) * dt;
        if (q.arm > 0) { next.push(q); continue; }
      }

      // DEFINED maximum range — hard cap on the travel distance (the shells
      // would otherwise keep arcing until the ttl; the water usually claims
      // them first, but the cap makes the max explicit and deterministic)
      if (q.maxRange > 0) {
        q.travel += Math.hypot(q.vx, q.vz) * dt;
        if (q.travel >= q.maxRange) { this.explode(q, q.x, Math.max(0, q.y), q.z); continue; }
      }

      // player hits (3D sphere) — checked BEFORE water/walls so flat shots
      // connect with canoes instead of dying at the waterline
      let dead = false;
      for (const p of alive) {
        if (!p.alive || p.id === q.owner) continue;
        if (q.hit.has(p.id)) continue;
        const dx = p.x - q.x, dz = p.z - q.z, dy = (p.y + PHYS.playerCenterY + 0.35) - q.y;
        const d = Math.hypot(dx, dz);
        if (d < PHYS.playerR + 0.5 && Math.abs(dy) < 2.2) {
          this.damage(p, this.players.get(q.owner), q.tier.dmg, q.kind, 1, q.x, q.z, q.slot);
          if (q.kback) { p.vx += Math.cos(q.ax) * q.kback; p.vz += Math.sin(q.ax) * q.kback; }
          if (q.tier.pierce > 0 && q.hit.size < q.tier.pierce) q.hit.add(p.id);
          else { this.explode(q, q.x, q.y, q.z, p.id); dead = true; break; }
        }
      }
      if (dead) continue;

      // shootable mines: ANY shot destroys them (hp 1) — the shooter gets the
      // credit. Hit box slightly larger than the sprite (mine ~0.9, shots
      // connect within 1.6) so clipping the spikes counts.
      if (q.kind !== 'mine') {
        for (const m of this.projectiles) {
          if (m.kind !== 'mine' || m.owner === q.owner || m.dead) continue;
          const dm = Math.hypot(m.x - q.x, m.z - q.z);
          if (dm < 1.6 && Math.abs(m.y + 0.4 - q.y) < 2.0) {
            m.hp = (m.hp || 1) - q.tier.dmg;
            if (m.hp <= 0) { this.explode(m, m.x, 0.3, m.z, null, q.owner); m.dead = true; }
            this.explode(q, q.x, q.y, q.z);
            dead = true;
            break;
          }
        }
        if (dead) continue;
      }

      // water impact — shotgun pellets SKIP like skipped stones (the blank
      // range has to rake the waterline: mines sit at y≈0, and a blast that
      // sinks at 3 u can never reach them). The skip is GENTLE (12% — was
      // 45%): a hard bounce made the blast visibly REBOUND UPWARD, which
      // read as "the shotgun doesn't angle down". Every water contact throws
      // a splash so the burst visibly sweeps down into the waterline.
      if (q.kind === 'shot' && q.y <= 0 && q.vy < 0) {
        q.y = 0; q.vy = -q.vy * 0.12;
        this.fx('splash', q.x, 0.1, q.z, {});
      }
      else if (q.y <= 0 && q.vy < 0) { this.explode(q, q.x, 0, q.z); continue; }

      // walls — only when below wall height
      if (q.y < PHYS.wallH && this.hitWalls(q)) { this.explode(q, q.x, q.y, q.z); continue; }

      // rocks / islands / skyisles (vertical AABB) — with a short spawn
      // grace so projectiles can escape a muzzle poking into geometry
      // (the muzzle sits at the visual barrel tip, which can overlap cover)
      let blocked = false;
      const grace = q.age < 0.08;
      if (!grace) {
        for (const rk of this.map.rocks) {
          if (q.y < rk.h && Math.abs(q.x - rk.x) < rk.w / 2 + 0.3 && Math.abs(q.z - rk.z) < rk.d / 2 + 0.3) {
            this.explode(q, q.x, q.y, q.z); blocked = true; break;
          }
        }
      }
      if (blocked) continue;
      if (!grace) {
        for (const isl of this.map.isles) {
          if (q.y < 1.2 && Math.abs(q.x - isl.x) < isl.w / 2 + 0.3 && Math.abs(q.z - isl.z) < isl.d / 2 + 0.3) {
            this.explode(q, q.x, q.y, q.z); blocked = true; break;
          }
        }
      }
      if (blocked) continue;
      next.push(q);
    }
    this.projectiles = next;
  }

  hitWalls(q) {
    const A = PHYS.arena;
    return q.x < -A + 1 || q.x > A - 1 || q.z < -A + 1 || q.z > A - 1;
  }

  explode(q, x, y, z, victimId, attackerId) {
    const splash = q.tier.splash || 0;
    if (splash > 0) {
      this.fx('boom', x, y, z, { s: splash, k: q.kind });
      for (const p of this.players.values()) {
        if (!p.alive || p.id === q.owner) continue;
        if (p.id === victimId) continue;
        const dx = p.x - x, dz = p.z - z, dy = (p.y + 0.4) - y;
        const d = Math.hypot(Math.hypot(dx, dz), dy);
        if (d < splash + 1.4) {
          const fall = 1 - (d / (splash + 1.4));
          this.damage(p, this.players.get(attackerId || q.owner), q.tier.dmg * (0.4 + 0.6 * fall), q.kind, 1, x, z, q.slot);
        }
      }
    } else {
      this.fx('splash', x, Math.max(0, y), z);
    }
  }

  // SHIELD PICKUPS: map items that respawn on RNG timers. Grabbing one gives
  // a full shield (absorbs damage before health). Only shields via pickups.
  tickPickups(dt) {
    for (const pk of this.pickups) {
      if (pk.t > 0) { pk.t -= dt; continue; }
      for (const p of this.players.values()) {
        if (!p.alive || p.shield >= PHYS.shieldMax) continue;
        if (Math.hypot(p.x - pk.x, p.z - pk.z) < 2.4) {
          p.shield = PHYS.shieldMax;
          pk.t = PHYS.shieldRespawn[0] + Math.random() * (PHYS.shieldRespawn[1] - PHYS.shieldRespawn[0]);
          this.fx('shield', pk.x, 0.8, pk.z, { v: p.id });
          break;
        }
      }
    }
    // WEAPON-UPGRADE PICKUP: floats above ONE of the map's boost ramps.
    // The 3D grab (must be at its height) means riding the ramp + jumping
    // is the ONLY way to reach it (water hops peak ~2.4 u; the pad + hop
    // peaks ~3.2-4.2 u). Grants +1 weapon level, same as a kill.
    if (!this.map.boostZones || !this.map.boostZones.length) return;
    if (!this.upgradePickup) this.placeUpgradePickup();
    const up = this.upgradePickup;
    if (up.t > 0) {
      up.t -= dt;
      if (up.t <= 0) this.placeUpgradePickup(); // respawn re-rolls the ramp
      return;
    }
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (Math.hypot(p.x - up.x, p.z - up.z) < 2.2 && Math.abs(p.y - up.y) < 1.4) {
        p.upg1 = Math.min(PHYS.killUpMax, p.upg1 + 1);
        up.t = 15 + Math.random() * 10;
        this.fx('pickup', up.x, up.y, up.z, { k: 'upgrade', d: 1 });
        break;
      }
    }
  }

  placeUpgradePickup() {
    const zones = this.map.boostZones;
    const z = zones[Math.floor(Math.random() * zones.length)];
    // THE JUMP POINT — the pickup floats IN THE AIR PAST the pad's exit
    // edge (3 u beyond it), on the measured boosted-flight path (barge
    // apex ≈ 2.6 u, razorfin ≈ 2.9 u): riding the ramp snags it mid-flight.
    // (user: "floating in the air after the ramp, so you jump while taking
    // the ramp/boost and if angled correctly, get the upgrade")
    const ex = z.dir === 'x' ? z.x + z.sign * (z.d / 2 + 3) : z.x;
    const ez = z.dir === 'z' ? z.z + z.sign * (z.d / 2 + 3) : z.z;
    this.upgradePickup = { x: ex, z: ez, y: (z.h || 1.3) + 1.2, t: 0 };
  }

  // ---- CANNON COVE batteries (environmental hazard) ----
  // idle → WARN (the aim point is telegraphed to the clients) → lob an
  // arcing shell. owner -1: hits everyone, no kill credit, and a kill
  // reads "claimed by the cove cannons".
  tickCannons(dt) {
    for (const c of this.cannons) {
      c.t -= dt;
      if (c.phase === 'idle') {
        if (c.t <= 0) {
          c.phase = 'warn';
          c.t = c.def.warn;
          c.aim = c.def.aims[c.aimIdx % c.def.aims.length];
          c.aimIdx++;
          this.fx('cannonWarn', c.aim.x, 0.2, c.aim.z, { cn: c.i, bx: c.def.x, bz: c.def.z });
        }
      } else if (c.phase === 'warn') {
        if (c.t <= 0) {
          c.phase = 'idle';
          c.t = c.def.every;
          this.fireCannon(c);
        }
      }
    }
  }

  fireCannon(c) {
    const d = c.def;
    const mx = d.x, my = d.y + 0.9, mz = d.z; // muzzle: battery top
    const dx = c.aim.x - mx, dz = c.aim.z - mz;
    const R = Math.hypot(dx, dz);
    const grav = 800;
    // HIGH-ARC lob that lands on the aim point (the fortress look)
    let pitch = Math.PI / 4;
    const sin2 = (R * grav) / (d.spd * d.spd);
    if (sin2 <= 1) pitch = Math.PI / 2 - 0.5 * Math.asin(sin2);
    const tHit = R <= 0.01 ? 0.4 : (2 * d.spd * Math.sin(pitch)) / grav;
    const yaw = Math.atan2(dz, dx);
    const tier = { dmg: d.dmg, splash: d.splash, grav };
    this.projectiles.push({
      id: this.nextPid++, x: mx, y: my, z: mz,
      vx: Math.cos(yaw) * Math.cos(pitch) * d.spd,
      vy: Math.sin(pitch) * d.spd,
      vz: Math.sin(yaw) * Math.cos(pitch) * d.spd,
      ax: yaw, ap: pitch, owner: -1, tier,
      ttl: tHit + 0.6, life: tHit + 0.6, age: 0, hit: new Set(),
      kind: 'cannon', split: 0, kback: 0, slot: null,
      arm: 0, maxRange: 0, tierN: 0, lv: 0,
    });
    this.fx('cannonFire', mx, my, mz, { cn: c.i });
  }

  // COLLECTIBLE SPACING — no two pickups closer than MIN_GAP, none closer
  // than ROCK_CLEAR to a rock/island face, none inside a ramp pad footprint.
  // Runs on every match reset so future map edits can never re-cluster them.
  sanitizePickups() {
    const MIN_GAP = 26, ROCK_CLEAR = 8, ARENA = 82;
    const obs = [];
    for (const rk of this.map.rocks) obs.push({ x: rk.x, z: rk.z, w: rk.w, d: rk.d });
    for (const isl of this.map.isles) obs.push({ x: isl.x, z: isl.z, w: isl.w, d: isl.d });
    const clear = (x, z, self) => {
      for (const o of this.pickups) {
        if (o === self) continue;
        if (Math.hypot(x - o.x, z - o.z) < MIN_GAP) return false;
      }
      for (const ob of obs) {
        const dx = x - ob.x, dz = z - ob.z;
        if (Math.abs(dx) < ob.w / 2 + ROCK_CLEAR && Math.abs(dz) < ob.d / 2 + ROCK_CLEAR) return false;
      }
      for (const zz of this.map.boostZones || []) {
        const along = zz.dir === 'x' ? Math.abs(x - zz.x) : Math.abs(z - zz.z);
        const across = zz.dir === 'x' ? Math.abs(z - zz.z) : Math.abs(x - zz.x);
        if (along < zz.d / 2 + 3 && across < zz.w / 2 + 3) return false;
      }
      return true;
    };
    // random-candidate search: only ACCEPT a position that satisfies every
    // constraint (the old spiral could end its tries still violating)
    for (const pk of this.pickups) {
      for (let tries = 0; tries < 80; tries++) {
        if (clear(pk.x, pk.z, pk)) break;
        pk.x = (Math.random() * 2 - 1) * ARENA;
        pk.z = (Math.random() * 2 - 1) * ARENA;
      }
    }
  }

  damage(victim, attacker, dmg, cause, mul, hx, hz, slot) {
    if (!victim || !victim.alive) return;
    if (victim.invulnT > 0) return;
    let real = dmg * mul;
    // upgrade-on-kill scaling: the weapon that earned upgrades hits harder
    if (attacker && attacker.id !== victim.id && slot) {
      const up = slot === 'w2' ? attacker.upg2 : attacker.upg1;
      real *= 1 + PHYS.killUpDmg * up;
    }
    if (victim.spawnProtect > 0) real *= PHYS.spawnProtectMul;
    if (real < 0.5) return;
    // ASSIST DAMAGE TRACKING — recorded BEFORE the shield absorbs anything:
    // chewing a shield counts toward the assist threshold (user: "assists
    // are not working correctly" — shield damage was silently dropped).
    if (attacker && attacker.id !== victim.id) {
      const cur = victim.dmgDone.get(attacker.id) || 0;
      victim.dmgDone.set(attacker.id, cur + real);
      victim.slotsBy.set(attacker.id, slot || victim.slotsBy.get(attacker.id) || 'w1');
    }
    // SHIELD absorbs first — same damage rules as health (no invuln bypass)
    if (victim.shield > 0) {
      const abs = Math.min(victim.shield, real);
      victim.shield -= abs;
      real -= abs;
      this.fx('shieldHit', victim.x, victim.y + 1, victim.z, { v: victim.id });
      if (real < 0.5) return;
    }
    victim.hp -= real;
    victim.lastHitBy = attacker ? attacker.id : null;
    victim.lastHitSlot = slot || victim.lastHitSlot;
    victim.lastHitT = this.tickN / 30;
    if (attacker && attacker.id !== victim.id) {
      attacker.credits += PHYS.hitCredits;
      this.fx('hit', victim.x, victim.y + 1.1, victim.z, { d: Math.round(real), v: victim.id, a: attacker.id });
    }
    // visual damage spot, in canoe-local space (where the shot landed).
    // The local frame must match the RENDER's group rotation (π/2 − ang);
    // the old cos(−ang) conversion left spots rotated 90° — a bow hit
    // appeared on the SIDE, and on the narrow barge that landed outside
    // the hull entirely.
    if (hx !== undefined && hz !== undefined && real > 3) {
      const dx = hx - victim.x, dz = hz - victim.z;
      const s = Math.sin(victim.ang), c = Math.cos(victim.ang);
      victim.dmgSpots.push({
        x: r2(s * dx + c * dz),
        z: r2(-c * dx + s * dz),
        s: r2(Math.min(1, 0.25 + real / 70)),
      });
      if (victim.dmgSpots.length > 8) victim.dmgSpots.shift();
    }
    if (victim.hp <= 0) this.kill(victim, attacker, cause);
  }

  kill(victim, attacker, cause) {
    victim.hp = 0;
    victim.alive = false;
    victim.deaths++;
    victim.streak = 0;
    if (attacker) {
      attacker.kills++;
      attacker.score += PHYS.killScore;
      attacker.credits += PHYS.killCredits;
      attacker.streak++;
      // UPGRADE-on-kill: the weapon that dealt the kill gains a level (cap 10)
      const slot = victim.lastHitSlot || 'w1';
      if (slot === 'w2') { if (attacker.upg2 < PHYS.killUpMax) attacker.upg2++; }
      else { if (attacker.upg1 < PHYS.killUpMax) attacker.upg1++; }
      this.killFeed.push({ k: attacker.id, v: victim.id, w: attacker.def.w1.tiers[attacker.w1].n, s: attacker.streak, u: attacker.upg1 + attacker.upg2 });
      this.fx('boom', victim.x, victim.y + 0.6, victim.z, { s: 7, big: 1 });
    } else {
      // environmental kills: cannon shells (CANNON COVE) vs the ocean
      this.killFeed.push({ k: -1, v: victim.id, w: cause === 'cannon' ? 'the cove cannons' : 'the ocean' });
      this.fx('boom', victim.x, victim.y + 0.6, victim.z, { s: 7, big: 1 });
    }
    for (const [pid, dmg] of victim.dmgDone) {
      if (pid === (attacker && attacker.id)) continue;
      const p = this.players.get(pid);
      if (p && dmg >= victim.maxHp * PHYS.assistShare) { // posthumous assists count — no p.alive gate
        p.score += PHYS.assistScore;
        p.credits += PHYS.assistCredits;
        // ASSIST = HALF an upgrade — 2 assists = 1 weapon level (the slot
        // the assist's damage came from)
        const aslot = victim.slotsBy.get(pid) || 'w1';
        p.upgAcc = (p.upgAcc || 0) + 0.5;
        while (p.upgAcc >= 1) {
          p.upgAcc -= 1;
          if (aslot === 'w2') { if (p.upg2 < PHYS.killUpMax) p.upg2++; }
          else { if (p.upg1 < PHYS.killUpMax) p.upg1++; }
        }
        this.killFeed.push({ k: pid, v: victim.id, w: 'assist', a: 1, u: p.upg1 + p.upg2 });
      }
    }
    victim.dmgDone.clear();
    this.projectiles = this.projectiles.filter(q => !(q.kind === 'mine' && q.owner === victim.id));
    if (this.mode.respawn > 0) {
      victim.respawnT = PHYS.respawn;
      victim.spectating = false;
    } else {
      victim.respawnT = -1;
      victim.spectating = true;
    }
  }

  respawn(p) {
    const sp = this.pickSpawn();
    p.x = sp.x; p.y = 0; p.z = sp.z;
    p.vx = 0; p.vy = 0; p.vz = 0;
    p.ang = Math.random() * TAU;
    p.turretYaw = p.ang; p.turretPitch = 0;
    p.hp = p.maxHp;
    p.alive = true;
    p.spawnProtect = PHYS.spawnProtect;
    p.dmgSpots = [];
    p.lastHitBy = null;
    this.fx('splash', p.x, 0, p.z);
  }

  simulateCrates(dt) {
    // 08-05: crates REMOVED (user: "remove all pickups from the map aside
    // from shields") — the only map pickups are the shield pickups and the
    // ramp-top weapon-upgrade pickup. The drain below clears any crates
    // that predate the change; nothing ever spawns again.
    this.crates = this.crates.filter(c => {
      c.ttl -= dt;
      if (c.ttl <= 0) return false;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (Math.hypot(p.x - c.x, p.z - c.z) < PHYS.playerR + 1.4) {
          const def = CRATE_KINDS[c.kind];
          if (c.kind === 'heal') {
            const healed = Math.min(def.heal, p.maxHp - p.hp);
            p.hp += healed;
            this.fx('pickup', c.x, 0.6, c.z, { k: c.kind, d: Math.round(healed) });
          } else if (c.kind === 'credits') {
            p.credits += def.credits;
            this.fx('pickup', c.x, 0.6, c.z, { k: c.kind, d: def.credits });
          } else {
            p.overclockT = def.time;
            this.fx('pickup', c.x, 0.6, c.z, { k: c.kind, d: 0 });
          }
          return false;
        }
      }
      return true;
    });
  }

  // ---------------- snapshot ----------------
  snap() {
    const ps = [], pr = [];
    for (const p of this.players.values()) {
      ps.push({
        i: p.id, n: p.name, b: p.bot ? 1 : 0, c: p.cls,
        x: r2(p.x), y: r2(p.y), z: r2(p.z), a: r2(p.ang),
        vx: r2(p.vx), vz: r2(p.vz),
        ty: r2(p.turretYaw), tp: r2(p.turretPitch),
        hp: Math.ceil(p.hp), mx: p.maxHp, cr: p.credits,
        w: [p.w1, p.w2, p.hull], sc: p.score, k: p.kills, d: p.deaths,
        al: p.alive ? 1 : 0, rt: r2(p.respawnT), bt: r2(p.boostT),
        bcd: r2(p.boostCd), acd: r2(Math.max(0, p.abilityCd)), oc: p.overclockT > 0 ? 1 : 0,
        sp: p.spawnProtect > 0 ? 1 : 0, spct: p.spectating ? 1 : 0,
        iz: p.inZone || 0,
        sh: Math.ceil(p.shield), u1: p.upg1, u2: p.upg2,
        ch: p.charges || 0,
        ds: p.dmgSpots,
        // cosmetics are join-time only — send once when dirty, then omit
        // (JSON.stringify drops undefined; the client persists per player)
        cs: p.csDirty ? (p.csDirty = false, p.cosmetics) : undefined,
      });
    }
    for (const q of this.projectiles) {
      pr.push({ i: q.id, x: r2(q.x), y: r2(q.y), z: r2(q.z), a: r2(q.ax), p: r2(q.ap), k: q.kind, o: q.owner, h: q.kind === 'mine' ? q.hp : 0, hm: q.kind === 'mine' ? q.hpMax : 0, tn: q.tierN || 0, lv: q.lv || 0 });
    }
    let leader = null;
    for (const p of this.players.values()) if (!leader || p.score > leader.score) leader = p;
    return {
      t: 'snap', tick: this.tickN, ph: this.phase, tm: Math.max(0, Math.ceil(this.timer)),
      sc: this.mode.scoreCap, mode: this.modeId, map: this.mapId,
      zn: this.mode.zone ? { x: this.mode.zone.x, z: this.mode.zone.z, r: this.mode.zone.r } : null,
      wi: this.winnerId, ldr: leader ? leader.id : null, spc: this.phaseT,
      ps, pr,
      cr: this.crates.map(c => ({ i: c.id, x: r2(c.x), z: r2(c.z), k: c.kind })),
      pk: this.pickups.map(k => ({ x: r2(k.x), z: r2(k.z), a: k.t <= 0 ? 1 : 0 })),
      up: this.upgradePickup ? { x: r2(this.upgradePickup.x), z: r2(this.upgradePickup.z), y: r2(this.upgradePickup.y), a: this.upgradePickup.t <= 0 ? 1 : 0 } : null,
      fx: this.fxQueue.splice(0),
      kl: this.killFeed.splice(0),
    };
  }

  // ---- lobby chat: lobby-scoped, capped, cleared ONLY when the lobby
  // closes (last human leaves / admin reset). Play-again (end → lobby)
  // keeps the history — it's the same lobby. ----
  chatMsg(name, text) {
    const e = { n: name, m: text };
    this.chat.push(e);
    if (this.chat.length > 50) this.chat.shift();
    return e;
  }
  clearChat() { this.chat = []; }

  setBotsOn(v) {
    this.botsOn = !!v;
    if (!this.botsOn) {
      for (const [id, p] of [...this.players]) if (p.bot) this.removePlayer(id);
    }
  }

  lobbyInfo() {
    let host = null;
    for (const p of this.players.values()) if (!p.bot) { host = p.id; break; }
    return {
      t: 'lobby',
      players: [...this.players.values()].map(p => ({
        i: p.id, n: p.name, b: p.bot ? 1 : 0, c: p.cls, cs: p.cosmetics,
        lv: (p.cosmetics && p.cosmetics.lv) || 1,
      })),
      host, mode: this.modeId, map: this.mapId, bots: this.botTarget,
      botsOn: this.botsOn, practice: this.practice,
      diff: this.botDiff,
      chat: this.chat.slice(-50),
      phase: this.phase,
    };
  }
}

module.exports = { Game, solvePitch };
