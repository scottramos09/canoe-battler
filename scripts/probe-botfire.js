// probe-botfire.js — what does a bot's basic attack actually fire per volley,
// and how do its volleys space out? (user: "bots shoot multiple projectiles
// every shot")
const { Game } = require('../server/game');
const { PHYS } = require('../server/defs');
const { BotBrain } = require('../server/bots');

const g = new Game('ffa');
g.mapId = 'lagoon';
g.botTarget = 3;
g.startCountdown();
for (let i = 0; i < Math.ceil(PHYS.countdown / PHYS.tick) + 2; i++) g.update(PHYS.tick);
g.fillBots();
const bot = [...g.players.values()].find(p => p.bot);
const brain = new BotBrain(bot);

const seen = new Set();
let lastVolleyTick = -99;
const volleys = [];
for (let i = 0; i < 60 * 90; i++) { // 90 s of match
  brain.think(PHYS.tick, g);
  g.update(PHYS.tick);
  const fresh = g.projectiles.filter(q => !seen.has(q.id) && q.kind !== 'mine' && q.owner === bot.id);
  for (const q of fresh) seen.add(q.id);
  if (fresh.length > 0) {
    volleys.push({ tick: i, n: fresh.length, kinds: [...new Set(fresh.map(q => q.kind))], w1: bot.w1, gap: i - lastVolleyTick, credits: Math.round(bot.credits) });
    lastVolleyTick = i;
  }
}
console.log(`bot w1 tier now: ${bot.w1} (${bot.def.w1.tiers[bot.w1].n}, count=${bot.def.w1.tiers[bot.w1].count})`);
console.log(`volleys observed: ${volleys.length} in 90 s`);
console.log('first 12 volleys:');
for (const v of volleys.slice(0, 12)) console.log(`  tick ${v.tick} (${(v.tick / 30).toFixed(1)}s): ${v.n} proj, tier ${v.w1}, gap ${(v.gap / 30).toFixed(1)}s, credits ${v.credits}`);
console.log(`volley gaps (s): ${volleys.slice(1).map(v => (v.gap / 30).toFixed(1)).join(' ')}`);
