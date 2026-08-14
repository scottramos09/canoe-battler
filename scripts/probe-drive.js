// probe-drive.js — ground-truth measurements for the drive-straight hardening.
// (1) Straight drive on the clear lane (z=-40): how pure is a W-held course?
// (2) Harpoon side-knock (kback 13): how long does the crab-walk last?
// (3) Rock graze with client-mirror-style AXIS push vs server normal push:
//     how far do the two models diverge (the client mirror uses the axis one)?
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
  a.x = 0; a.z = -40; a.ang = 0; a.vx = 0; a.vz = 0;
  a.input = { up: 1, down: 0, left: 0, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, jump: 0, aimYaw: 0, aimPitch: 0 };
  return { gd, a };
}

// ---- (1) straight drive, clear lane ----
{
  const { gd, a } = makeGame();
  const startAng = a.ang, startX = a.x, startZ = a.z;
  let maxDiv = 0;
  for (let i = 0; i < 300; i++) {
    gd.update(TICK);
    const spd = Math.hypot(a.vx, a.vz);
    if (spd > 1) maxDiv = Math.max(maxDiv, Math.abs(angDiff(Math.atan2(a.vz, a.vx), a.ang)));
  }
  // lateral deviation from the initial course line (yaw 0 = +x course)
  const lat = Math.abs(a.z - startZ);
  const drift = Math.abs(angDiff(a.ang, startAng));
  const spd = Math.hypot(a.vx, a.vz);
  console.log(`STRAIGHT: maxDiv=${maxDiv.toFixed(3)} rad, angDrift=${drift.toFixed(4)} rad, lateral=${lat.toFixed(2)} u, spd=${spd.toFixed(1)}`);
}

// ---- (2) harpoon side-knock recovery ----
{
  const { gd, a } = makeGame();
  for (let i = 0; i < 60; i++) gd.update(TICK); // up to speed (~13.5 along +x)
  a.vx += 0; a.vz += 13; // side hit: kback 13 along +z (harpoon from the -z side)
  const div0 = Math.abs(angDiff(Math.atan2(a.vz, a.vx), a.ang));
  let firstClean = -1;
  const samples = [];
  for (let i = 0; i < 90; i++) {
    gd.update(TICK);
    const d = Math.abs(angDiff(Math.atan2(a.vz, a.vx), a.ang));
    samples.push(d.toFixed(2));
    if (firstClean < 0 && d < 0.2) firstClean = i;
  }
  console.log(`KNOCK: divAtHit=${div0.toFixed(2)} rad, first-clean tick=${firstClean} (${(firstClean * TICK).toFixed(2)}s), samples=[${samples.join(' ')}]`);
}

// ---- (3) terrain graze: server normal push vs client-mirror axis push ----
{
  const { gd, a } = makeGame();
  const rk = gd.map.rocks[0];
  // place 6 u off the rock's +x face, oblique approach (same as the sim lock)
  a.x = rk.x + rk.w / 2 + 6; a.z = rk.z;
  a.ang = Math.PI + 0.5;
  a.vx = Math.cos(a.ang) * a.def.speed; a.vz = Math.sin(a.ang) * a.def.speed;
  // twin state driven by the OLD client axis mirror
  const c = { x: a.x, z: a.z, vx: a.vx, vz: a.vz, ang: a.ang };
  for (let i = 0; i < 40; i++) {
    gd.update(TICK);
    // client-mirror axis push (net.js current code, constants mirrored)
    for (const ob of [{ x: rk.x, z: rk.z, w: rk.w, d: rk.d }]) {
      const dx = c.x - ob.x, dz = c.z - ob.z;
      const ox = ob.w / 2 + 1.6 - Math.abs(dx);
      const oz = ob.d / 2 + 1.6 - Math.abs(dz);
      if (ox > 0 && oz > 0) {
        if (ox < oz) { c.x = ob.x + Math.sign(dx || 1) * (ob.w / 2 + 1.6); if (c.vx * dx < 0) c.vx = 0; }
        else { c.z = ob.z + Math.sign(dz || 1) * (ob.d / 2 + 1.6); if (c.vz * dz < 0) c.vz = 0; }
      }
    }
    // drive converge (same math as server, no obstacles simulated for c)
    const k = Math.min(1, a.def.accel * TICK);
    const tgt = a.def.speed;
    c.vx += (Math.cos(c.ang) * tgt - c.vx) * k;
    c.vz += (Math.sin(c.ang) * tgt - c.vz) * k;
    c.x += c.vx * TICK; c.z += c.vz * TICK;
  }
  const err = Math.hypot(a.x - c.x, a.z - c.z);
  const errAng = Math.abs(angDiff(c.ang, a.ang));
  console.log(`MIRROR-GRAZE: server-vs-axisclient position err after 40 ticks=${err.toFixed(2)} u, ang err=${errAng.toFixed(2)} rad (client never eases heading)`);
}
