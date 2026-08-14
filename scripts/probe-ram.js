'use strict';
const { Game } = require('../server/game');
const { PHYS } = require('../server/defs');
const angDiff = (a, b) => { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

const gd = new Game('ffa', 'lagoon');
const a = gd.addPlayer('A', 'razorfin', {}, false);
const b = gd.addPlayer('B', 'razorfin', {}, false);
gd.startCountdown();
for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gd.update(PHYS.tick);
a.spawnProtect = 0; b.spawnProtect = 0;
a.x = 0; a.z = -40; a.ang = 0; a.vx = a.def.speed; a.vz = 0;
b.x = 3; b.z = -40; b.ang = Math.PI; b.vx = -b.def.speed; b.vz = 0;
const zero = { up: 0, down: 0, left: 0, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, jump: 0, aimYaw: 0, aimPitch: 0 };
a.input = zero; b.input = zero;
for (let i = 0; i < 6; i++) {
  gd.update(PHYS.tick);
  const dd = Math.hypot(a.x - b.x, a.z - b.z);
  const divA = Math.abs(angDiff(Math.atan2(a.vz, a.vx), a.ang));
  const divB = Math.abs(angDiff(Math.atan2(b.vz, b.vx), b.ang));
  console.log(`t${i}: dd=${dd.toFixed(2)} a.vx=${a.vx.toFixed(2)} a.ang=${a.ang.toFixed(2)} divA=${divA.toFixed(2)} | b.vx=${b.vx.toFixed(2)} b.ang=${b.ang.toFixed(2)} divB=${divB.toFixed(2)}`);
}
