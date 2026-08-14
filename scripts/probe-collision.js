'use strict';
// Collision-stability probe v2: per-tick trace of the grind.
const { Game } = require('../server/game');
const { PHYS } = require('../server/defs');
const angDiff = (a, b) => { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

const gd = new Game('ffa', 'lagoon');
const a = gd.addPlayer('A', 'razorfin', {}, false);
gd.startCountdown();
for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gd.update(PHYS.tick);
const rk = gd.map.rocks[0];
a.spawnProtect = 0;
a.x = rk.x + rk.w / 2 + 6; a.z = rk.z;
a.ang = Math.PI + 0.5;
a.vx = Math.cos(a.ang) * a.def.speed; a.vz = Math.sin(a.ang) * a.def.speed;
a.input = { up: 1, down: 0, left: 0, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, jump: 0, aimYaw: 0, aimPitch: 0 };

let minD = 1e9, minTick = -1;
const trace = [];
for (let i = 0; i < 60; i++) {
  gd.update(PHYS.tick);
  const spd = Math.hypot(a.vx, a.vz);
  const velAng = Math.atan2(a.vz, a.vx);
  const div = Math.abs(angDiff(velAng, a.ang));
  const dRock = Math.hypot(a.x - rk.x, a.z - rk.z);
  if (dRock < minD) { minD = dRock; minTick = i; }
  if (i < 20 || i % 5 === 0) trace.push(`t${i}: d=${dRock.toFixed(1)} div=${div.toFixed(2)} spd=${spd.toFixed(1)} velAng=${velAng.toFixed(2)} ang=${a.ang.toFixed(2)}`);
}
console.log(`rock w=${rk.w} d=${rk.d} at (${rk.x},${rk.z}) | minD=${minD.toFixed(2)} @ t${minTick}`);
console.log(trace.join('\n'));
