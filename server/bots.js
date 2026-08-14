'use strict';
// ============================================================
// CANOE ARENA — server-side bot brains (3D aiming)
// Difficulty: LOW (pretty dumb) / MED / HIGH (sharpshooter).
// MECHANICS ARE DIFFICULTY-INVARIANT (user rule): weapon ranges, ability
// cadence and fire cadence are IDENTICAL at every difficulty — the only
// things that scale are AIM (noise/lead/fireGate/whiff/reaction) and
// MANEUVERABILITY (steer/strafe/range/flee/boost). A low bot's special is
// as frequent as a high bot's — it just misses.
// ============================================================
const { PHYS } = require('./defs');
const { solvePitch } = require('./game');
const TAU = Math.PI * 2;
function angDiff(a, b) { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// MECH — identical at every difficulty (the user's mechanics/aim split):
// weapon reach gates, ability cadence, fire cadence. Only DIFFS below vary.
const MECH = {
  fire2Dist: 30,        // secondary envelope — the chug's real burst range
  abilityChance: 1,     // specials fire at FULL cadence like a player (the
                        // situation gates below decide WHEN — range windows,
                        // aim, distress — never a random half-rate)
  fireChance: 1,        // always fire when the aim window opens
};

const DIFFS = {
  low: {
    thinkT: [0.45, 0.75],    // molasses reaction — aims at stale spots
    noise: 0.95,             // ~±54° aim jitter — essentially random aim
    leadMul: 0,              // NEVER leads a moving target
    fireGate: [0.9, 0.9],    // fires whenever — the aim is hopeless anyway
    whiff: 0.45,             // nearly half of all shots are wide
    steerDead: 0.25,         // very sloppy pursuit steering
    rangeMul: 1.8,           // keeps VERY far — avoids confrontation
    boostChance: 0.0005,     // never boosts
    flee: 1,                 // RUNS from whoever is shooting it
    missOffset: 11,          // deliberately aims 11u OFF the target — hits are accidents
  },
  med: {
    thinkT: [0.22, 0.34],   // slower reaction — a casual human
    noise: 0.3,             // ~±17° — decent but missable
    leadMul: 0.35,          // shaky target leading
    fireGate: [0.5, 0.42],  // fires on sloppier aim
    whiff: 0.2,             // one in five shots goes wide
    steerDead: 0.07,
    rangeMul: 1.0,
    boostChance: 0.004,
  },
  high: {
    thinkT: [0.08, 0.14],   // sharp reaction — fresh aim every tick
    noise: 0.04,            // ~±2° — a sharpshooter
    leadMul: 0.9,           // near-perfect target lead
    fireGate: [0.2, 0.18],  // tight fire window
    whiff: 0.01,
    steerDead: 0.04,
    rangeMul: 0.85,         // closes in aggressively
    boostChance: 0.008,
  },
};

class BotBrain {
  constructor(p) {
    this.p = p;
    this.thinkT = Math.random() * 0.2;
    this.targetId = null;
    this.strafe = Math.random() < 0.5 ? -1 : 1;
    this.buyT = 2 + Math.random() * 2;
    this.aggr = 0.6 + Math.random() * 0.4;
    this.burstT = 0;  // fire2 burst window (secondary fires in bursts, not a stream)
    this.pauseT = 0;  // fire2 pause between bursts
  }

  // RECENTLY HIT → aim wobble: a bot that just took fire is "shocked" and
  // its aim degrades for a second instead of instantly shredding whoever
  // landed the hit (the old behavior felt like instant laser retaliation).
  shockMul(game, t) {
    if (t.id === this.p.lastHitBy && game.time - this.p.lastHitT < 1.1) return 2.4;
    return 1.0;
  }

  diff(game) { return DIFFS[game.botDiff] || DIFFS.med; }

  desiredRange(D) {
    // engagement orbits must be INSIDE the class's t0 weapon reach
    // (rail ~60m, rocket ~38m, cannon ~32m) or bots would never land shots
    const base = (() => {
      switch (this.p.cls) {
        case 'razorfin': return 48;
        case 'rocket': return 32;
        default: return 26;
      }
    })();
    return base * D.rangeMul;
  }

  think(dt, game) {
    const p = this.p;
    const inp = p.input;
    const D = this.diff(game);
    if (!p.alive || p.spectating) { inp.up = 0; inp.down = 0; inp.boost = 0; inp.fire1 = 0; inp.fire2 = 0; inp.ab = 0; return; }
    if (game.phase !== 'play') { inp.up = 0; inp.fire1 = 0; inp.fire2 = 0; inp.ab = 0; inp.boost = 0; return; }

    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = D.thinkT[0] + Math.random() * (D.thinkT[1] - D.thinkT[0]);
      this.pickTarget(game);
      if (D.flee) this.wanderAng = Math.random() * TAU; // shy bots wander, never charge
    }

    this.buyT -= dt;
    if (this.buyT <= 0) { this.buyT = 0.7; this.tryBuy(game); }

    // King of the Hill: contest the zone — drift toward it when not holding it
    if (game.mode.zone) {
      const z = game.mode.zone;
      const dz = Math.hypot(p.x - z.x, p.z - z.z);
      if (dz > z.r + 6 && Math.random() < 0.55) {
        this.zoneAng = Math.atan2(z.z - p.z, z.x - p.x);
        inp.up = 1;
      }
    }

    const t = game.players.get(this.targetId);
    if (!t || !t.alive) { inp.up = 0; inp.fire1 = 0; inp.fire2 = 0; inp.ab = 0; inp.boost = 0; return; }

    const dx = t.x - p.x, dz = t.z - p.z;
    const dist = Math.hypot(dx, dz);
    const angTo = Math.atan2(dz, dx);

    // ---- movement
    let moveAng = angTo;
    if (this.zoneAng !== undefined) { moveAng = this.zoneAng; this.zoneAng = undefined; }
    const want = this.desiredRange(D);
    if (D.flee) {
      // LOW bots NEVER chase — they run from the player and keep their
      // distance; when far away they wander instead of charging
      const recentlyShot = t.id === p.lastHitBy && game.time - p.lastHitT < 6;
      if (recentlyShot || dist < want + 30) moveAng = angTo + Math.PI;
      else moveAng = this.wanderAng;
    } else if (dist > want + 14) moveAng = angTo;
    else if (dist < want - 8) moveAng = angTo + Math.PI;
    else {
      // steady orbit — NO periodic jinks (user: bots must not look like
      // they react to being aimed at; the old strafe-flip read as dodging)
      const radial = (dist - want) / want * 0.4;
      moveAng = angTo + (Math.PI / 2) * this.strafe + radial * this.strafe;
    }
    if (p.hp < p.maxHp * 0.45) {
      let best = null, bd = 150;
      for (const c of game.crates) {
        if (c.kind !== 'heal') continue;
        const d = Math.hypot(c.x - p.x, c.z - p.z);
        if (d < bd) { bd = d; best = c; }
      }
      if (best) moveAng = Math.atan2(best.z - p.z, best.x - p.x);
    }

    const dAng = angDiff(moveAng, p.ang);
    inp.left = dAng < -D.steerDead ? 1 : 0;
    inp.right = dAng > D.steerDead ? 1 : 0;
    inp.up = Math.abs(dAng) < 1.3 ? 1 : 0;
    inp.down = Math.abs(dAng) > 2.4 ? 1 : 0;

    // ---- 3D aim: lead the target, solve ballistic pitch (difficulty noise)
    const tier = p.def.w1.tiers[p.w1];
    const lead = clamp(dist / Math.max(tier.spd, 1), 0, 1.6) * 0.7 * D.leadMul;
    // LOW bots ACTIVELY TRY TO MISS: the aim point is offset beside the
    // target (random side, re-rolled each think) — any hit is an accident
    // when the jitter swings the aim point back over the target
    let missOx = 0, missOz = 0;
    if (D.missOffset) {
      const ma = Math.random() * TAU;
      missOx = Math.cos(ma) * D.missOffset;
      missOz = Math.sin(ma) * D.missOffset;
    }
    const px = t.x + t.vx * lead + missOx;
    const py = t.y + PHYS.playerCenterY + t.vy * lead * 0.3;
    const pz = t.z + t.vz * lead + missOz;
    const hd = Math.hypot(px - p.x, pz - p.z);
    const yaw = Math.atan2(pz - p.z, px - p.x);
    let pitch = solvePitch(hd, py - PHYS.muzzleY, tier.spd, tier.grav || PHYS.gravity, !!tier.high);
    if (pitch === null) pitch = tier.maxPitch;
    pitch = clamp(pitch, -0.3, tier.maxPitch);
    const noise = D.noise * (1.7 - this.aggr) * this.shockMul(game, t);
    inp.aimYaw = yaw + (Math.random() - 0.5) * noise + (Math.random() - 0.5) * 0.04;
    inp.aimPitch = pitch + (Math.random() - 0.5) * noise * 0.6;

    // ---- fire (difficulty-gated + whiff chance)
    const yawErr = Math.abs(angDiff(yaw, p.turretYaw));
    const pitchErr = Math.abs(pitch - p.turretPitch);
    let fire = (yawErr < D.fireGate[0] && pitchErr < D.fireGate[1] && p.fireCd1 <= 0 && Math.random() < MECH.fireChance) ? 1 : 0;
    if (fire && Math.random() < D.whiff) fire = 0; // wide shots at low difficulty
    inp.fire1 = fire;
    // fire2 in BURSTS (user: the barge bot's full-auto chug read as
    // "spraying a line of pellets") — a short burst, then a pause; same
    // weapon, same reach, same in-burst cadence. Razorfin's early
    // mines/torps are single-shot weapons and bypass the burst timer.
    inp.fire2 = 0;
    if (this.pauseT > 0) {
      this.pauseT -= dt;
    } else if (this.burstT > 0) {
      this.burstT -= dt;
      inp.fire2 = (yawErr < 0.55 && p.fireCd2 <= 0 && dist < MECH.fire2Dist) ? 1 : 0;
      if (this.burstT <= 0) this.pauseT = 0.7 + Math.random() * 0.9;
    } else {
      this.burstT = 0.35 + Math.random() * 0.3;
    }
    if (p.cls === 'razorfin' && p.w2 < 2 && dist < 26 && p.fireCd2 <= 0) inp.fire2 = 1;

    // ---- boost (aggression scaled by difficulty)
    inp.boost = 0;
    if (p.boostCd <= 0 && p.boostT <= 0) {
      const closing = Math.abs(angDiff(angTo, p.ang)) < 0.5 && dist > want + 8;
      const fleeing = p.hp < p.maxHp * 0.35;
      const ramming = p.cls === 'barge' && dist < 80 && Math.abs(angDiff(angTo, p.ang)) < 0.4;
      if (ramming || closing || fleeing || Math.random() < D.boostChance) inp.boost = 1;
    }

    // ---- ability (rare for dumb bots) — cooldown-normalized: the special
    // only fires on a tight aim window (or real distress), never on the
    // every-cooldown "spam" the loose rocket gate caused
    inp.ab = 0;
    if (p.abilityCd <= 0 && Math.random() < MECH.abilityChance) {
      if (p.cls === 'razorfin' && dist < 34) inp.ab = 1;
      else if (p.cls === 'barge' && dist < 18 && Math.abs(angDiff(angTo, p.ang)) < 0.5) inp.ab = 1; // mine layer — blank-range escape only
      else if (p.cls === 'rocket' && dist > 18 && (p.hp < p.maxHp * 0.4 || Math.abs(angDiff(yaw, p.turretYaw)) < 0.12)) inp.ab = 1;
    }
  }

  pickTarget(game) {
    const p = this.p;
    let best = null, bd = 1e9;
    for (const o of game.players.values()) {
      if (o.id === p.id || !o.alive) continue;
      const d = Math.hypot(o.x - p.x, o.z - p.z);
      const score = d - (o.hp < o.maxHp * 0.5 ? 60 : 0) * (d < 260 ? 1 : 0);
      if (score < bd) { bd = score; best = o; }
    }
    this.targetId = best ? best.id : null;
  }

  tryBuy(game) {
    if (PHYS.shopDisabled) return; // the shop is OFF — bots stay at tier 0
    const p = this.p;
    if (p.credits < 100) return;
    const wantHull = p.hp < p.maxHp * 0.4 || p.hull >= 1;
    let track = 'w1';
    if (p.w1 >= p.def.w1.tiers.length - 1) track = 'w2';
    else if (p.w1 >= 2 && p.w2 < 2 && p.credits > 300) track = 'w2';
    else if (wantHull && p.hull === 0 && p.w1 >= 1) track = 'hull';
    const r = game.tryBuy(p, track);
    if (!r.ok && track === 'w1' && p.w1 >= 1) {
      game.tryBuy(p, p.hull === 0 ? 'hull' : 'w2');
    }
  }
}

module.exports = { BotBrain };
