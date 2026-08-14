'use strict';
const { Game, solvePitch } = require('../server/game');
const { PHYS } = require('../server/defs');

const g = new Game();
g.addPlayer('A', 'razorfin', {}, false);
g.addPlayer('B', 'barge', {}, false);
const [a, b] = [...g.players.values()];
a.x = 0; a.z = 0; a.ang = 0; a.turretYaw = 0; a.turretPitch = 0; a.spawnProtect = 0;
b.x = 50; b.z = 0; b.ang = Math.PI; b.turretYaw = Math.PI; b.turretPitch = 0; b.spawnProtect = 0;
g.startCountdown();
for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) g.update(PHYS.tick);
console.log('phase:', g.phase);

const pitch = solvePitch(50, -(PHYS.muzzleY + PHYS.playerCenterY), 46, PHYS.gravity, false);
console.log('solved pitch:', pitch);
a.input = { up: 0, down: 0, left: 0, right: 0, boost: 0, fire1: 1, fire2: 0, ab: 0, aimYaw: 0, aimPitch: pitch };
b.input = { up: 0, down: 0, left: 0, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, aimYaw: Math.PI, aimPitch: 0 };

for (let i = 0; i < 60; i++) {
  g.update(PHYS.tick);
  const projs = g.projectiles.map(q => `[${q.kind} x=${q.x.toFixed(1)} y=${q.y.toFixed(2)} z=${q.z.toFixed(1)} vx=${q.vx.toFixed(1)} vy=${q.vy.toFixed(1)}]`).join(' ');
  if (i < 6 || (i > 28 && i < 42) || g.projectiles.length === 0) {
    console.log(`tick ${i}: turretPitch=${a.turretPitch.toFixed(2)} projs=${g.projectiles.length} ${projs}`);
    console.log(`   A.hp=${a.hp} B.hp=${b.hp}`);
  }
  if (!a.alive || !b.alive) { console.log(`DIED at tick ${i}`); break; }
  if (g.projectiles.length === 0 && i > 5) { console.log('projectiles exhausted'); break; }
}
console.log('final: A.hp=', a.hp, 'B.hp=', b.hp);
