// probe-assist.js — empirical ground truth for the assist path.
// Scenarios: threshold, dead assister, shield absorption, mine/splash ownership.
const { Game } = require('../server/game');
const { PHYS } = require('../server/defs');

function fresh() {
  const g = new Game('ffa');
  g.mapId = 'lagoon';
  g.startCountdown();
  for (let i = 0; i < Math.ceil(PHYS.countdown / PHYS.tick) + 2; i++) g.update(PHYS.tick);
  return g;
}

function report(tag, g, who) {
  const p = who;
  const assists = g.killFeed.filter(k => k.w === 'assist').map(k => ({ k: k.k, v: k.v }));
  console.log(`${tag}: score=${p.score} credits=${p.credits} upgAcc=${p.upgAcc} upg1=${p.upg1} killfeedAssists=${JSON.stringify(assists)}`);
}

// S1: A does 40% (100 of 250), B kills → expect assist
{
  const g = fresh();
  const A = g.addPlayer('A', 'razorfin', {}, false);
  const B = g.addPlayer('B', 'rocket', {}, false);
  const V = g.addPlayer('V', 'barge', {}, false);
  console.log('identity:', A.id, A === g.players.get(A.id), 'keys:', Object.keys(A).filter(k => ['score', 'credits', 'upgAcc', 'upg1'].includes(k)));
  g.damage(V, A, 100, 'rail', 1, V.x, V.z, 'w1');
  g.damage(V, B, 200, 'rocket', 1, V.x, V.z, 'w1');
  report('S1 basic-40%', g, g.players.get(A.id));
}

// S2: A does 15% (37), B kills → expect NO assist
{
  const g = fresh();
  const A = g.addPlayer('A', 'razorfin', {}, false);
  const B = g.addPlayer('B', 'rocket', {}, false);
  const V = g.addPlayer('V', 'barge', {}, false);
  g.damage(V, A, 37, 'rail', 1, V.x, V.z, 'w1');
  g.damage(V, B, 300, 'rocket', 1, V.x, V.z, 'w1');
  report('S2 below-threshold', g, 'A');
}

// S3: A does 40%, A DIES, B kills → current behavior?
{
  const g = fresh();
  const A = g.addPlayer('A', 'razorfin', {}, false);
  const B = g.addPlayer('B', 'rocket', {}, false);
  const V = g.addPlayer('V', 'barge', {}, false);
  g.damage(V, A, 100, 'rail', 1, V.x, V.z, 'w1');
  A.hp = 0; A.alive = false;
  g.damage(V, B, 300, 'rocket', 1, V.x, V.z, 'w1');
  report('S3 dead-assister', g, 'A');
}

// S4: V has shield 60; A hits 50 (absorbed) + 50 (10 through) → dmgDone = 10
{
  const g = fresh();
  const A = g.addPlayer('A', 'razorfin', {}, false);
  const B = g.addPlayer('B', 'rocket', {}, false);
  const V = g.addPlayer('V', 'barge', {}, false);
  V.shield = 60;
  g.damage(V, A, 50, 'rail', 1, V.x, V.z, 'w1');
  g.damage(V, A, 50, 'rail', 1, V.x, V.z, 'w1');
  console.log(`S4 shield: dmgDone=${JSON.stringify([...V.dmgDone])} hp=${V.hp}`);
  g.damage(V, B, 300, 'rocket', 1, V.x, V.z, 'w1');
  report('S4 shield-absorb', g, 'A');
}

// S5: mine damage (owner = A) then B kills
{
  const g = fresh();
  const A = g.addPlayer('A', 'barge', {}, false);
  const B = g.addPlayer('B', 'rocket', {}, false);
  const V = g.addPlayer('V', 'barge', {}, false);
  g.damage(V, A, 100, 'mine', 1, V.x, V.z, 'w1');
  g.damage(V, B, 300, 'rocket', 1, V.x, V.z, 'w1');
  report('S5 mine-damage', g, 'A');
}
