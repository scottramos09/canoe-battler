// probe-drift.js — find every path that changes a DRIFTING canoe's orientation
// (user: "times when drifting that the orientation of the ship changes and it
// no longer drives straight"). Scenarios measured on the server sim:
//  (1) open-water drift (no contact) — ang must stay frozen
//  (2) oblique drift into a wall (no throttle) — what does the slide ease do?
//  (3) turning through a graze (steer held) — does the ease fight the steer?
//  (4) knockback while drifting — does orientation change?
'use strict';
const { Game } = require('../server/game');
const { PHYS } = require('../server/defs');

const angDiff = (x, y) => { let d = (x - y) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
const TICK = PHYS.tick;

function makeGame() {
  const gd = new Game('ffa', 'lagoon');
  const a = gd.addPlayer('A', 'razorfin', {}, false);
  gd.startCountdown();
  for (let i = 0; i < PHYS.countdown / TICK + 2; i++) gd.update(TICK);
  a.spawnProtect = 0;
  a.input = { up: 0, down: 0, left: 0, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, jump: 0, aimYaw: 0, aimPitch: 0 };
  return { gd, a };
}

// (1) open-water drift: no contact, no steer — ang must stay FROZEN
{
  const { gd, a } = makeGame();
  a.x = 0; a.z = -40; a.ang = 0.5; a.vx = 8 * Math.cos(0.5); a.vz = 8 * Math.sin(0.5);
  const startAng = a.ang;
  for (let i = 0; i < 240; i++) gd.update(TICK); // 8 s drift, decays to 0
  const d = angDiff(a.ang, startAng);
  console.log(`DRIFT-OPEN: ang change over 8s drift = ${(d * 57.3).toFixed(1)}° (want 0)`);
}

// (2) oblique drift into a wall: coasting (no throttle) at the +x wall
{
  const { gd, a } = makeGame();
  a.x = 86; a.z = 0; a.ang = 0.6; // 34° into the +x wall
  a.vx = 14 * Math.cos(0.6); a.vz = 14 * Math.sin(0.6);
  const startAng = a.ang;
  let firstContactTick = -1;
  const trace = [];
  for (let i = 0; i < 90; i++) {
    gd.update(TICK);
    if (firstContactTick < 0 && a.x >= PHYS.arena - 2 - 0.01) firstContactTick = i;
    trace.push((angDiff(a.ang, startAng) * 57.3).toFixed(1));
  }
  const d = angDiff(a.ang, startAng);
  console.log(`DRIFT-WALL: contact at tick ${firstContactTick}, total ang change = ${(d * 57.3).toFixed(1)}°`);
  console.log(`  per-tick deg: ${trace.join(' ')}`);
}

// (3) STEER HELD through a graze: does the collision ease fight the steer?
//    Geometry = the COLLISION PROTECTION lock (boat 6 u off the rock's +x
//    face, ang π+0.5 = −x with −z bias → slides toward −z). Steer RIGHT
//    (+ang, toward +z) fights the ease (−z). Steer LEFT rides WITH it.
{
  const { gd, a } = makeGame();
  const rk = gd.map.rocks[0];
  // 3a — steer AGAINST the slide (right)
  a.x = rk.x + rk.w / 2 + 6; a.z = rk.z;
  a.ang = Math.PI + 0.5;
  a.vx = Math.cos(a.ang) * a.def.speed; a.vz = Math.sin(a.ang) * a.def.speed;
  a.input = { up: 1, down: 0, left: 0, right: 1, boost: 0, fire1: 0, fire2: 0, ab: 0, jump: 0, aimYaw: 0, aimPitch: 0 };
  const startAng3a = a.ang;
  let contact3a = false;
  for (let i = 0; i < 40; i++) {
    const dRock = Math.hypot(a.x - rk.x, a.z - rk.z);
    if (dRock < rk.w / 2 + 3.0) contact3a = true;
    gd.update(TICK);
  }
  const expect3a = startAng3a + (40 * TICK) * 2.7 * 0.95; // ~pure steer (turn×t×speedFactor≈1 early)
  const actual3a = a.ang;
  console.log(`STEER-AGAINST-SLIDE: contact=${contact3a}, endAng=${((actual3a) * 57.3).toFixed(1)}°, pure-steer expect≈${(expect3a * 57.3).toFixed(1)}°`);
  console.log(`  ease dragged ang by ${((actual3a - expect3a) * 57.3).toFixed(1)}° vs the steer command (negative = ease fought the turn)`);
  // 3b — steer WITH the slide (left)
  const b = gd.addPlayer('B', 'razorfin', {}, false);
  b.spawnProtect = 0;
  b.x = rk.x + rk.w / 2 + 6; b.z = rk.z;
  b.ang = Math.PI + 0.5;
  b.vx = Math.cos(b.ang) * b.def.speed; b.vz = Math.sin(b.ang) * b.def.speed;
  b.input = { up: 1, down: 0, left: 1, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, jump: 0, aimYaw: 0, aimPitch: 0 };
  for (let i = 0; i < 40; i++) gd.update(TICK);
  console.log(`STEER-WITH-SLIDE: endAng=${((b.ang) * 57.3).toFixed(1)}° (left turn rides the −z slide — both rotate −)`);
}

// (4) knockback while drifting: orientation must NOT change
{
  const { gd, a } = makeGame();
  a.x = 0; a.z = -40; a.ang = 0.5; a.vx = 8 * Math.cos(0.5); a.vz = 8 * Math.sin(0.5);
  const startAng = a.ang;
  a.vx += 0; a.vz += 13; // harpoon side-knock while coasting
  for (let i = 0; i < 90; i++) gd.update(TICK);
  const d = angDiff(a.ang, startAng);
  console.log(`DRIFT-KNOCK: ang change = ${(d * 57.3).toFixed(1)}° (want 0 — knockback must not spin the hull)`);
}
