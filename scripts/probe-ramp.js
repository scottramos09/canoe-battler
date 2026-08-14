// probe-ramp.js — empirical flight envelope off the boost ramp.
// Drives a canoe up the lagoon zone-0 pad (dir z, sign 1, exit at z=-55)
// and logs the trajectory. Picks a pickup spot PAST the ramp in the air.
const { Game } = require('../server/game');
const { PHYS } = require('../server/defs');

function run(clsId) {
  const g = new Game('ffa');
  g.mapId = 'lagoon';
  g.startCountdown();
  for (let i = 0; i < Math.ceil(PHYS.countdown / PHYS.tick) + 2; i++) g.update(PHYS.tick);
  const zone = g.map.boostZones[0]; // { x: 0, z: -60, w: 18, d: 10, dir: 'z', sign: 1 }
  const p = g.addPlayer('P', clsId, {}, false);
  p.x = 0; p.z = -80; p.vx = 0; p.vz = 0; p.vy = 0;
  p.ang = Math.PI / 2; p.turretYaw = p.ang;
  const pts = [];
  for (let i = 0; i < 400; i++) {
    p.input.up = 1;
    g.update(PHYS.tick);
    if (p.z > -75) pts.push({ z: +p.z.toFixed(2), y: +p.y.toFixed(2), vz: +p.vz.toFixed(1), boostPadT: +p.boostPadT.toFixed(2) });
    if (p.z > 20 || (p.y <= 0 && p.boostPadT <= 0 && p.z > -70)) { /* landed/past */ }
  }
  console.log(`${clsId}: exit(-55)${pts.find(q => q.z >= -55.5) ? ' ' + JSON.stringify(pts.find(q => q.z >= -55.5)) : ' MISSED'}`);
  // flight envelope past the exit edge
  const past = pts.filter(q => q.z >= -55);
  if (past.length) {
    console.log(`  past-exit: z=${past[0].z}..${past[past.length - 1].z} y=${Math.min(...past.map(q => q.y))}..${Math.max(...past.map(q => q.y))}`);
    console.log(`  apex: ${JSON.stringify(past.reduce((m, q) => (q.y > m.y ? q : m), past[0]))}`);
  }
  // where is y between 2.5 and 3.5 past the exit?
  const band = past.filter(q => q.y > 2.5 && q.y < 3.5);
  console.log(`  y-band(2.5..3.5) past exit: ${band.length ? 'z ' + band[0].z + '..' + band[band.length - 1].z : 'none'}`);
  return past;
}

run('barge');
run('razorfin');
