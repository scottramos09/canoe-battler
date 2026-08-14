'use strict';
// ============================================================
// CANOE ARENA — persistent ACCOUNT profiles (localStorage)
// Login screen → one profile per username. XP → levels → cosmetic unlocks.
// The TEST profile (test / test) is seeded at max level with everything
// unlocked so the style window can be browsed freely.
// ============================================================
const ACCTS_KEY = 'canoe_arena_accounts_v1';
const SESSION_KEY = 'canoe_arena_session_v1';
const MAX_LEVEL = 50; // levelFromXp caps here

export const PAINTS = [
  { id: 'classic', name: 'Classic Red', color: '#e8573d', stripe: '#7a1f10', lvl: 1 },
  { id: 'lagoon', name: 'Lagoon Teal', color: '#2aa0a8', stripe: '#0e5c63', lvl: 1 },
  { id: 'sunset', name: 'Sunset Orange', color: '#e8842a', stripe: '#7a3c0e', lvl: 3 },
  { id: 'royal', name: 'Royal Blue', color: '#3a5cd8', stripe: '#1a2c7a', lvl: 4 },
  { id: 'toxic', name: 'Toxic Green', color: '#7fbf2a', stripe: '#3c6b0e', lvl: 5 },
  { id: 'battle', name: 'Battle Grey', color: '#8a94a0', stripe: '#3c4450', lvl: 7 },
  { id: 'grape', name: 'Deep Grape', color: '#7a3ad8', stripe: '#3a1a7a', lvl: 9 },
  { id: 'hotpink', name: 'Hot Pink', color: '#e04f9f', stripe: '#7a1f55', lvl: 12 },
  { id: 'midnight', name: 'Midnight', color: '#1c2a55', stripe: '#0a1230', lvl: 15 },
  { id: 'gold', name: 'Champion Gold', color: '#d8a72a', stripe: '#6b4a0e', lvl: 20 },
];

// icon = the PICTURE shown in the style window; each one is matched to the
// 3D asset built for the canoe (box-art skull, green dragon, tusked walrus,
// winged orange phoenix, finned shark, tentacled kraken, hatted captain).
export const FIGUREHEADS = [
  { id: 'none', name: 'No Figurehead', icon: '🚫', lvl: 1 },
  { id: 'skull', name: 'Skull', icon: '💀', lvl: 2 },
  { id: 'dragon', name: 'Dragon', icon: '🐉', lvl: 4 },
  { id: 'walrus', name: 'Walrus', icon: '🦭', lvl: 6 },
  { id: 'phoenix', name: 'Phoenix', icon: '🦅', lvl: 8 },
  { id: 'shark', name: 'Shark', icon: '🦈', lvl: 10 },
  { id: 'kraken', name: 'Kraken', icon: '🐙', lvl: 14 },
  { id: 'capn', name: 'Captain', icon: '🧑‍✈️', lvl: 18 },
];

export const FLAGS = [
  { id: 'plain', name: 'Plain', color: '#ffffff', icon: '▮', lvl: 1 },
  { id: 'anchor', name: 'Anchor', color: '#7fd4ff', icon: '⚓', lvl: 3 },
  { id: 'bolt', name: 'Lightning', color: '#ffcf4d', icon: '⚡', lvl: 6 },
  { id: 'star', name: 'Star', color: '#ff8a5c', icon: '⭐', lvl: 8 },
  { id: 'crown', name: 'Crown', color: '#ffd700', icon: '👑', lvl: 11 },
  // the aggressive designs live in the LATER tiers (user: "the more
  // aggressive ones being later tiers")
  { id: 'skull', name: 'Jolly Roger', color: '#1a1a1a', icon: '☠️', lvl: 14 },
  { id: 'blackbeard', name: 'Blackbeard', color: '#0d0d12', icon: '💀', lvl: 16 },
  { id: 'kraken', name: 'Kraken', color: '#3a1a6a', icon: '🐙', lvl: 19 },
];

export const TRAILS = [
  { id: 'none', name: 'No Trail', color: null, icon: '🚫', lvl: 1 },
  { id: 'stars', name: 'Stars', color: '#ffffff', icon: '✨', lvl: 5 },
  { id: 'flames', name: 'Flames', color: '#ff9d3c', icon: '🔥', lvl: 9 },
  { id: 'poison', name: 'Poison', color: '#9dff3c', icon: '☣️', lvl: 12 },
  { id: 'dookie', name: 'Dookie', color: '#8a5a2a', icon: '💩', lvl: 15 },
  { id: 'ice', name: 'Ice', color: '#7fdcff', icon: '❄️', lvl: 18 },
];

// trail-id migration (the fun icon-pixel set replaced the old tint names)
const TRAIL_MIGRATE = { sparkle: 'stars', embers: 'flames', frost: 'ice', toxic: 'poison' };

export function xpForLevel(lv) { return 80 + (lv - 1) * 60; }
export function levelFromXp(xp) {
  let lv = 1, need = xpForLevel(1);
  while (xp >= need && lv < MAX_LEVEL) { xp -= need; lv++; need = xpForLevel(lv); }
  return { level: lv, into: xp, need };
}

function defaults() {
  return {
    name: 'Paddler',
    xp: 0,
    totalKills: 0, totalWins: 0, totalGames: 0, bestStreak: 0,
    sel: { paint: 'lagoon', figurehead: 'none', flag: 'plain', trail: 'none' },
    lastUnlocked: [],
  };
}

// ---- account store ----
function readAccounts() {
  try {
    const a = JSON.parse(localStorage.getItem(ACCTS_KEY));
    if (a && typeof a === 'object') return a;
  } catch { }
  return {};
}
function writeAccounts(a) { localStorage.setItem(ACCTS_KEY, JSON.stringify(a)); }

// Seed the TEST profile: max level (everything unlocked), a showcase loadout.
// Idempotent — never overwrites a player's own saves for 'test'.
export function initAccounts() {
  const a = readAccounts();
  if (!a.test) {
    a.test = Object.assign(defaults(), {
      pass: 'test',
      name: 'Test Captain',
      xp: 1e9, // way past the level-50 cap → max level
      sel: { paint: 'gold', figurehead: 'dragon', flag: 'crown', trail: 'embers' },
    });
    writeAccounts(a);
  }
}

export function currentUser() {
  try { return localStorage.getItem(SESSION_KEY) || null; } catch { return null; }
}

// Log in to an existing account; unknown username + password → NEW account
// (fresh level-1 profile). Returns { ok, error, created }.
export function login(user, pass) {
  const u = String(user || '').trim().slice(0, 16);
  const p = String(pass || '');
  if (!u) return { ok: false, error: 'Enter a username' };
  if (!p) return { ok: false, error: 'Enter a password' };
  const a = readAccounts();
  let created = false;
  if (a[u]) {
    if (a[u].pass !== p) return { ok: false, error: 'Wrong password' };
  } else {
    a[u] = Object.assign(defaults(), { pass: p, name: u });
    created = true;
    writeAccounts(a);
  }
  localStorage.setItem(SESSION_KEY, u);
  loadProfile();
  return { ok: true, created };
}

export function logout() {
  localStorage.removeItem(SESSION_KEY);
  loadProfile();
}

// ---- active profile (mirrors the single-profile API) ----
let prof = null;
let activeUser = null;
export function loadProfile() {
  activeUser = currentUser();
  const a = readAccounts();
  try {
    prof = (activeUser && a[activeUser]) ? JSON.parse(JSON.stringify(a[activeUser])) : defaults();
    delete prof.pass; // never keep the password in the live object
  } catch { prof = defaults(); }
  prof = Object.assign(defaults(), prof);
  // migrate old trail ids (sparkle/embers/frost/toxic → stars/flames/ice/poison)
  if (prof.sel && TRAIL_MIGRATE[prof.sel.trail]) prof.sel.trail = TRAIL_MIGRATE[prof.sel.trail];
  return prof;
}
export function getProfile() { return prof; }
function save() {
  if (!activeUser) return;
  const a = readAccounts();
  if (!a[activeUser]) return;
  const copy = JSON.parse(JSON.stringify(prof));
  a[activeUser] = Object.assign({}, a[activeUser], copy, { pass: a[activeUser].pass });
  writeAccounts(a);
}

export function isUnlocked(item) { return item.lvl <= levelFromXp(prof.xp).level; }
export function unlockList() {
  const lv = levelFromXp(prof.xp).level;
  const out = [];
  for (const list of [PAINTS, FIGUREHEADS, FLAGS, TRAILS]) {
    for (const it of list) if (it.lvl === lv) out.push(it);
  }
  return out;
}

// returns { leveled, newLevel, unlocks:[...] }
export function addXp(amount) {
  const before = levelFromXp(prof.xp).level;
  prof.xp += Math.max(0, Math.round(amount));
  const after = levelFromXp(prof.xp).level;
  save();
  const unlocks = after > before ? unlockList() : [];
  return { leveled: after > before, newLevel: after, unlocks };
}

export function recordMatch(r) {
  prof.totalGames++;
  prof.totalKills += r.kills || 0;
  if (r.win) prof.totalWins++;
  if (r.streak && r.streak > prof.bestStreak) prof.bestStreak = r.streak;
  save();
}

export function setCosmetic(kind, id) {
  prof.sel[kind] = id;
  save();
}
export function setName(n) { prof.name = n; save(); }
