// probe-minedmg.js — does a barge MINE LAYER mine actually damage a canoe
// that drives into it? Empirically drives a bot through a dropped mine.
const { Game } = require('../server/game');
const { PHYS } = require('../server/defs');

const g = new Game('ffa');
g.mapId = 'lagoon';
g.startCountdown();
for (let i = 0; i < Math.ceil(PHYS.countdown / PHYS.tick) + 2; i++) g.update(PHYS.tick);

const barge = g.addPlayer('Barge', 'barge', {}, false);
const victim = g.addPlayer('Victim', 'razorfin', {}, false);
// place barge at origin, victim 20 u away driving straight at the mine
barge.x = 0; barge.z = 0; barge.ang = 0;
victim.x = 0; victim.z = 30; victim.ang = Math.PI; // facing -z (toward barge)
const hp0 = victim.hp;

// fire the ability once
barge.input.ab = 1;
for (let i = 0; i < 30; i++) g.update(PHYS.tick);
barge.input.ab = 0;

const mine = g.projectiles.find(q => q.kind === 'mine');
console.log('mine dropped:', !!mine, mine ? `at z=${mine.z.toFixed(1)} tier=${JSON.stringify({ dmg: mine.tier.dmg, splash: mine.tier.splash })}` : '');

// victim drives straight at the mine (W = forward along facing -z)
for (let i = 0; i < 1200 && victim.alive; i++) {
  victim.input.up = 1;
  g.update(PHYS.tick);
  if (g.projectiles.some(q => q.kind === 'mine' && q.dead)) break;
}
console.log(`victim hp: ${hp0} -> ${victim.hp.toFixed(1)} (alive=${victim.alive}), dmg dealt=${(hp0 - victim.hp).toFixed(1)}`);
