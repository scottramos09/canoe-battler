'use strict';
// Direct sim test: two players forced to shoot each other, verify damage flows.
const { Game, solvePitch } = require('../server/game');
const { PHYS, CLASSES } = require('../server/defs');

const g = new Game();
g.addPlayer('A', 'razorfin', {}, false);
g.addPlayer('B', 'barge', {}, false);
const [a, b] = [...g.players.values()];
g.startCountdown();
for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) g.update(PHYS.tick);
console.log('phase:', g.phase, 'timer:', g.timer.toFixed(1));
// positions must be set AFTER resetMatch (startCountdown) — it resets spawns
// (lane at z=-40 is clear of the central island / rocks / ramps)
a.x = 0; a.z = -40; a.ang = 0; a.turretYaw = 0; a.turretPitch = 0; a.spawnProtect = 0;
b.x = 30; b.z = -40; b.ang = Math.PI; b.turretYaw = Math.PI; b.turretPitch = 0; b.spawnProtect = 0;
a.fireCd1 = 0; b.fireCd1 = 0;

const d = 30;
// NOTE: A is the RAZORFIN, B is the BARGE — the speeds must match the
// players, not the letters (the old swapped mapping fired the rails at the
// barge's pitch and the shells at the razorfin's: both missed)
const spdA = CLASSES.razorfin.w1.tiers[0].spd;
const spdB = CLASSES.barge.w1.tiers[0].spd;
const gravB = CLASSES.barge.w1.tiers[0].grav || PHYS.gravity; // the barge shells fall at 48, not 24!
let hitsA = 0, hitsB = 0;
for (let i = 0; i < 900; i++) {
  // set the TURRET pitch directly (the shells fire at the turret, which
  // converges slowly — waiting for the convergence wastes the window).
  // Solve for the WATER-LEVEL impact (drop = -muzzleY), not the hull center:
  // the center sits below the waterline's trajectory, so the shells explode
  // short on the water (~2.3 u) and the splash-less razorfin rails miss
  const pitchA = solvePitch(d, -PHYS.muzzleY, spdA, PHYS.gravity, false) ?? 0.35;
  const pitchB = solvePitch(d, -PHYS.muzzleY, spdB, gravB, false) ?? 0.35;
  a.turretPitch = pitchA; a.turretYaw = 0;
  b.turretPitch = pitchB; b.turretYaw = Math.PI;
  a.input = { up: 0, down: 0, left: 0, right: 0, boost: 0, fire1: 1, fire2: 0, ab: 0, aimYaw: 0, aimPitch: pitchA };
  b.input = { up: 0, down: 0, left: 0, right: 0, boost: 0, fire1: 1, fire2: 0, ab: 0, aimYaw: Math.PI, aimPitch: pitchB };
  const hpa = a.hp, hpb = b.hp;
  g.update(PHYS.tick);
  if (a.hp < hpa) hitsB++;
  if (b.hp < hpb) hitsA++;
  if (!a.alive || !b.alive) { console.log(`player died at tick ${i}: A.alive=${a.alive} B.alive=${b.alive}`); break; }
}
console.log(`after 900 ticks: A.hp=${a.hp.toFixed(0)}/${a.maxHp} (hit ${hitsB}x), B.hp=${b.hp.toFixed(0)}/${b.maxHp} (hit ${hitsA}x)`);
console.log('killfeed entries:', g.killFeed.length);
const ok = hitsA > 0 && hitsB > 0;
console.log(ok ? '✅ SIM COMBAT WORKS' : '❌ SIM COMBAT BROKEN');
if (!ok) process.exit(1);

// ---- BOOST PLATFORM validation: ride the surface, no boost at the entry,
// boost fires on the exit pad with an upward launch angle ----
const zz = g.map.boostZones[0]; // (0,-60) dir z sign +1: entry at z=-65 (wall side)
const C = g.addPlayer('C', 'razorfin', {}, false);
C.x = 0; C.z = zz.z - zz.sign * (zz.d / 2) - 6; // 6 before the entry edge (wall side)
C.ang = Math.PI / 2; // drive +z through the platform
C.spawnProtect = 0;
C.input = { up: 1, down: 0, left: 0, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, jump: 0, aimYaw: C.ang, aimPitch: 0 };
let rodeSurface = false, boostProg = -1, boostVy = 0, maxY = 0;
for (let i = 0; i < 260; i++) {
  g.update(PHYS.tick);
  const prog = ((C.z - zz.z) * zz.sign + zz.d / 2) / zz.d;
  const surf = (zz.h || 1.3) * Math.max(0, Math.min(1, prog / 0.3));
  if (prog > 0.1 && prog < 0.6 && Math.abs(C.y - surf) < 0.15) rodeSurface = true;
  if (C.boostPadT > 0 && boostProg < 0) { boostProg = prog; boostVy = C.vy; }
  maxY = Math.max(maxY, C.y);
}
const padOk = rodeSurface && boostProg > 0.6 && boostVy > 4;
console.log(`platform: rode surface=${rodeSurface}, boost fired at prog=${boostProg.toFixed(2)} (want >0.65), launch vy=${boostVy.toFixed(1)} (want >4 = up at an angle), peak y=${maxY.toFixed(2)}`);
console.log(padOk ? '✅ BOOST PLATFORM WORKS' : '❌ BOOST PLATFORM BROKEN');
if (!padOk) process.exit(1);

// ---- MINE validation: hp 1 — ANY shot destroys one, shot consumed ----
const D = g.addPlayer('D', 'razorfin', {}, false);
D.x = 0; D.z = 40; D.spawnProtect = 0; D.turretYaw = 0; D.fireCd1 = 0; // clear lane
const mine = { kind: 'mine', x: 10, y: 0, z: 40, hp: 1, hpMax: 1, owner: 'B', id: 9001, tier: CLASSES.razorfin.w2.tiers[0] };
g.projectiles.push(mine);
D.input = { up: 0, down: 0, left: 0, right: 0, boost: 0, fire1: 1, fire2: 0, ab: 0, jump: 0, aimYaw: 0, aimPitch: 0 };
let mineDied = false, shotSpent = false;
for (let i = 0; i < 120; i++) {
  g.update(PHYS.tick);
  if (!g.projectiles.some(p => p.kind === 'mine' && p.id === 9001)) mineDied = true;
  if (mineDied) shotSpent = true;
}
console.log(`mine: one-shot destroy=${mineDied}, shot consumed=${shotSpent}`);
const mineOk = mineDied && shotSpent;
console.log(mineOk ? '✅ MINES 1-HIT DESTROYED' : '❌ MINES STILL TANKY');
if (!mineOk) process.exit(1);

// ---- SHIELD PICKUP validation: pickups give a full shield; incoming damage
// hits the shield FIRST (same rules as hp); the pickup respawns on a timer ----
const gs = new Game('ffa', 'lagoon');
const S = gs.addPlayer('S', 'razorfin', {}, false);
const T = gs.addPlayer('T', 'barge', {}, false);
gs.startCountdown();
for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gs.update(PHYS.tick);
const [s, t] = [...gs.players.values()];
const pk0 = gs.pickups[1];
s.x = pk0.x; s.z = pk0.z; s.spawnProtect = 0;
gs.update(PHYS.tick); // the grab tick
const grabbed = s.shield === PHYS.shieldMax;
const pickupDown = gs.pickups[1].t > 0;
// incoming damage must hit the SHIELD first — hp stays full while sh drops.
// (Direct damage() call: this validates the shield mechanic, not ballistics —
// a fired shell depends on the weapon's live speed and breaks the test when
// balance changes, as the cannon speed change just proved.)
const hpBefore = s.hp;
gs.damage(s, t, 34, 'cannon', 1, s.x, s.z, 'w1');
const absorbed = s.shield < PHYS.shieldMax && s.hp === hpBefore;
console.log(`shield: grab=${grabbed} (sh=${s.shield}/${PHYS.shieldMax}), pickup respawn timer=${pickupDown}, absorbed first hit (hp untouched=${absorbed}, sh=${s.shield.toFixed(0)})`);
const shieldOk = grabbed && pickupDown && absorbed;
console.log(shieldOk ? '✅ SHIELD PICKUPS WORK' : '❌ SHIELD PICKUPS BROKEN');
if (!shieldOk) process.exit(1);

// ---- UPGRADE-ON-KILL validation: a registered kill upgrades the weapon that
// dealt it (cap 10) and damage scales +10% per level ----
const gu = new Game('ffa', 'lagoon');
const U = gu.addPlayer('U', 'razorfin', {}, false);
const V = gu.addPlayer('V', 'barge', {}, false);
gu.startCountdown();
for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gu.update(PHYS.tick);
const [u, v] = [...gu.players.values()];
u.x = 0; u.z = -40; u.ang = 0; u.turretYaw = 0; u.turretPitch = 0; u.spawnProtect = 0; u.fireCd1 = 0;
v.x = 30; v.z = -40; v.ang = Math.PI; v.turretYaw = Math.PI; v.turretPitch = 0; v.spawnProtect = 0;
// deal the kill with w1 rails → upg1 must hit 1 (cap 10 respected later)
let killed = false;
for (let i = 0; i < 900 && !killed; i++) {
  const pitchU = solvePitch(30, -(PHYS.muzzleY + PHYS.playerCenterY), 46, PHYS.gravity, false) ?? 0.35;
  u.input = { up: 0, down: 0, left: 0, right: 0, boost: 0, fire1: 1, fire2: 0, ab: 0, jump: 0, aimYaw: 0, aimPitch: pitchU };
  gu.update(PHYS.tick);
  if (!v.alive) killed = true;
}
const upg1 = u.upg1 === 1;
// damage scaling: level 3 → +30% (rail 12 → 15.6)
const gu2 = new Game('ffa', 'lagoon');
const U2 = gu2.addPlayer('U2', 'razorfin', {}, false);
const V2 = gu2.addPlayer('V2', 'barge', {}, false);
gu2.startCountdown();
for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gu2.update(PHYS.tick);
const [u2, v2] = [...gu2.players.values()];
u2.x = 0; u2.z = -40; u2.turretYaw = 0; u2.turretPitch = 0; u2.spawnProtect = 0; u2.fireCd1 = 0; u2.upg1 = 3;
v2.x = 30; v2.z = -40; v2.spawnProtect = 0;
const hpV2 = v2.hp;
const pitchU2 = solvePitch(30, -(PHYS.muzzleY + PHYS.playerCenterY), 46, PHYS.gravity, false) ?? 0.35;
u2.input = { up: 0, down: 0, left: 0, right: 0, boost: 0, fire1: 1, fire2: 0, ab: 0, jump: 0, aimYaw: 0, aimPitch: pitchU2 };
let dmgObs = 0;
for (let i = 0; i < 120 && dmgObs === 0; i++) {
  gu2.update(PHYS.tick);
  dmgObs = hpV2 - v2.hp;
}
const scaled = Math.abs(dmgObs - 15.6) < 2.5; // 12 * 1.3
console.log(`upgrade: kill→w1 level=${u.upg1} (want 1), scaled rail dmg at L3=${dmgObs.toFixed(1)} (want ~15.6 = 12×1.3)`);
const upgOk = upg1 && scaled;
console.log(upgOk ? '✅ UPGRADE-ON-KILL WORKS' : '❌ UPGRADE-ON-KILL BROKEN');
if (!upgOk) process.exit(1);

// ---- BOT DIFFICULTY validation: low aims worse than med, med worse than
// high — measured as damage each difficulty's bot lands on a stationary
// target over the same window (ladder must hold: low < med < high) ----
const { BotBrain } = require('../server/bots');
const dmgByDiff = {};
for (const d of ['low', 'med', 'high']) {
  const gd = new Game('ffa', 'lagoon');
  gd.botDiff = d;
  gd.addPlayer('T', 'barge', {}, false);
  gd.addPlayer('B', 'razorfin', {}, false);
  gd.startCountdown();
  for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gd.update(PHYS.tick);
  const [target, bot] = [...gd.players.values()];
  target.x = 0; target.z = 40; target.spawnProtect = 0;
  target.hp = 10000; target.maxHp = 10000; // unkillable — raw damage only, no respawn noise
  bot.x = 30; bot.z = 40; bot.spawnProtect = 0; bot.bot = true;
  const brain = new BotBrain(bot);
  let dmg = 0;
  for (let i = 0; i < 900; i++) {
    const hpBefore = target.hp;
    brain.think(PHYS.tick, gd);
    // freeze the bot's MOVEMENT — this test isolates pure aim skill
    // (pursuit params — range/steer/strafe — are fixed DIFFS config)
    bot.input.up = 0; bot.input.down = 0; bot.input.left = 0; bot.input.right = 0;
    gd.update(PHYS.tick);
    if (target.hp < hpBefore) dmg += hpBefore - target.hp;
  }
  dmgByDiff[d] = Math.round(dmg);
}
console.log(`difficulty: dmg landed — low=${dmgByDiff.low}, med=${dmgByDiff.med}, high=${dmgByDiff.high} (want low < med < high)`);
const diffOk = dmgByDiff.low < dmgByDiff.med && dmgByDiff.med < dmgByDiff.high;
console.log(diffOk ? '✅ BOT DIFFICULTY WORKS (low < med < high)' : '❌ BOT DIFFICULTY BROKEN');
if (!diffOk) process.exit(1);

  // FIRE-AT-LIVE-AIM contract (user: "the cannon asset isn't matching the
  // pitch of the shot"): the w1 shell spawns at the clamped INPUT pitch, not
  // the converged turretPitch — set them DIFFERENTLY and assert the shell
  // follows the input (the turret lags one round-trip behind the client's
  // prediction, so firing at it made quick shots leave flat).
  {
    const gd2 = new Game('ffa', 'lagoon');
    const P2 = gd2.addPlayer('P', 'barge', {}, false);
    gd2.startCountdown();
    for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gd2.update(PHYS.tick);
    P2.x = 0; P2.z = 0; P2.spawnProtect = 0;
    P2.turretPitch = 0.1;           // the lagged barrel
    P2.input.aimPitch = 0.5;        // the live aim (28.6°)
    P2.fireCd1 = 0;
    P2.input.fire1 = 1; gd2.update(PHYS.tick); P2.input.fire1 = 0;
    const shell = gd2.projectiles.find(q => q.kind === 'cannon' && q.owner === P2.id);
    // tolerance: one gravity tick is applied to vy BEFORE q.ap is recomputed
    // in the spawn tick (g·dt/v = 800·0.0333/282.8 = ~0.094 rad) + the +-0.01
    // rad spawn jitter
    const spawnOk = !!shell && Math.abs(shell.ap - 0.5) < 0.11;
    console.log(`fireWeapon spawn pitch: turretPitch 0.1 vs input 0.5 -> shell ${shell ? (shell.ap * 57.3).toFixed(1) : '?'}° (want 28.6° — the live aim)`);
    console.log(spawnOk ? '✅ FIRE AT LIVE AIM (shell leaves at the clamped input pitch)' : '❌ FIRE AT LIVE AIM BROKEN');
    if (!spawnOk) process.exit(1);
  }

  // FLIGHT-TIME CONTRACT (user: "reduce the lob speed at 100 u to 0.5 s,
  // scale down accordingly"): spd 282.8 + grav 800 keep the arcs identical
  // (v²/g ≈ 100) — the max shot lands in 0.5 s, the 15 u lob in ~0.71 s.
  {
    const gd3 = new Game('ffa', 'lagoon');
    const P3 = gd3.addPlayer('P', 'barge', {}, false);
    gd3.startCountdown();
    for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gd3.update(PHYS.tick);
    P3.x = 0; P3.z = 0; P3.spawnProtect = 0;
    P3.input.aimPitch = 1.496;      // the clamped close lob
    P3.fireCd1 = 0;
    P3.input.fire1 = 1; gd3.update(PHYS.tick); P3.input.fire1 = 0;
    const sh3 = gd3.projectiles.find(q => q.kind === 'cannon' && q.owner === P3.id);
    let age = -1, dist = -1;
    if (sh3) {
      let dead = false;
      for (let i = 0; i < 140 && !dead; i++) {
        gd3.update(PHYS.tick);
        // death = REMOVAL from the array: the water-explode path (game.js:815)
        // never sets q.dead — the shell is simply dropped by the next-array
        if (!gd3.projectiles.includes(sh3)) { dead = true; age = sh3.age; dist = Math.hypot(sh3.x - P3.x, sh3.z - P3.z); }
      }
    }
    const tOk = age > 0.5 && age < 0.9 && dist > 10 && dist < 22;
    console.log(`close lob flight: age ${age.toFixed(2)} s at ${dist.toFixed(1)} u (want ~0.71 s / ~15 u)`);
    console.log(tOk ? '✅ CLOSE LOB FLIGHT TIME (~0.71 s at the 15 u aim)' : '❌ CLOSE LOB FLIGHT TIME WRONG');
    if (!tOk) process.exit(1);
  }

  // WEAPON-UPGRADE PICKUP (user: "floating in the air after the ramp, so
  // you jump while taking the ramp/boost and if angled correctly, get the
  // upgrade"): placed PAST the exit edge on the MEASURED boosted-flight
  // path — the lock DRIVES the canoe up the ramp and asserts the grab
  // happens in flight (a teleport check proved nothing — the old placement
  // at y 4.3 was unreachable: flight apex is ~2.6 u).
  {
    const gd4 = new Game('ffa', 'lagoon');
    gd4.mapId = 'lagoon';
    gd4.startCountdown();
    for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gd4.update(PHYS.tick);
    const up = gd4.upgradePickup;
    const z = gd4.map.boostZones.find(zz => {
      const ex = zz.dir === 'x' ? zz.x + zz.sign * (zz.d / 2 + 3) : zz.x;
      const ez = zz.dir === 'z' ? zz.z + zz.sign * (zz.d / 2 + 3) : zz.z;
      return Math.hypot(up.x - ex, up.z - ez) < 1;
    });
    const P4 = gd4.addPlayer('P', 'barge', {}, false);
    // ground grab: parked under the pickup at water level — must NOT grab
    P4.x = up.x; P4.z = up.z; P4.y = 0.4; P4.vx = 0; P4.vz = 0; P4.vy = 0; P4.upg1 = 0;
    gd4.update(PHYS.tick);
    const noGroundGrab = P4.upg1 === 0;
    // approach the entry side and ride the ramp — the pad launch IS the jump
    const dx = z.dir === 'x' ? z.sign : 0, dz = z.dir === 'z' ? z.sign : 0;
    P4.x = z.dir === 'x' ? z.x - dx * (z.d / 2 + 25) : z.x;
    P4.z = z.dir === 'z' ? z.z - dz * (z.d / 2 + 25) : z.z;
    P4.y = 0; P4.vx = 0; P4.vz = 0; P4.vy = 0;
    P4.ang = Math.atan2(dz, dx);
    let grabbed = false;
    for (let i = 0; i < 420 && !grabbed; i++) {
      P4.input.up = 1;
      gd4.update(PHYS.tick);
      if (P4.upg1 >= 1) grabbed = true;
    }
    const cooled = gd4.upgradePickup && gd4.upgradePickup.t > 0;
    const upOk = !!up && !!z && noGroundGrab && grabbed && cooled;
    console.log(`upgrade pickup: past-exit air placement=${!!z}, ground grab=${!noGroundGrab}, flight grab=${grabbed}, cooled=${cooled}, y=${up ? up.y.toFixed(1) : '?'}`);
    console.log(upOk ? '✅ UPGRADE PICKUP (floating past the ramp exit, ramp launch snags it in flight)' : '❌ UPGRADE PICKUP BROKEN');
    if (!upOk) process.exit(1);
  }

  // ---- SHOP DISABLED (user: "disable all shop features and any upgrades
  // purchased through the shop") — tryBuy refuses players AND bots, so
  // nobody climbs the weapon tiers (no multi-barrel bot volleys). ----
  {
    const gs = new Game('ffa', 'lagoon');
    gs.mapId = 'lagoon';
    gs.startCountdown();
    for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gs.update(PHYS.tick);
    const P = gs.addPlayer('P', 'barge', {}, false);
    P.credits = 99999;
    const r = gs.tryBuy(P, 'w1');
    const playerBlocked = !r.ok && P.w1 === 0 && P.credits === 99999;
    const bot = gs.addPlayer('B', 'razorfin', {}, true);
    bot.credits = 99999;
    gs.tryBuy(bot, 'w1');
    const botBlocked = bot.w1 === 0 && bot.credits === 99999;
    const sdOk = playerBlocked && botBlocked;
    console.log(`shop disabled: player ${r.ok ? 'BOUGHT' : 'blocked'}, bot tier ${bot.w1} (want 0)`);
    console.log(sdOk ? '✅ SHOP DISABLED (purchases refused, weapon tiers stay locked)' : '❌ SHOP DISABLED BROKEN');
    if (!sdOk) process.exit(1);
  }
  // ---- LOBBY CHAT + ADD-BOTS TOGGLE + PRACTICE (online-prep lobby) ----
  {
    const gc = new Game('ffa', 'lagoon');
    gc.mapId = 'lagoon';
    gc.chatMsg('A', 'hello');
    gc.chatMsg('B', 'world');
    const info1 = gc.lobbyInfo();
    const chatOk = info1.chat.length === 2 && info1.chat[1].m === 'world' && info1.botsOn === true && info1.practice === false;
    gc.clearChat(); // lobby CLOSE clears history (play-again does NOT call this)
    const cleared = gc.chat.length === 0;
    gc.setBotsOn(false); // Add Bots? No — bots are removed and never refill
    gc.fillBots();
    const noBots = ![...gc.players.values()].some(p => p.bot);
    gc.setBotsOn(true); gc.fillBots();
    const botsBack = [...gc.players.values()].some(p => p.bot);
    gc.practice = true;
    const practiceFlag = gc.lobbyInfo().practice === true;
    const mpOk = chatOk && cleared && noBots && botsBack && practiceFlag;
    console.log(`lobby chat/bots/practice: chat=${chatOk}, cleared=${cleared}, noBots=${noBots}, botsBack=${botsBack}, practice=${practiceFlag}`);
    console.log(mpOk ? '✅ LOBBY CHAT + ADD-BOTS TOGGLE + PRACTICE FLAG' : '❌ LOBBY CHAT/BOTS BROKEN');
    if (!mpOk) process.exit(1);
  }
  // ---- ASSISTS (user: "assists are not working correctly") ----
  // ≥ 20% of the victim's maxHp counts; ALL damage counts (shield damage
  // included — recorded pre-absorption); granted even if the assister died.
  {
    const ga = new Game('ffa', 'lagoon');
    ga.mapId = 'lagoon';
    ga.startCountdown();
    for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) ga.update(PHYS.tick);
    const A = ga.addPlayer('A', 'razorfin', {}, false);
    const B = ga.addPlayer('B', 'rocket', {}, false);
    const V = ga.addPlayer('V', 'barge', {}, false);
    const s0 = A.score;
    ga.damage(V, A, 100, 'rail', 1, V.x, V.z, 'w1'); // 40% of the barge's 250
    ga.damage(V, B, 300, 'rocket', 1, V.x, V.z, 'w1'); // kill
    const basic = A.score === s0 + 40 && A.upgAcc === 0.5 &&
      ga.killFeed.filter(k => k.w === 'assist' && k.k === A.id && k.v === V.id).length === 1;
    // shield damage counts: V2 has 60 shield; A deals 100 (60 absorbed + 40 hp)
    const V2 = ga.addPlayer('V2', 'barge', {}, false);
    V2.shield = 60;
    ga.damage(V2, A, 100, 'rail', 1, V2.x, V2.z, 'w1'); // dmgDone += 100 (pre-shield)
    ga.damage(V2, B, 300, 'rocket', 1, V2.x, V2.z, 'w1'); // kill
    const shieldCounts = ga.killFeed.filter(k => k.w === 'assist' && k.k === A.id && k.v === V2.id).length === 1;
    // posthumous: A3 damages V3, then dies; B3 kills → A3 still assists
    const A3 = ga.addPlayer('A3', 'razorfin', {}, false);
    const B3 = ga.addPlayer('B3', 'rocket', {}, false);
    const V3 = ga.addPlayer('V3', 'barge', {}, false);
    ga.damage(V3, A3, 100, 'rail', 1, V3.x, V3.z, 'w1');
    A3.hp = 0; A3.alive = false;
    ga.damage(V3, B3, 300, 'rocket', 1, V3.x, V3.z, 'w1');
    const posthumous = ga.killFeed.filter(k => k.w === 'assist' && k.k === A3.id && k.v === V3.id).length === 1;
    const aOk = basic && shieldCounts && posthumous;
    console.log(`assists: basic=${basic}, shield-damage-counts=${shieldCounts}, posthumous=${posthumous}`);
    console.log(aOk ? '✅ ASSISTS (20% threshold, shield damage counts, granted posthumously)' : '❌ ASSISTS BROKEN');
    if (!aOk) process.exit(1);
  }

  // MINE LAYER (barge special — retired THUNDER SHOTGUN, user: "the barge
  // should be the one canoe that can drop mines"): 3 charges, 0.5 s between
  // drops, 10 s refill (user: "reduce barge special main cooldown from 60
  // sec to 10 sec"). Each press drops ONE mine BEHIND the hull; the dry
  // press must not drop; the refill re-grants the full 3 after 10 s.
  {
    const gdM = new Game('ffa', 'lagoon');
    const am = gdM.addPlayer('A', 'barge', {}, false);
    gdM.startCountdown();
    for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gdM.update(PHYS.tick);
    am.spawnProtect = 0; am.x = 0; am.z = -40; am.ang = 0; am.vx = 0; am.vz = 0;
    am.input = { up: 0, down: 0, left: 0, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, jump: 0, aimYaw: 0, aimPitch: 0 };
    const seen = new Set(); const drops = [];
    const record = () => { for (const q of gdM.projectiles) { if (q.kind === 'mine' && !seen.has(q.id)) { seen.add(q.id); drops.push(q); } } };
    const press = () => { am.input.ab = 1; gdM.update(PHYS.tick); am.input.ab = 0; record(); };
    const wait = (n) => { for (let i = 0; i < n; i++) { gdM.update(PHYS.tick); record(); } };
    press();
    const c1 = drops.length, ch1 = am.charges;
    press(); // the 0.5 s charge gap must block this instant second press
    const c2 = drops.length;
    wait(16); // 0.53 s — gap expires
    press();
    const c3 = drops.length, ch3 = am.charges;
    wait(16);
    press();
    const c4 = drops.length, ch4 = am.charges, cd4 = am.abilityCd;
    press(); // dry — no drop
    const c5 = drops.length;
    wait(Math.ceil(10 / PHYS.tick) + 6); // the 10 s refill elapses
    press();
    const c6 = drops.length, ch6 = am.charges;
    const behindOk = drops[0] && Math.hypot(drops[0].x - (am.x - 2.6), drops[0].z - am.z) < 1.0;
    const dmgOk = drops[0] && drops[0].tier.dmg === 45;
    const mineOk = c1 === 1 && c2 === 1 && c3 === 2 && c4 === 3 && c5 === 3 && c6 === 4 &&
      ch1 === 2 && ch3 === 1 && ch4 === 0 && cd4 > 7.5 && ch6 === 2 && behindOk && dmgOk;
    console.log(`mine layer: drops ${c1}/${c2}/${c3}/${c4}/${c5}/${c6} (want 1/1/2/3/3/4), charges ${ch1}/${ch3}/${ch4}/${ch6}, refill cd ${cd4.toFixed(0)}s, dmg ${drops[0] ? drops[0].tier.dmg : '?'}, behind=${behindOk}`);
    console.log(mineOk ? '✅ MINE LAYER (3 charges, 0.5s gap, 10s refill, behind-hull drop)' : '❌ MINE LAYER BROKEN');
    if (!mineOk) process.exit(1);
  }

// ---- SINGLEPLAYER QUIT: leaving as the only human ends the match ----
// (mirrors the server's 'leave' handler logic exactly)
{
  const gd = new Game('ffa', 'lagoon');
  const P = gd.addPlayer('P', 'razorfin', {}, false);
  gd.botTarget = 4;
  gd.fillBots();
  gd.startCountdown();
  for (let i = 0; i < 60; i++) gd.update(PHYS.tick);
  const onlyHuman = ![...gd.players.values()].some(p => !p.bot && p.id !== P.id);
  if (onlyHuman) gd.toLobby();
  console.log(`singleplayer quit: phase=${gd.phase} (want lobby — fresh reset), onlyHuman=${onlyHuman}`);
  const spOk = onlyHuman && gd.phase === 'lobby';
  console.log(spOk ? '✅ SINGLEPLAYER QUIT RESETS TO A FRESH LOBBY' : '❌ SINGLEPLAYER QUIT BROKEN');
  if (!spOk) process.exit(1);
}

// ---- GATLING BURST (razorfin special = 10-shot machine-gun churn) ----
{
  const gd = new Game('ffa', 'lagoon');
  const A = gd.addPlayer('A', 'razorfin', {}, false);
  const B = gd.addPlayer('B', 'razorfin', {}, false);
  gd.startCountdown();
  for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gd.update(PHYS.tick);
  const [a, b] = [...gd.players.values()];
  a.spawnProtect = 0;
  a.turretYaw = Math.atan2(b.z - a.z, b.x - a.x);
  a.input.aimYaw = a.turretYaw;
  a.input.ab = 1;
  const before = gd.nextPid;
  gd.update(PHYS.tick); // ability fires → burst queue armed, 0 slugs this tick
  const armed = gd.nextPid - before;
  for (let i = 0; i < Math.ceil(1 / PHYS.tick); i++) gd.update(PHYS.tick);
  const total = gd.nextPid - before; // spawned slugs (flat rails die on the water — count spawns, not survivors)
  console.log(`gatling: slugs first tick=${armed}, after 1s spawned=${total} (want ~10)`);
  const gOk = armed === 0 && total >= 9 && total <= 12;
  console.log(gOk ? '✅ GATLING BURST CHURNS 10 SLUGS' : '❌ GATLING BURST BROKEN');
  if (!gOk) process.exit(1);
}

// ---- BARGE LONG-RANGE SPECIALIST (REAL reach: fire at the 45° optimal
// pitch and measure the shell's actual water-impact distance — the old
// life×spd check measured theoretical flat travel, but the shells arc and
// explode on the water, so the real max was only ~130 u — shorter than the
// razorfin's rails. Now: spd 49 → ~100 u ballistic reach, maxRange 100 cap,
// arm 15. (Range history: 500 (flat "gun" arcs) → 300 (map-crossing) → 180
// ("shouldn't shoot across the map") → 100 (user: "let's do 15–100 u").
// theta(d) = asin(d/maxRange)/2 — the arc look is the range FRACTION)
{
  const gd = new Game('ffa', 'lagoon');
  gd.addPlayer('B', 'barge', {}, false);
  gd.startCountdown();
  for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gd.update(PHYS.tick);
  const b = [...gd.players.values()][0];
  b.spawnProtect = 0;
  b.turretYaw = 0; b.turretPitch = 0.785; // 45° — the max-range launch angle
  b.input.aimYaw = 0; b.input.aimPitch = 0.785;
  b.input.fire1 = 1;
  gd.update(PHYS.tick);
  b.input.fire1 = 0;
  let best = 0;
  for (let i = 0; i < 600; i++) {
    gd.update(PHYS.tick);
    for (const q of gd.projectiles) {
      if (q.kind === 'cannon' && q.owner === b.id) {
        const d = Math.hypot(q.x - b.x, q.z - b.z);
        if (d > best) best = d;
      }
    }
  }
  const rOk = best >= 80; // the DEFINED max window: [15, 100], real reach ~100
  console.log(`barge real range: ${best.toFixed(0)} u (want ≥80 — mid-range specialist, defined max 100)`);
  console.log(rOk ? '✅ BARGE LONG RANGE (real ballistic reach)' : '❌ BARGE RANGE SHORT');
  if (!rOk) process.exit(1);
}

// ---- CANOE SLIDES AROUND TERRAIN (regression: the old dual-push system —
// collideTerrain + a second aabbPush pass — fought itself, bled the speed
// 40%/frame while grazing, and rattled at corners: "tripped up, won't drive
// straight, choppy". A canoe grazing a rock must keep sliding at speed) ----
{
  const gd = new Game('ffa', 'lagoon');
  const a = gd.addPlayer('A', 'razorfin', {}, false);
  gd.startCountdown();
  for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gd.update(PHYS.tick);
  const rk = gd.map.rocks[0];
  a.spawnProtect = 0;
  a.x = rk.x + rk.w / 2 + 6; a.z = rk.z; // 6 u off the rock's +x face
  a.ang = Math.PI + 0.5; // oblique approach: −x with a −z bias (grazes the face)
  a.vx = Math.cos(a.ang) * a.def.speed; a.vz = Math.sin(a.ang) * a.def.speed;
  a.input = { up: 1, down: 0, left: 0, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, jump: 0, aimYaw: 0, aimPitch: 0 };
  for (let i = 0; i < 150; i++) gd.update(PHYS.tick);
  const spd = Math.hypot(a.vx, a.vz);
  const dist = Math.hypot(a.x - rk.x, a.z - rk.z);
  const slideOk = spd > 4;
  console.log(`slide: speed after grazing rock=${spd.toFixed(1)} u/s (want > 4), ${dist.toFixed(1)} u from rock`);
  console.log(slideOk ? '✅ CANOE SLIDES AROUND TERRAIN (no trip-up)' : '❌ CANOE TRIPS ON TERRAIN');
  if (!slideOk) process.exit(1);
}

// ---- COLLISION PROTECTION (user: "canoes get off balance and don't drive
// correctly during collision — we need collision protection"). A solid hit
// must REDIRECT the boat, not leave it crab-walking: collideSlide eases the
// heading toward the slide direction while in contact, so after a grind the
// hull DRIVES the deflected way (heading turned, divergence bounded) instead
// of fighting back into the obstacle. Pre-fix measurements on this exact
// setup: div 1.06 rad at contact + ~6-tick crab window + exit on the OLD
// heading; post-fix: div 0.69, ~2 ticks, exit along the slide. ----
{
  const gd = new Game('ffa', 'lagoon');
  const a = gd.addPlayer('A', 'razorfin', {}, false);
  gd.startCountdown();
  for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gd.update(PHYS.tick);
  const rk = gd.map.rocks[0];
  const angDiff2 = (x, y) => { let d = (x - y) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
  a.spawnProtect = 0;
  a.x = rk.x + rk.w / 2 + 6; a.z = rk.z;
  a.ang = Math.PI + 0.5;
  a.vx = Math.cos(a.ang) * a.def.speed; a.vz = Math.sin(a.ang) * a.def.speed;
  a.input = { up: 1, down: 0, left: 0, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, jump: 0, aimYaw: 0, aimPitch: 0 };
  const startAng = a.ang;
  let maxDiv = 0, sawContact = false;
  for (let i = 0; i < 60; i++) {
    gd.update(PHYS.tick);
    const spd = Math.hypot(a.vx, a.vz);
    const dRock = Math.hypot(a.x - rk.x, a.z - rk.z);
    if (dRock < rk.w / 2 + 3.0) sawContact = true;
    if (sawContact && spd > 2.5) maxDiv = Math.max(maxDiv, Math.abs(angDiff2(Math.atan2(a.vz, a.vx), a.ang)));
  }
  const turned = Math.abs(angDiff2(a.ang, startAng));
  const endDiv = Math.abs(angDiff2(Math.atan2(a.vz, a.vx), a.ang));
  const spd = Math.hypot(a.vx, a.vz);
  const protOk = sawContact && maxDiv < 0.8 && turned > 0.15 && endDiv < 0.15 && spd > 6;
  console.log(`collision protection: contact=${sawContact}, maxDiv=${maxDiv.toFixed(2)} (<0.8), headingTurned=${turned.toFixed(2)} rad (>0.15), endDiv=${endDiv.toFixed(2)} (<0.15), spd=${spd.toFixed(1)} (>6)`);
  console.log(protOk ? '✅ COLLISION PROTECTION (heading follows the slide — no crab-walk)' : '❌ COLLISION PROTECTION FAILED (crab-walk)');
  if (!protOk) process.exit(1);
}

// ---- WALL GRIND — driving obliquely into the boundary must redirect the
// hull along the wall (heading snaps toward the slide), not dead-stop it ----
{
  const gd = new Game('ffa', 'lagoon');
  const a = gd.addPlayer('A', 'razorfin', {}, false);
  gd.startCountdown();
  for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gd.update(PHYS.tick);
  const angDiff2 = (x, y) => { let d = (x - y) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
  a.spawnProtect = 0;
  const A = PHYS.arena;
  a.x = -A + 2; a.z = 0;
  a.ang = Math.PI * 0.75; // 135°: -x +z — INTO the -x wall at 45°
  a.vx = Math.cos(a.ang) * a.def.speed; a.vz = Math.sin(a.ang) * a.def.speed;
  a.input = { up: 1, down: 0, left: 0, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, jump: 0, aimYaw: 0, aimPitch: 0 };
  for (let i = 0; i < 60; i++) gd.update(PHYS.tick);
  const velAng = Math.atan2(a.vz, a.vx);
  const alongWall = Math.min(Math.abs(angDiff2(velAng, Math.PI / 2)), Math.abs(angDiff2(velAng, -Math.PI / 2)));
  const div = Math.abs(angDiff2(velAng, a.ang));
  const spd = Math.hypot(a.vx, a.vz);
  const wallOk = alongWall < 0.3 && div < 0.2 && spd > 6;
  console.log(`wall grind: alongWall=${alongWall.toFixed(2)} rad (<0.3), div=${div.toFixed(2)} (<0.2), spd=${spd.toFixed(1)} (>6)`);
  console.log(wallOk ? '✅ WALL GRIND REDIRECTS (hull follows the boundary)' : '❌ WALL GRIND FAILED');
  if (!wallOk) process.exit(1);
}

// ---- BOAT-BOAT RAM — a head-on ram must separate the hulls cleanly. Under
// the DRIFT rule (the heading ease is a driving aid), COASTING rammed boats
// keep their bows (no reorientation while drifting — straight backward
// knock, never a crab) and must drive STRAIGHT again the moment they
// throttle. (Both-driving face-to-face grinding at minD is two players
// holding W at each other — not this lock's contract.) ----
{
  const gd = new Game('ffa', 'lagoon');
  const a = gd.addPlayer('A', 'razorfin', {}, false);
  const b = gd.addPlayer('B', 'razorfin', {}, false);
  gd.startCountdown();
  for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gd.update(PHYS.tick);
  const angDiff2 = (x, y) => { let d = (x - y) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
  a.spawnProtect = 0; b.spawnProtect = 0;
  // clear lane (z=-40 — away from the central island / rocks / ramps)
  a.x = 0; a.z = -40; a.ang = 0; a.vx = a.def.speed; a.vz = 0;
  b.x = 3; b.z = -40; b.ang = Math.PI; b.vx = -b.def.speed; b.vz = 0;
  a.input = { up: 0, down: 0, left: 0, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, jump: 0, aimYaw: 0, aimPitch: 0 };
  b.input = { up: 0, down: 0, left: 0, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, jump: 0, aimYaw: 0, aimPitch: 0 };
  const aAng0 = a.ang, bAng0 = b.ang;
  for (let i = 0; i < 40; i++) gd.update(PHYS.tick);
  const ddEnd = Math.hypot(a.x - b.x, a.z - b.z);
  // DRIFT rule: the coasting rams' bows must be untouched by the impact
  const bowA = Math.abs(angDiff2(a.ang, aAng0));
  const bowB = Math.abs(angDiff2(b.ang, bAng0));
  // throttle both — they must drive STRAIGHT again within half a second
  a.input.up = 1; b.input.up = 1;
  for (let i = 0; i < 30; i++) gd.update(PHYS.tick);
  const endDiv = Math.max(
    Math.abs(angDiff2(Math.atan2(a.vz, a.vx), a.ang)),
    Math.abs(angDiff2(Math.atan2(b.vz, b.vx), b.ang)));
  const ramOk = ddEnd > 3.5 && bowA < 0.04 && bowB < 0.04 && endDiv < 0.3;
  console.log(`boat ram: endDist=${ddEnd.toFixed(2)} (>3.5), bow drift A=${bowA.toFixed(3)} B=${bowB.toFixed(3)} rad (<0.04), post-throttle endDiv=${endDiv.toFixed(2)} (<0.3)`);
  console.log(ramOk ? '✅ BOAT RAM SEPARATES + BOWS HOLD + RE-STRAIGHTENS' : '❌ BOAT RAM FAILED');
  if (!ramOk) process.exit(1);
}

// ---- BARGE CANNON RANGE WINDOW (long-range specialist: arm = the CLOSE
// edge — the shell flies through everything until it has traveled the
// arming distance. USER TERMINOLOGY: their "maximum" = this close edge,
// their "minimum" = the far reach. Final: arm 15 (close edge, chosen by
// the user — a clearly-felt gap; the shotgun owns inside), maxRange 500
// (spd 110, real reach ~499) ----
{
  const gd = new Game('ffa', 'lagoon');
  gd.addPlayer('A', 'barge', {}, false);
  gd.addPlayer('B', 'razorfin', {}, false);
  gd.startCountdown();
  for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gd.update(PHYS.tick);
  const [a, b] = [...gd.players.values()];
  a.spawnProtect = 0; b.spawnProtect = 0;
  a.turretYaw = 0; a.turretPitch = 0;
  a.input = { up: 0, down: 0, left: 0, right: 0, boost: 0, fire1: 1, fire2: 0, ab: 0, jump: 0, aimYaw: 0, aimPitch: 0 };
  // phase 1: target INSIDE the minimum (12 u) — the unarmed shell passes
  // straight through it: the short edge of the window is real and felt
  b.x = a.x + 12; b.z = a.z;
  const hpB = b.hp;
  for (let i = 0; i < 40; i++) gd.update(PHYS.tick);
  const passOk = b.hp === hpB;
  console.log(`cannon min: target 12 u (inside arm 15) unhit=${passOk} (hp ${b.hp}/${hpB})`);
  console.log(passOk ? '✅ BARGE CANNON MIN WINDOW (12 u pass-through)' : '❌ BARGE CANNON HITS INSIDE MINIMUM');
  if (!passOk) process.exit(1);
  // phase 2: target just OUTSIDE the minimum (21 u) — the shell arms in
  // flight and lands: close-range defense works. (18 u is a tick-phase gray
  // band: the shell arms on a discrete tick at ~20.7 u, so stationary targets
  // at 16–20 u can dodge the armed tick; 21 u is deterministically hit.)
  b.x = a.x + 21; b.z = a.z;
  const hpB2 = b.hp;
  for (let i = 0; i < 90; i++) gd.update(PHYS.tick);
  const closeOk = b.hp < hpB2;
  console.log(`cannon close defense: target 21 u hit=${closeOk} (hp ${b.hp}/${hpB2})`);
  console.log(closeOk ? '✅ BARGE CANNON CLOSE DEFENSE (21 u shells land)' : '❌ BARGE CANNON DEAD JUST OUTSIDE MIN');
  if (!closeOk) process.exit(1);
}

// ---- MEMORY-LEAK REGRESSION: the killfeed must be drained per snap ----
// sent by reference — every snap re-sent the ENTIRE kill history, so the
// client's queue (and the wire payload) grew forever during a long match ----
{
  const gd = new Game('ffa', 'lagoon');
  const A = gd.addPlayer('A', 'razorfin', {}, false);
  const B = gd.addPlayer('B', 'razorfin', {}, false);
  gd.startCountdown();
  for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gd.update(PHYS.tick);
  const [a, b] = [...gd.players.values()];
  a.spawnProtect = 0; b.spawnProtect = 0;
  gd.damage(b, a, 9999, 'rail', 1, b.x, b.z, 'w1'); // a kill → feed entry
  const s1 = gd.snap();
  const afterDrain = gd.killFeed.length;
  let total = 0;
  for (let i = 0; i < 60; i++) {
    gd.update(PHYS.tick);
    total += gd.snap().kl.length;
  }
  const leakOk = s1.kl.length === 1 && afterDrain === 0 && total === 0;
  console.log(`killfeed drain: first snap ${s1.kl.length} entry, feed after ${afterDrain}, 60 snaps re-sent ${total}`);
  console.log(leakOk ? '✅ KILLFEED DRAINED (no unbounded growth)' : '❌ KILLFEED LEAK');
  if (!leakOk) process.exit(1);
}

// ---- STRAIGHT-DRIVE MASTER LOCK (user: "prevent the canoes from not
// driving straight — whatever is getting them off path must be fixed and
// can never happen again"). A W-held canoe with no steer on the clear lane
// must hold its course: measured clean = lateral 0.11 u over ~100 u,
// maxDiv 0.09 rad, zero heading drift. ANY future change that perturbs
// straight driving (new push/knock/collision code, mirror drift, impulse
// sign bugs) fails this. ----
{
  const gd = new Game('ffa', 'lagoon');
  const a = gd.addPlayer('A', 'razorfin', {}, false);
  gd.startCountdown();
  for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gd.update(PHYS.tick);
  const angDiff2 = (x, y) => { let d = (x - y) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
  a.spawnProtect = 0;
  a.x = -60; a.z = -40; a.ang = 0; a.vx = 0; a.vz = 0; // clear lane, 60 u run
  a.input = { up: 1, down: 0, left: 0, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, jump: 0, aimYaw: 0, aimPitch: 0 };
  const startAng = a.ang, startZ = a.z;
  let maxDiv = 0;
  for (let i = 0; i < 133; i++) {
    gd.update(PHYS.tick);
    const spd = Math.hypot(a.vx, a.vz);
    if (spd > 1) maxDiv = Math.max(maxDiv, Math.abs(angDiff2(Math.atan2(a.vz, a.vx), a.ang)));
  }
  const lateral = Math.abs(a.z - startZ);
  const drift = Math.abs(angDiff2(a.ang, startAng));
  const spd = Math.hypot(a.vx, a.vz);
  const ok = maxDiv < 0.15 && lateral < 1 && drift < 0.02 && spd > 10;
  console.log(`straight drive: maxDiv=${maxDiv.toFixed(3)} (<0.15), lateral=${lateral.toFixed(2)} u (<1), angDrift=${drift.toFixed(4)} (<0.02), spd=${spd.toFixed(1)} (>10)`);
  console.log(ok ? '✅ STRAIGHT-DRIVE MASTER (W-held course stays true)' : '❌ CANOE DRIFTS OFF COURSE');
  if (!ok) process.exit(1);
}

// ---- KNOCKBACK RECOVERY (the last remaining off-path vectors: the harpoon
// kback 13 u/s side-hit and the mine push 2.2 u/s). While W is held, the
// drive must re-converge velocity to the bow within a few ticks — no
// persistent crab-walk after being knocked. ----
{
  const gd = new Game('ffa', 'lagoon');
  const a = gd.addPlayer('A', 'razorfin', {}, false);
  gd.startCountdown();
  for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gd.update(PHYS.tick);
  const angDiff2 = (x, y) => { let d = (x - y) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
  a.spawnProtect = 0;
  a.x = -60; a.z = -40; a.ang = 0;
  a.input = { up: 1, down: 0, left: 0, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, jump: 0, aimYaw: 0, aimPitch: 0 };
  for (let i = 0; i < 60; i++) gd.update(PHYS.tick); // up to ~13.5 u/s along +x
  // side-hit: harpoon kback 13 u/s along +z (like a harpoon from the -z side)
  a.vx += 0; a.vz += 13;
  const div0 = Math.abs(angDiff2(Math.atan2(a.vz, a.vx), a.ang));
  let cleanBy = -1, maxDiv = 0, cleanAll = true;
  for (let i = 0; i < 40; i++) {
    gd.update(PHYS.tick);
    const d = Math.abs(angDiff2(Math.atan2(a.vz, a.vx), a.ang));
    maxDiv = Math.max(maxDiv, d);
    if (cleanBy < 0 && d < 0.2) cleanBy = i;
    if (i > 8 && d >= 0.2) cleanAll = false; // settled state must stay clean
  }
  // mine push: 2.2 u/s sideways — must stay under the 0.2 rad ease threshold
  a.vz += 2.2;
  let mineMax = 0;
  for (let i = 0; i < 30; i++) {
    gd.update(PHYS.tick);
    mineMax = Math.max(mineMax, Math.abs(angDiff2(Math.atan2(a.vz, a.vx), a.ang)));
  }
  const ok = div0 > 0.5 && cleanBy >= 0 && cleanBy <= 5 && cleanAll && mineMax < 0.2;
  console.log(`knockback: divAtHit=${div0.toFixed(2)} rad, clean at tick ${cleanBy} (≤5), post-settle maxDiv=${maxDiv.toFixed(3)}, mine-push maxDiv=${mineMax.toFixed(3)} (<0.2)`);
  console.log(ok ? '✅ KNOCKBACK RECOVERY (no crab-walk after hits)' : '❌ KNOCKBACK LEAVES THE CANOE CRABBING');
  if (!ok) process.exit(1);
}

// ---- DRIFT ORIENTATION LOCK (user: "times when drifting the orientation
// changes and it no longer drives straight"). A COASTING hull (no throttle)
// that touches a wall obliquely must KEEP its orientation — the heading ease
// is a driving aid only. Measured pre-fix (probe-drift.js): the bow eased
// 45.7° off course on a coasting wall contact; post-fix: < 2° while the
// hull still slides along the wall. ----
{
  const gd = new Game('ffa', 'lagoon');
  const a = gd.addPlayer('A', 'razorfin', {}, false);
  gd.startCountdown();
  for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gd.update(PHYS.tick);
  const angDiff2 = (x, y) => { let d = (x - y) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
  a.spawnProtect = 0;
  a.x = 86; a.z = 0; a.ang = 0.6; // 34° into the +x wall
  a.vx = 14 * Math.cos(0.6); a.vz = 14 * Math.sin(0.6);
  a.input = { up: 0, down: 0, left: 0, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, jump: 0, aimYaw: 0, aimPitch: 0 };
  const startAng = a.ang;
  let contacted = false, minSlideSpd = 99;
  for (let i = 0; i < 60; i++) {
    gd.update(PHYS.tick);
    if (a.x >= PHYS.arena - 2 - 0.01) {
      contacted = true;
      // tangential (slide) speed along the wall must survive the contact
      minSlideSpd = Math.min(minSlideSpd, Math.abs(a.vz));
    }
  }
  const d = angDiff2(a.ang, startAng);
  // the into-wall component was killed: the hull slides along the wall
  // (|vz| survives) while its bow stays put
  const ok = contacted && Math.abs(d) < 0.04 && minSlideSpd > 2;
  console.log(`drift wall: contacted=${contacted}, ang change=${(d * 57.3).toFixed(1)}° (<2°), min slide speed=${minSlideSpd.toFixed(1)} u/s (>2)`);
  console.log(ok ? '✅ DRIFT KEEPS ORIENTATION (coasting contact does not turn the hull)' : '❌ DRIFT REORIENTS THE HULL');
  if (!ok) process.exit(1);
}

// ---- MECH PARITY (user: "ensure all player and bot mechanics function
// exactly the same... all special abilities should perform the same way
// between bots and players"). Bots and humans fire through the SAME server
// paths (inputs → fireWeapon/useAbility) — this lock proves the OUTPUTS are
// identical: same projectile kinds/counts/tier damage and the same cooldowns
// for every class's special + both weapon slots, human-path vs bot-path. ----
{
  const { BotBrain } = require('../server/bots');
  const setup = (clsId, tx, tz) => {
    const gd = new Game('ffa', 'lagoon');
    const a = gd.addPlayer('A', clsId, {}, false);
    const b = gd.addPlayer('B', 'razorfin', {}, false);
    gd.startCountdown();
    for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gd.update(PHYS.tick);
    a.spawnProtect = 0; b.spawnProtect = 0;
    a.x = 0; a.z = -40; a.ang = 0;
    b.x = tx; b.z = tz; b.ang = Math.PI; b.alive = true; b.spawnProtect = 0;
    a.input = { up: 0, down: 0, left: 0, right: 0, boost: 0, fire1: 0, fire2: 0, ab: 0, jump: 0, aimYaw: 0, aimPitch: 0 };
    // PID-based spawn recorder: the projectiles ARRAY is reassigned every
    // tick (const next = [] → this.projectiles = next), so a push wrapper
    // dies on tick 1. PIDs are monotonic and unique — track unseen ids.
    const spawns = [];
    const seen = new Set();
    const record = () => {
      for (const q of gd.projectiles) {
        if (!seen.has(q.id)) { seen.add(q.id); spawns.push({ k: q.kind, d: q.tier.dmg }); }
      }
    };
    return { gd, a, b, spawns, record };
  };
  const abilitySignature = (clsId, bot) => {
    const { gd, a, b, spawns, record } = setup(clsId, clsId === 'barge' ? 12 : clsId === 'rocket' ? 40 : 30, -40);
    if (bot) {
      const brain = new BotBrain(a);
      brain.targetId = b.id;
      a.turretYaw = Math.atan2(b.z - a.z, b.x - a.x);
      a.ang = a.turretYaw;
      a.fireCd1 = 999; a.fireCd2 = 999; // ONLY the special may fire (both paths)
      for (let i = 0; i < 24; i++) {
        brain.think(PHYS.tick, gd); gd.update(PHYS.tick); record();
        if (clsId === 'barge' && spawns.length >= 1) break; // one mine = one press
      }
    } else {
      a.fireCd1 = 999; a.fireCd2 = 999;
      a.input.ab = 1;
      gd.update(PHYS.tick); record();
      a.input.ab = 0;
      for (let i = 0; i < 23; i++) { gd.update(PHYS.tick); record(); } // gatling churn completes
    }
    return { sig: spawns.map(s => s.k + ':' + s.d).sort().join(','), cd: gd.players.get(a.id).abilityCd };
  };
  let ok = true;
  const cases = [['razorfin', '10 gatling slugs'], ['barge', '1 sea mine (mine layer)'], ['rocket', '4 missile-rain rockets']];
  for (const [clsId, label] of cases) {
    const h = abilitySignature(clsId, false);
    const bt = abilitySignature(clsId, true);
    const same = h.sig === bt.sig && h.sig.length > 0 && Math.abs(h.cd - bt.cd) < 1.5;
    ok = ok && same;
    console.log(`${clsId} ability (${label}): human[${h.sig}] bot[${bt.sig}] cd ${h.cd.toFixed(1)}/${bt.cd.toFixed(1)} ${same ? '== identical' : '≠ MISMATCH'}`);
  }
  // weapon parity: first spawn from fire1 is the same kind/damage both paths
  {
    const { gd, a, b, spawns, record } = setup('razorfin', 30, -40);
    a.fireCd2 = 999; a.input.fire1 = 1; gd.update(PHYS.tick); record();
    const hFirst = spawns[0];
    const { gd: gd2, a: a2, b: b2, spawns: s2, record: rec2 } = setup('razorfin', 30, -40);
    const brain2 = new BotBrain(a2);
    brain2.targetId = b2.id;
    a2.turretYaw = Math.atan2(b2.z - a2.z, b2.x - a2.x);
    a2.fireCd2 = 999;
    for (let i = 0; i < 30; i++) { brain2.think(PHYS.tick, gd2); gd2.update(PHYS.tick); rec2(); }
    const bFirst = s2[0];
    const same = hFirst && bFirst && hFirst.k === bFirst.k && hFirst.d === bFirst.d;
    ok = ok && same;
    console.log(`weapon parity: human first spawn ${hFirst && (hFirst.k + ':' + hFirst.d)} vs bot ${bFirst && (bFirst.k + ':' + bFirst.d)} ${same ? '== identical' : '≠ MISMATCH'}`);
  }
  // cadence: a bot fires its special again the moment the cd expires
  {
    const { gd, a, b } = setup('barge', 12, -40);
    const brain = new BotBrain(a);
    brain.targetId = b.id;
    // pin the bot (the barge backs off outside the 18 u ability gate when it
    // moves — a deterministic cadence check needs a stationary, aimed bot)
    let firstFireT = -1, secondFireT = -1, readyAgain = false;
    for (let i = 0; i < 60 * 60; i++) {
      a.x = 0; a.z = -40; a.ang = 0; a.turretYaw = 0; a.turretPitch = 0; a.vx = 0; a.vz = 0;
      b.x = 12; b.z = -40; b.hp = 10000; b.maxHp = 10000; b.alive = true; // unkillable target
      brain.think(PHYS.tick, gd);
      gd.update(PHYS.tick);
      if (a.abilityCd > 0 && firstFireT < 0) firstFireT = i;
      // the ability actually RE-FIRED: the cd had to expire first (≤ 0), then
      // a new cd appears — not the first fire's own window
      if (firstFireT >= 0 && a.abilityCd <= 0.05 && i > firstFireT + 5) readyAgain = true;
      if (readyAgain && a.abilityCd > 0 && secondFireT < 0) secondFireT = i;
      if (secondFireT >= 0) break;
    }
    const gapOk = secondFireT > 0 && (secondFireT - firstFireT) <= (a.def.ability.cd + (a.def.ability.chargeCd || 0) * (a.def.ability.charges || 0)) * 30 + 6;
    ok = ok && gapOk;
    console.log(`barge bot cadence: first special tick ${firstFireT}, second ${secondFireT}, gap ${((secondFireT - firstFireT) / 30).toFixed(2)}s (cd ${a.def.ability.cd}s)`);
    if (!gapOk) console.log('  ❌ BOT SPECIAL CADENCE NOT FULL-RATE');
  }
  console.log(ok ? '✅ MECH PARITY (player and bot abilities + weapons identical)' : '❌ MECH PARITY FAILED');
  if (!ok) process.exit(1);
}

// ---- COLLECTIBLE SPACING (user: "some are positioned too close together")
// — the sanitize pass must guarantee: pickups ≥ 26 u apart, ≥ 8 u clear of
// every rock/island face, outside every ramp pad footprint. ----
{
  for (const mapId of ['lagoon', 'cove']) {
    const gd = new Game('ffa', 'lagoon');
    gd.mapId = mapId; // the Game constructor takes no map arg — set like the host message does
    gd.startCountdown(); // resetMatch initializes pickups + runs the sanitizer
    for (let i = 0; i < PHYS.countdown / PHYS.tick + 2; i++) gd.update(PHYS.tick);
    let okMap = true;
    for (let i = 0; i < gd.pickups.length; i++) {
      for (let j = i + 1; j < gd.pickups.length; j++) {
        if (Math.hypot(gd.pickups[i].x - gd.pickups[j].x, gd.pickups[i].z - gd.pickups[j].z) < 26) okMap = false;
      }
      for (const rk of gd.map.rocks) {
        const dx = gd.pickups[i].x - rk.x, dz = gd.pickups[i].z - rk.z;
        if (Math.abs(dx) < rk.w / 2 + 8 && Math.abs(dz) < rk.d / 2 + 8) okMap = false;
      }
      for (const z of gd.map.boostZones || []) {
        const along = z.dir === 'x' ? Math.abs(gd.pickups[i].x - z.x) : Math.abs(gd.pickups[i].z - z.z);
        const across = z.dir === 'x' ? Math.abs(gd.pickups[i].z - z.z) : Math.abs(gd.pickups[i].x - z.x);
        if (along < z.d / 2 + 3 && across < z.w / 2 + 3) okMap = false;
      }
    }
    console.log(`${mapId} pickups: ${gd.pickups.map(p => '(' + p.x + ',' + p.z + ')').join(' ')}`);
    console.log(okMap ? `✅ ${mapId.toUpperCase()} COLLECTIBLE SPACING (≥26 u apart, clear of rocks + ramps)` : `❌ ${mapId.toUpperCase()} COLLECTIBLES TOO CLOSE`);
    if (!okMap) process.exit(1);
  }
}

// ---- CANNON COVE batteries (the namesake): idle → WARN telegraph → high-arc
// lob → impact damage on anyone at the aim point. owner -1 (environmental):
// hits everyone, credits nobody, kills read "the cove cannons". ----
{
  const gcv = new Game('ffa');
  gcv.mapId = 'cove';
  gcv.startCountdown();
  for (let i = 0; i < Math.ceil(PHYS.countdown / PHYS.tick) + 2; i++) gcv.update(PHYS.tick);
  for (const [id, p] of [...gcv.players]) if (p.bot) gcv.players.delete(id); // solo victim
  const victim = gcv.addPlayer('V', 'barge', {}, false);
  const c0 = gcv.map.cannons[0];
  victim.x = c0.aims[0].x; victim.z = c0.aims[0].z;
  const hp0 = victim.hp;
  let warnSeen = false, fired = false, envShell = false;
  for (let i = 0; i < Math.ceil(12 / PHYS.tick); i++) {
    for (const f of gcv.fxQueue) if (f.f === 'cannonWarn') warnSeen = true;
    for (const q of gcv.projectiles) if (q.kind === 'cannon' && q.owner === -1) { fired = true; envShell = true; }
    gcv.update(PHYS.tick);
  }
  const dmg = hp0 - victim.hp;
  const ok = warnSeen && fired && envShell && dmg > 12;
  console.log(`cove cannons: warn=${warnSeen} fired=${fired} owner-1=${envShell} dmg=${dmg.toFixed(1)} (hp ${hp0}→${victim.hp.toFixed(1)})`);
  console.log(ok ? '✅ CANNON COVE BATTERIES (telegraph → lob → impact damage)' : '❌ CANNON COVE BATTERIES BROKEN');
  if (!ok) process.exit(1);
}
