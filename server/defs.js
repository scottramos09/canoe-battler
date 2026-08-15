'use strict';
// ============================================================
// CANOE ARENA — shared game definitions (sent to clients on join)
// Fully 3D: positions are (x, y, z) with y = height above water.
// Everything here must be JSON-serializable.
// ============================================================

const PHYS = {
  tick: 1 / 30,
  maxPlayers: 8,
  minFill: 6,          // bots fill lobby/match to this many total
  arena: 100,          // half-size of the square arena (walls at ±100)
  wallH: 6,            // walls are 6 tall — lob shells over them!
  jumpVy: 9.5,         // Space/A hop — clears ~1.9 u, lands with a splash
  jumpFwd: 6,          // forward kick so the hop carries momentum (no pop-in-place)
  jumpCd: 2.2,
  rampBoost: 10,       // surge acceleration along the ramp while riding it
  // BOOST-RAMP (racing-game reference — Mario Kart / TrackMania / Sonic
  // pads): the launch sets ~2.2x the boat's top speed and it PERSISTS for a
  // boost window (steerable, held by the engine), then decays naturally.
  rampBoostSpd: 2.2,   // launch multiplier vs the boat's top speed
  rampBoostT: 1.8,     // seconds the boosted speed is held
  rampBoostDrag: 0.25, // glide drag while the boost window lasts
  // SHIELD system — pickups ONLY: grab a pickup on the map to gain a shield
  // that absorbs damage BEFORE health (same damage rules as hp).
  shieldMax: 60,
  shieldRespawn: [18, 32], // RNG respawn window (seconds) after a pickup is taken
  // UPGRADE-on-kill: every registered kill upgrades the weapon that dealt it,
  // capped at 10 levels; +10% damage per level (2x at level 10).
  killUpMax: 10,
  killUpDmg: 0.10,
  waterY: 0,
  playerR: 1.6,
  playerCenterY: 0.45, // hull center height above water
  boostTime: 1.25,
  overclockTime: 8,
  overclockMul: 0.62,
  crateInterval: 16,
  crateMax: 5,
  killCredits: 100,
  assistCredits: 40,
  hitCredits: 3,
  trickleCredits: 1,
  trickleEvery: 4,
  killScore: 100,
  assistScore: 40,
  assistShare: 0.2,
  shopDisabled: true, // user: "disable all shop features and any upgrades
  // purchased through the shop" — tryBuy refuses everything (players AND
  // bots stay at tier 0; kills still grant weapon levels, that path is free)
  ramMinRelSpeed: 4.5,
  ramBase: 9,
  ramSpeedMul: 0.55,
  airSlamDmg: 28,      // landing on someone from the air
  respawn: 3,
  spawnProtect: 2.5,
  spawnProtectMul: 0.2,
  countdown: 4,
  endTime: 9,
  gravity: 24,
  airDrag: 2.4,        // extra drag while airborne
  airTurnMul: 0.4,     // steering authority while airborne
  muzzleY: 0.6,        // turret barrel height (matches visual mount)
};

// ---- weapon tier fields:
// n,name,dmg,spd,cd,count,spread,maxPitch,high,splash,pierce,homing,life,cost,desc
// maxPitch: max elevation in radians. high: use high-arc ballistic solution.
// kind: rail|cannon|mortar|rocket|shot|mine|torp|bomblet|harpoon

const CLASSES = {
  razorfin: {
    id: 'razorfin', name: 'RAZORFIN DART', icon: '⚡', tag: 'Light Scout',
    desc: 'Featherweight racer. Outrun everything, pepper them with rail slugs and sow wake mines.',
    hp: 140, speed: 13.5, reverse: 8, accel: 22, turn: 2.7, drag: 0.6,
    boostCd: 4, boostMul: 1.95, mass: 1.0, ramMul: 0.85, turretTurn: 11,
    size: 1.0, paint: '#e8573d',
    w1: { name: 'RAIL LANCE', icon: '🗡', desc: 'Long-range precision slugs',
      tiers: [
        { n: 'Pea Rail', dmg: 12, spd: 46, cd: 0.55, count: 1, spread: 0, maxPitch: 0.62, cost: 0, kind: 'rail', life: 3.2, barrelLen: 1.5, tip: 1.7, tipY: 0.15, desc: 'Single rail slug' },
        { n: 'Twin Rail', dmg: 12, spd: 48, cd: 0.5, count: 2, spread: 0.12, maxPitch: 0.62, cost: 100, kind: 'rail', life: 3.2, barrelLen: 1.5, tip: 1.7, tipY: 0.15, desc: 'Two parallel slugs' },
        { n: 'Rail Lance', dmg: 23, spd: 55, cd: 0.6, count: 1, spread: 0, pierce: 1, maxPitch: 0.6, cost: 220, kind: 'rail', life: 3.4, barrelLen: 2.1, tip: 2.3, tipY: 0.15, desc: 'Pierces one canoe' },
        { n: 'Triple Lance', dmg: 18, spd: 56, cd: 0.55, count: 3, spread: 0.15, pierce: 1, maxPitch: 0.6, cost: 380, kind: 'rail', life: 3.4, barrelLen: 1.8, tip: 2.1, tipY: 0.15, desc: '3 piercing lances' },
        { n: 'Overdrive Lance', dmg: 31, spd: 64, cd: 0.7, count: 3, spread: 0.1, pierce: 2, maxPitch: 0.65, cost: 600, kind: 'rail', life: 3.6, barrelLen: 2.0, tip: 2.3, tipY: 0.15, desc: '3 lances, pierce 2' },
      ] },
    w2: { name: 'WAKE TOYS', icon: '💣', desc: 'Mines & homing torpedoes',
      tiers: [
        { n: 'Wake Mine', dmg: 34, splash: 5, cd: 2.2, maxPitch: 0.1, cost: 0, kind: 'mine', life: 25, tip: 1.6, tipY: 0.3, hp: 1, desc: 'Drops a proximity mine — any shot pops it' },
        { n: 'Dense Mine', dmg: 45, splash: 6.5, cd: 2.2, maxPitch: 0.1, cost: 120, kind: 'mine', life: 25, tip: 1.6, tipY: 0.3, hp: 1, desc: 'Bigger boom' },
        { n: 'Homing Torpedo', dmg: 40, spd: 17, cd: 2.4, splash: 4.5, maxPitch: 0.5, cost: 260, kind: 'torp', life: 9, tip: 1.6, tipY: 0.3, desc: 'Straight-running torpedo, accelerates' },
        { n: 'Torp Volley', dmg: 30, spd: 17, cd: 2.6, count: 2, spread: 0.3, splash: 4, maxPitch: 0.5, cost: 420, kind: 'torp', life: 9, tip: 1.6, tipY: 0.3, desc: 'Two straight runners' },
        { n: 'Shark Torp', dmg: 58, spd: 20, cd: 2.8, splash: 6, maxPitch: 0.5, cost: 650, kind: 'torp', life: 10, tip: 1.6, tipY: 0.3, desc: 'The apex predator, straight as an arrow' },
      ] },
    hull: { name: 'HULL RIG', icon: '🛡', desc: 'Armor + speed',
      tiers: [
        { n: 'Stock Hull', hp: 0, spd: 0, cost: 0 },
        { n: 'Carbon Skin', hp: 30, spd: 0.6, cost: 120 },
        { n: 'Aero Planks', hp: 60, spd: 1.0, cost: 260 },
        { n: 'Racing Shell', hp: 100, spd: 1.5, cost: 420 },
        { n: 'Hyper Keel', hp: 150, spd: 2.1, cost: 600 },
      ] },
    ability: { name: 'GATLING BURST', key: 'E', desc: '10-rail machine-gun burst — churned out fast', cd: 6 },
  },

  barge: {
    id: 'barge', name: 'THUNDER BARGE', icon: '💥', tag: 'Heavy Artillery',
    desc: 'A floating fortress. Slow, absurdly tanky, and armed with cannons that delete boats.',
    hp: 250, speed: 8.6, reverse: 5, accel: 14, turn: 1.55, drag: 0.55,
    boostCd: 7, boostMul: 1.7, mass: 1.55, ramMul: 1.5, turretTurn: 9,
    size: 1.25, paint: '#3e6f4f',
    w1: { name: 'BOOM CANNONS', icon: '💣', desc: 'High-arcing explosive shells',
      tiers: [
        { n: 'Pop Cannon', dmg: 50, spd: 282.8, grav: 800, high: 1, maxPitch: 1.5, cd: 1.1, splash: 3.5, cost: 0, kind: 'cannon', life: 8, arm: 15, maxRange: 100, barrelLen: 0.7, tip: 1.7, tipY: 0.42, desc: 'Long-range pop — range 15–100 u' },
        { n: 'Twin Boom', dmg: 50, spd: 282.8, grav: 800, high: 1, maxPitch: 1.5, cd: 1.15, count: 2, spread: 0.2, splash: 4, cost: 100, kind: 'cannon', life: 8, arm: 15, maxRange: 100, barrelLen: 0.68, tip: 1.7, tipY: 0.42, desc: 'Two barrels — range 15–100 u' },
        { n: 'Broadside', dmg: 55, spd: 282.8, grav: 800, high: 1, maxPitch: 1.5, cd: 1.3, count: 3, spread: 0.55, splash: 4.5, cost: 220, kind: 'cannon', life: 8, arm: 15, maxRange: 100, barrelLen: 0.65, tip: 1.7, tipY: 0.42, desc: 'Three guns — range 15–100 u' },
        { n: 'Cluster Mortar', dmg: 65, spd: 282.8, grav: 800, high: 1, maxPitch: 1.5, cd: 1.5, count: 3, spread: 0.3, splash: 5.5, cost: 380, kind: 'cannon', life: 8.5, arm: 15, maxRange: 100, barrelLen: 0.77, tip: 1.7, tipY: 0.42, desc: 'Raining fire — range 15–100 u' },
        { n: 'DOOM MORTAR', dmg: 180, spd: 282.8, grav: 800, high: 1, maxPitch: 1.5, cd: 2.5, splash: 9.5, cost: 600, kind: 'mortar', life: 9, arm: 15, maxRange: 100, barrelLen: 0.85, tip: 1.95, tipY: 0.42, desc: 'The ocean flinches — range 15–100 u' },
      ] },
    w2: { name: 'CHUG GUN', icon: '🔫', desc: 'Rapid flat-fire autocannon',
      tiers: [
        { n: 'Chug Gun', dmg: 6, spd: 38, cd: 0.16, count: 1, spread: 0.06, maxPitch: 0.3, cost: 0, kind: 'shot', life: 2.4, tip: 1.45, tipY: 0.1, desc: 'Chug chug chug' },
        { n: 'Bigger Chug', dmg: 8, spd: 39, cd: 0.14, maxPitch: 0.3, cost: 100, kind: 'shot', life: 2.4, tip: 1.45, tipY: 0.1, desc: 'Chug chug CHUG' },
        { n: 'Twin Chug', dmg: 7, spd: 39, cd: 0.15, count: 2, spread: 0.16, maxPitch: 0.3, cost: 240, kind: 'shot', life: 2.4, tip: 1.45, tipY: 0.1, desc: 'Double-barrel chug' },
        { n: 'Shredder', dmg: 9, spd: 40, cd: 0.1, count: 1, spread: 0.05, maxPitch: 0.3, cost: 400, kind: 'shot', life: 2.4, tip: 1.45, tipY: 0.1, desc: 'A wall of lead' },
        { n: 'Harpoon Cannon', dmg: 46, spd: 40, cd: 1.4, pierce: 2, kback: 13, maxPitch: 0.35, cost: 600, kind: 'harpoon', life: 2.6, desc: 'Pins boats, knocks them back' },
      ] },
    hull: { name: 'ARMOR PLATING', icon: '🛡', desc: 'Thicc armor',
      tiers: [
        { n: 'Riveted Hull', hp: 0, spd: 0, cost: 0 },
        { n: 'Iron Straps', hp: 60, spd: 0.35, cost: 120 },
        { n: 'Bolt Plates', hp: 120, spd: 0.6, cost: 260 },
        { n: 'Battleship Skin', hp: 190, spd: 0.9, cost: 420 },
        { n: 'DOOM Fortress', hp: 280, spd: 1.3, cost: 620 },
      ] },
    ability: { name: 'MINE LAYER', key: 'E', desc: 'Drops 3 sea mines — 10s refill', cd: 10, charges: 3, chargeCd: 0.5,
      mine: { n: 'Sea Mine', dmg: 45, spd: 0, cd: 0, maxPitch: 0, cost: 0, kind: 'mine', life: 30, hp: 1, desc: 'Dropped sea mine' } },
  },

  rocket: {
    id: 'rocket', name: 'SCRAP ROCKET', icon: '🚀', tag: 'Rocket Junkboat',
    desc: 'Junk-built and furious. Rocket pods for range, a shotgun for up close, and a hop to dodge shells.',
    hp: 180, speed: 11, reverse: 6, accel: 18, turn: 2.05, drag: 0.6,
    boostCd: 5, boostMul: 1.85, mass: 1.2, ramMul: 1.1, turretTurn: 12,
    size: 1.1, paint: '#c98a2b',
    w1: { name: 'ROCKET PODS', icon: '🚀', desc: 'Splashy unguided rockets',
      tiers: [
        { n: 'Single Pod', dmg: 16, spd: 30, cd: 1.05, splash: 2.5, maxPitch: 0.8, cost: 0, kind: 'rocket', life: 3, barrelLen: 0.55, tip: 0.69, tipY: 0, desc: 'One lonely rocket' },
        { n: 'Twin Pods', dmg: 16, spd: 31, cd: 1.1, count: 2, spread: 0.18, splash: 3, maxPitch: 0.8, cost: 100, kind: 'rocket', life: 3, barrelLen: 0.55, tip: 0.69, tipY: 0, desc: 'Two angry friends' },
        { n: 'Quad Pod', dmg: 14, spd: 31, cd: 1.3, count: 4, spread: 0.34, splash: 3.2, maxPitch: 0.8, cost: 220, kind: 'rocket', life: 3, barrelLen: 0.55, tip: 0.69, tipY: 0, desc: 'Four opinions' },
        { n: 'Swarm Pod', dmg: 13, spd: 32, cd: 1.55, count: 6, spread: 0.55, splash: 3.2, maxPitch: 0.8, cost: 380, kind: 'rocket', life: 3, barrelLen: 0.55, tip: 0.69, tipY: 0, desc: 'A cloud of NO' },
        { n: 'CLUSTER HELL', dmg: 10, spd: 32, cd: 1.55, count: 3, spread: 0.2, splash: 2.5, split: 1, maxPitch: 0.8, cost: 600, kind: 'rocket', life: 1.0, barrelLen: 0.55, tip: 0.69, tipY: 0, desc: 'Rockets that bloom into bomblets' },
      ] },
    w2: { name: 'SCRAP SHOTGUN', icon: '🔫', desc: 'Close-range scrap burst',
      tiers: [
        { n: 'Blunderbuss', dmg: 8, spd: 30, cd: 0.9, count: 5, spread: 0.75, maxPitch: 0.25, life: 0.9, cost: 0, kind: 'shot', tip: 1.45, tipY: 0.1, desc: 'A mouthful of bolts' },
        { n: 'Longer Blunder', dmg: 9, spd: 31, cd: 0.9, count: 6, spread: 0.8, maxPitch: 0.25, life: 1.0, cost: 100, kind: 'shot', tip: 1.45, tipY: 0.1, desc: 'Even more bolts' },
        { n: 'Double Barrel', dmg: 9, spd: 31, cd: 0.8, count: 7, spread: 0.85, maxPitch: 0.25, life: 1.0, cost: 240, kind: 'shot', tip: 1.45, tipY: 0.1, desc: 'Two angry mouths' },
        { n: 'Flak Burst', dmg: 10, spd: 32, cd: 0.75, count: 8, spread: 1.0, maxPitch: 0.25, life: 1.05, cost: 400, kind: 'shot', tip: 1.45, tipY: 0.1, desc: 'Anti-everything' },
        { n: 'DEVASTATOR', dmg: 12, spd: 33, cd: 0.9, count: 12, spread: 1.25, maxPitch: 0.25, life: 1.1, cost: 600, kind: 'shot', tip: 1.45, tipY: 0.1, desc: 'A boatload of boat-wrecker' },
      ] },
    hull: { name: 'JUNK ARMOR', icon: '🛡', desc: 'Scrap plating',
      tiers: [
        { n: 'Duct Tape', hp: 0, spd: 0, cost: 0 },
        { n: 'Scrap Plates', hp: 40, spd: 0.7, cost: 110 },
        { n: 'Double Scrap', hp: 80, spd: 1.2, cost: 240 },
        { n: 'Girder Cage', hp: 130, spd: 1.7, cost: 400 },
        { n: 'Junk Titan', hp: 190, spd: 2.2, cost: 600 },
      ] },
    ability: { name: 'MISSILE RAIN', key: 'E', desc: 'Launches 4 rockets in a spreading fan', cd: 10 },
  },
};

const MODES = {
  ffa: { id: 'ffa', name: 'FFA', icon: '🏆', time: 480, scoreCap: 2000, respawn: 3, zone: null,
    desc: 'Free-for-all — every canoe for itself. Sink enemies to score; first to 2000 points wins.' },
  koth: { id: 'koth', name: 'King of the Hill', icon: '👑', time: 300, scoreCap: 0, respawn: 3,
    zone: { x: 0, z: 0, r: 22, rate: 8 },
    desc: 'King of the Hill — hold the glowing zone to earn points. Highest score when the timer runs out wins.' },
};

// ramps: axis-aligned launch ramps. dir: 'x'|'z', sign: +1 = uphill toward +axis.
// Ride up and launch airborne when leaving the footprint fast enough.
const MAPS = {
  lagoon: { id: 'lagoon', name: 'BOX LAGOON', desc: 'Central island, rocks & launch ramps',
    rocks: [
      { x: -35, z: -20, w: 5, d: 5, h: 2.6 }, { x: 30, z: -35, w: 4, d: 7, h: 2.8 }, { x: -20, z: 35, w: 6, d: 4, h: 2.4 },
      { x: 40, z: 25, w: 5, d: 5, h: 3.0 }, { x: -45, z: 10, w: 4, d: 4, h: 2.4 }, { x: 15, z: 5, w: 5, d: 5, h: 2.8 },
      { x: -5, z: -45, w: 4, d: 6, h: 2.6 }, { x: 55, z: -55, w: 5, d: 5, h: 3.2 }, { x: -55, z: 55, w: 5, d: 5, h: 3.0 },
    ],
    // BOOST ZONES (racing-pad reference — Mario Kart / TrackMania pads):
    // wide flat areas on the water. NOT physical — the hull drives through
    // them and gets a forward surge (~2.2x top speed) along its OWN heading,
    // held by the engine for the boost window. dir/sign only orient the pad's
    // chevron arrows (the boost itself follows the player's travel).
    boostZones: [
      { x: 0, z: -60, w: 18, d: 10, dir: 'z', sign: 1, h: 1.3 },
      { x: -60, z: 0, w: 18, d: 10, dir: 'x', sign: 1, h: 1.3 },
      { x: 60, z: 60, w: 18, d: 10, dir: 'x', sign: -1, h: 1.3 },
    ],
    isles: [
      { x: 0, z: 0, w: 14, d: 14, y: 0 }, // central island
    ],
    // shield pickups — grab one to gain a shield (respawns on an RNG timer)
    pickups: [
      { x: -30, z: -12 }, { x: 36, z: -34 }, { x: -28, z: 32 }, { x: 36, z: 20 }, { x: -2, z: 46 },
    ],
    skyisles: [
      { x: -40, z: -45, y: 16, w: 10, d: 8 }, { x: 45, z: 40, y: 18, w: 12, d: 9 },
    ],
  },
  cove: { id: 'cove', name: 'CANNON COVE', desc: 'Horseshoe bay guarded by cannon batteries',
    rocks: [
      // fortress rocks at the bay-mouth corners — the cannon batteries sit on top
      { x: -50, z: -28, w: 9, d: 11, h: 5.0 }, { x: 50, z: -28, w: 9, d: 11, h: 5.0 },
      // outer sentinel rocks (outside the bay, flank cover)
      { x: -70, z: 55, w: 5, d: 5, h: 2.8 }, { x: 70, z: 55, w: 5, d: 5, h: 2.8 },
      { x: -70, z: -68, w: 4, d: 6, h: 2.6 }, { x: 70, z: -68, w: 4, d: 6, h: 2.6 },
    ],
    // BOOST RAMPS: the bay-mouth ramp launches INTO the bay, the head-island
    // ramp launches back out, and the flank ramps jump OVER the headland arms
    boostZones: [
      { x: 0, z: -66, w: 18, d: 10, dir: 'z', sign: 1, h: 1.3 },
      { x: 0, z: 34, w: 18, d: 10, dir: 'z', sign: -1, h: 1.3 },
      { x: -58, z: 15, w: 12, d: 12, dir: 'x', sign: 1, h: 1.3 },
      { x: 58, z: 15, w: 12, d: 12, dir: 'x', sign: -1, h: 1.3 },
    ],
    isles: [
      // THE COVE: two long headland arms form the horseshoe; the head island
      // closes the south end. Low beaches — ramps clear them (top ~2.3 u).
      { x: -34, z: 15, w: 9, d: 62, y: 0 }, // west arm (z -16..46)
      { x: 34, z: 15, w: 9, d: 62, y: 0 },  // east arm
      { x: 0, z: 48, w: 28, d: 14, y: 0 },  // head island (z 41..55)
    ],
    pickups: [
      { x: -18, z: 2 }, { x: 18, z: 2 }, { x: -8, z: 26 },
      { x: -72, z: -72 }, { x: 72, z: -72 },
    ],
    skyisles: [
      { x: 0, z: -8, y: 15, w: 10, d: 8 }, // crow's-nest isle over the bay mouth
    ],
    // THE NAMESAKE — fortress cannon batteries. Each cycles: idle → WARN
    // (telegraphed aim point) → lob an arcing shell at a fixed bay point.
    // owner -1 = environmental: no kill credit, "claimed by the cove cannons".
    cannons: [
      { x: -50, z: -28, y: 5.0, every: 8, warn: 1.4, dmg: 26, splash: 4.5, spd: 220,
        aims: [{ x: -14, z: -42 }, { x: 0, z: -54 }, { x: 14, z: -40 }] },
      { x: 50, z: -28, y: 5.0, every: 9, warn: 1.4, dmg: 26, splash: 4.5, spd: 220,
        aims: [{ x: 14, z: -42 }, { x: 0, z: -54 }, { x: -14, z: -40 }] },
      { x: 0, z: 48, y: 2.3, every: 7, warn: 1.2, dmg: 22, splash: 4, spd: 200,
        aims: [{ x: 0, z: 14 }, { x: -20, z: 6 }, { x: 20, z: 6 }] },
    ],
  },
};

const CRATE_KINDS = {
  heal: { name: 'REPAIR KIT', color: '#3fd96b', weight: 0.45, heal: 60 },
  credits: { name: 'BOOTY CRATE', color: '#ffd23f', weight: 0.35, credits: 50 },
  overclock: { name: 'OVERCLOCK', color: '#ff4fd8', weight: 0.2, time: 8 },
};

const BOT_NAMES = ['Salty Sam', 'Barnacle Bob', 'Captain Crunch', 'One-Eyed Wendy', 'Pegleg Pete',
  'Mad Mary', 'Scurvy Steve', 'Dread Dave', 'Tidepool Tina', 'Kraken Karl', 'Grog Gus',
  'Bilgewater Bill', 'Rusty Rivet', 'Foamfinger', 'Noodle Neck', 'Sinker Sally', 'Blubber Bart',
  'Cannonball Carl', 'Drydock Doug', 'Mermaid Mike'];

const SPAWNS = [];
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
  SPAWNS.push({ x: Math.cos(a) * 75, z: Math.sin(a) * 75 });
}

module.exports = { PHYS, CLASSES, MODES, MAPS, CRATE_KINDS, BOT_NAMES, SPAWNS };
