# 📋 HANDOFF — CANOE ARENA (`C:\Users\Scott\canoe-battler`)

> Written for a fresh context window. Read this first — it replaces tribal knowledge.
> Last updated: 2026-08-13, after the optimization pass + drive-straight hardening + mine-layer mechanics pass + collectible/menu normalization + shake/assist/bot-aim fix round + online-multiplayer-prep lobby round.

---

## 1. What this project is

Fully 3D multiplayer canoe battler: **three.js client** (every mesh a box), **authoritative
Node + ws server** (:3000, 30 Hz) with client-side prediction. Eventually Netlify (static) +
Render free tier (WS server), playtested with friends.

- Client: `public/` (index.html, js/, vendor/) — cache-busted with **?v=71** (1 tag).
- Server: `server/` — `server.js` (WS + static), `game.js` (sim), `defs.js` (shared truth),
  `bots.js` (AI).
- Shared truth: `server/defs.js` ships to clients on join; `game.js` ↔ `public/js/ballistics.js`
  are mirror math.

## 2. THE ACTIVE FIGHT (recent user complaints → delivered)

### Barge basic attack — DEFINED range window

> ⚠️ THE REAL ROOT CAUSE of "the barge has a fixed range and I can't pull the
> reticle closer": **`high: 1` on every barge cannon** made the CLIENT AND BOT
> aim solve (`solvePitch(d, drop, spd, !!tier.high)`) pick the HIGH-ARC branch,
> which for any target closer than ~435 u exceeds maxPitch and CLAMPS to ~60°
> — every shot lobbed to a fixed ~435 u landing, reticle pinned there. The
> arm/maxRange window work (below) tuned the wrong layer; the fix was REMOVING
> `high: 1` from defs (low-arc solve = aim-controlled range) PLUS fixing
> `computeAimPath` in main.js (it integrated only `t < 1.6 s` — pinned the
> reticle at ~176 u with spd 110 — now integrates the shell's full `life`).
> **08-05 CORRECTION — the flag was never the bug, the CLAMP was.** The user:
> "the barge basic attack should always have an arc to it, even when shooting
> at 15 u" — the low arc at 15 u is 4.3° (flat by physics). `high: 1` is
> RESTORED on all 5 tiers with **maxPitch 1.5 (86°)** so the high-arc band
> spans the whole window: d=15 → 85.7°, d=100 → 45° — every shot lobs
> (45–86°, flight 2.9–4.1 s, life covers it). TJAB: close aim (X at 15 u)
> → barrel 85.9°, shell spawns 85.4°; far → 48°/45°.
> TJAB-verified live (scripts/tjab-verify-aim.js): shell spawn pitch −1.7°
> for a close aim (was +60° fixed), reticle X tracks the pitch (11 u close,
> 64 u at +2.9° — matches solvePitch exactly). HEADLESS CAVEAT: the TJAB
> window is 800×600 while the game reads window.innerWidth — cursor rays are
> skewed off-page; verify pitch/landing math, not screen-Y mapping, in TJAB.

### Barge basic attack — DEFINED range window (the user's explicit ask: "define the minimum and maximum basic attack range")

| | Value | Enforced by |
|---|---|---|
| **MIN** | **15 u** (`arm: 15`) | shells fly through everything (players/mines/water) until 15 u of travel — gate in `simulateProjectiles` (`q.arm` decrements by travel) |
| **MAX** | **100 u** (`maxRange: 100`, hard travel cap) | `q.travel` accumulates; detonate at the cap. Real ballistic reach at 45° ≈ **96–100 u** |

> ⚠️ **Range history: 500 → 300 → 180 → 100 u** — the user's final call: "let's do a
> range of 15–100 u" (now spd 166 + grav 276, real reach ≈ 96–100 u; the barge is a
> specialist — barely out-ranges the razorfin's ~84 u rails). Earlier stops: 500
> (flat "gun" arcs — the launch angle is θ = ½·asin(d/maxRange), the arc look is
> the RANGE FRACTION) → 300 (map-crossing on the 200×200 arena) → 180 ("shouldn't
> shoot across the map"). ALSO fixed: the client's ray-miss fallback was `d = 60`
> (a flat ~2° shot when the cursor sits above the horizon); it now defaults to
> `w1.maxRange` → a ~41° lob.

- Cannons: `spd 166, grav 276, life 8, maxPitch 1.5, splash 3.5, cd 1.1` — real reach = v²·sin(2θ)/g with
  the tier's **`grav: 276`** (barge-only; PHYS.gravity 24 stays global). DOOM MORTAR: `spd 166, grav 276, maxRange 100`.
- **History (why the numbers):** old `life×spd = 432 u` was *theoretical flat travel* — the
  shells arc and explode on the water, real reach was only ~117 u (shorter than the razorfin's
  rails!). spd went 36 → 54 (real 117) → 85 (real ~296) → **110 (real ~498 = the defined max)**
  after the user asked for a VERY WIDE window (08-04 revision: max 300→500, spd 85→110) —
  then REVERTED: spd 85 / max 300 (flat "gun" arcs at 500) → spd 66 / max 180 (map-crossing)
  → **spd 166 / grav 276 / max 100** (user: "let's do a range of 15–100 u", then flight
  time 1.2 s at 15 u → the spd/grav pair). The simtest now
  measures the **actual ballistic water-impact distance** (`✅ BARGE LONG RANGE (real ballistic
  reach)`), not life×spd. Tier descs show "range 6–300 u".
- `arm` history: 26 → 12 → 6 → 2 → 10 → **15** (FINAL). ⚠️ TERMINOLOGY: the user calls the CLOSE
  edge (arm) the "maximum basic attack range" and the far reach (maxRange) the "minimum" —
  the opposite of the code names. The 2 u value VANISHED the window ("no range window at
  all"); the close edge must be a REAL felt gap (15 u chosen: "clearly felt, mines + keeping
  distance required"). Sim: `✅ BARGE CANNON MIN WINDOW` (12 u pass-through) + `✅ BARGE
  CANNON CLOSE DEFENSE` (21 u shells land). Note: the arm tick is discrete — stationary
  targets at 16–20 u can dodge the armed tick (gray band); 21 u is deterministically hit.

### Barge special — MINE LAYER (was THUNDER SHOTGUN — 08-13 rework)

- **The shotgun is GONE** (user: "the barge bots look like they're autofiring the shotgun
  blast pellets. I've changed my mind… it should be the one canoe that can drop mines").
  The barge ability is now MINE LAYER (defs.js:132): **3 charges, 0.5 s between successive
  drops (`chargeCd`), 10 s global refill (`cd`, user: "reduce barge special main cooldown
  from 60 sec to 10 sec"), each mine dmg 45, dropped BEHIND the hull**
  (`behind: true` in the drop helper, game.js ~633–660) — the barge lays a fleeing trail.
  One press = ONE mine (a press inside the 0.5 s charge gap is blocked); when all 3 are
  spent, the refill re-grants all 3 on the next press after the 10 s cd.
- Sim locks: drop sequence **1/1/2/3/3/4** (the instant second press is charge-gap-blocked),
  charges 2/1/0/2, refill 10 s, dmg 45, behind=true. MECH PARITY: human-vs-bot spawn
  signature `mine:45` IDENTICAL; bot cadence `first special tick 32, second 331, gap
  9.97 s (cd 10 s)`. Parity traps that bit: the barge bot BACKS OFF outside the 18 u
  ability gate while moving (first-fire nondeterministic) — pin a stationary, pre-aimed bot
  against an unkillable target (hp 10000), re-pinned every tick; the projectiles array is
  REASSIGNED each tick — record spawns by PID; the bot breaks after its first spawn per
  press (`spawns.length >= 1`) to prevent multi-mine overspray.
- Bot gate: `dist < 18` (bots.js:215) — the mine layer is a blank-range/escape tool.
- HISTORICAL (superseded — kept for pattern value): the shotgun's ABSOLUTE-pitch saga
  (−0.18 rad pin; relative rakes follow the turret UP; the blast cone bracketing the rake;
  5× dedicated tier copy; 12% water skip) is a full case study in the web-game-iteration
  skill (sprays = world-absolute pitch; tracers = relative).
- **08-05: REALISTIC WATER (user: "integrate realistic waves/water instead of the low-poly
  style")**: the water was ALREADY a shader — the low-poly read was the 48×48 top-face
  tessellation over 900 u (18.75 u/cell — the 62 u primary swell = a 3-facet staircase).
  Fix: BoxGeometry top face 48 → **240** segments (fill rate unchanged, tris 4.6K → 115K),
  +2 visual-only chop octaves (±0.06/0.05 with analytic slopes), fresnel 0.95 → 0.98,
  glitter 0.6 → 0.78, uDeep #083c5e→#06324e / uShallow #35b8d8→#2f9bb0. The 4 PHYSICS
  octaves are byte-identical (ballistics waveH rides them — never change those without
  touching server game.js + client ballistics.js together). v=50. Pixel evidence:
  scripts/water-evidence.png (420×236 TJAB capture — 352 unique tones, deep→shallow
  gradient, horizon band).
- **08-04 later: FIRE AT THE LIVE AIM** (user: "the cannon asset isn't matching the pitch of
  the shot" + "needs more arc on its basic attack"): the w1 shell spawned at the server's
  CONVERGED `turretPitch` — which lags the client's prediction by one round-trip (the own
  barrel renders from `net.own().tp` — the prediction) — so every QUICK shot left flatter
  than the barrel/arc. Fixed in `fireWeapon` (game.js): the shell's velocity pitch = the
  clamped **input** `aimPitch` (muzzle POSITION stays at the physical barrel). The barrel
  (prediction, turretTurn 9 rad/s) catches the aim in ~50 ms, so barrel ≈ shell ≈ arc now.
  Sim lock: `✅ FIRE AT LIVE AIM` (turretPitch 0.1 vs input 0.5 → shell spawns at the input;
  tolerance 0.03 — one gravity tick (24/30 ≈ 0.022 rad) is applied BEFORE `q.ap` is
  recomputed in the spawn tick, plus ±0.01 jitter).
- **Lesson: snap `pr[].p` is the CURRENT flight pitch** — game.js:750 recomputes `q.ap`
  every tick (`atan2(vy, hypot(vx,vz))`) — you CANNOT read the spawn pitch from a snap
  after the fact; only the sim (or a ≤1-tick sample) sees it. The old verify scripts
  compared flight-stage values and looked "close" — misleading.
- **TJAB pitfall: the class swap needs the LOBBY phase** — server.js:171 ignores
  `{t:'class'}` mid-match, and the pilot silently stays razorfin (rails + mines — and
  the barge checks all fail mysteriously). Boot `POST /admin/reset` BEFORE the page joins
  (a leftover match from a prior probe keeps the server in 'play'), then verify
  `me.c === 'barge'` after play starts.
- **acd snap clamp**: `acd: r2(Math.max(0, p.abilityCd))` — cooldowns decrement raw
  (game.js:265, no zero-clamp), so the snap used to send NEGATIVE cds; the E2E rmb check
  now polls up to 2 s (a rAF stall can delay the 30 Hz input send past a single sample).
- **Sound bug (user: "sounds like a faded machine gun constantly going off"): my own-
  projectile fire-sound loop CLEARED its seen-set at 128 — every live shell id re-armed,
  and the 90 ms rate gate ticked forever while any shell was in flight (the barge's 3–4 s
  flights = never silent). FIX: prune by keeping ONLY the max id (ids are monotonic — new
  shells always exceed the floor): `ownProjSeen = new Set([Math.max(...ownProjSeen)])` at
  > 4096 entries. Fire sounds now play exactly once per own shot.
- **Machine gun STILL present → the SPLASH sound was the other half**: `SND.splash()` ran
  UNCONDITIONALLY for every splash fx — the bots' skimming rails/gatlings splash ~6×/s and
  every client played every splash (the boom was already d<48-gated). FIX: splash sound
  gated to d < 30 u.
- **Flight times (user: "make 15 u be 1.2 s, reduce from there proportionally"): barge
  tiers spd/grav **166/276** (was 100/100, 69.3/48, 49). Trajectories UNCHANGED
  (angles/peaks are pure functions of v²/g ≈ 100) — flight time = 2·v·sinθ/g ∝ 1/√g, so
  the whole window lands in **0.85–1.2 s**: close lob 2.00 → **1.20 s** (sim lock), max
  shot 1.41 → 0.85 s. With grav 276 the one-tick gravity bend is ~0.055 rad — the sim's
  FIRE-AT-LIVE-AIM tolerance scales with it (0.07). NOTE: the maxRange cap accumulates
  HORIZONTAL distance only (hypot(vx,vz)) — near-vertical lobs crawl horizontally, so the
  cap never binds for them; the water claims the shell. ALSO: the water-explode path
  never sets `q.dead` (the shell is just dropped from the array) — sim death checks must
  use `!projectiles.includes(q)`.
- **Per-tier gravity mirror rule**: EVERY solvePitch call site must pass the tier's grav
  (client solve, computeAimPath, bots.js, simtest combat) — the sim combat block solved
  with PHYS.gravity 24 while the shells fell at 48 → every shot landed at half range
  (0 hits, `SIM COMBAT BROKEN`).
- **Bot special spam (historical, pre-mine-layer):** the barge bot's ability gate was
  `dist < 95` — the old shotgun's REAL reach was ~15 u — constant special spam + blast
  sounds. FIX: gate to `dist < 18` (blank-range defense only; still the mine layer's gate).
  Lesson: bot ability gates must match the ability's ACTUAL reach, not the weapon-window
  numbers.
- **Bot SECONDARY spam (user: "enemy barge keeps shooting its secondary constantly in a
  straight line with really long range — not like the player secondary at all"): the bot
  fire2 gate was `dist < D.fire2Dist` with med=80 / high=100 — the chug's 'shot' pellets
  SKIP flat across the water for 40–90 u, so med/high barge bots streamed their close-range
  chug across the arena (and upgraded w2s = Harpoon, reach 104 u). FIX: fire2Dist 80→30,
  100→35 (low stays 25) — the gate matches the SECONDARY's real envelope, not the
  difficulty table.
- **MECHANICS/Difficulty split (user: "separate bot difficulty and mechanics — mechanics
  should always stay the same; only aim and maneuverability change with difficulty"):
  bots.js now has `MECH` (fire2Dist 30, abilityChance 0.4, fireChance 1 — constant) vs
  `DIFFS` (aim: thinkT/noise/leadMul/fireGate/whiff/missOffset; maneuverability:
  steerDead/rangeMul/strafeT/boostChance/flee — per difficulty). A low bot fires its
  special at the same cadence as a high bot — it just misses. Ladder still holds in sim
  (low 96 < med 312 < high 1320).
- **Sound-system fix ("game sounds not rendering correctly"): `SND.fire` was DEAD CODE —
  zero callers, every gun was silent.** Wired it: the client plays `SND.fire(q.k)` once per
  NEW own projectile id in the snap (rate-gated 90 ms so a pellet volley bangs once) at
  main.js's projectile sync. (The shotgun 'blast' fx + its `SND.blast()` died with the
  ability; the wiring lesson — per-entity sounds need a seen-id set AND distance gates —
  stands.)

### Collision — "canoes trip on assets, won't drive straight" → SLIDE, not trip

- **Root cause found:** rocks/isles were pushed by TWO conflicting systems every tick
  (`collideTerrain` axis-push + a second `aabbPush` pass) — bleeding 40% speed/frame while
  grazing, rattling at corners (axis flip), and the walls reverse-bounced at 0.35 against the
  drive. That *was* the "lagging/stuttering" feel — perf.log showed steady 60 fps.
- **Fix:** ONE normal-based terrain pass (kills only the INTO-obstacle velocity component —
  the canoe slides at full speed), walls kill only the inward component. Sim:
  `✅ CANOE SLIDES AROUND TERRAIN` (13.1 u/s after grazing a rock).

## 3. Performance state

- **perf.log pipeline is LIVE and verified** (repo root): client `reportPerf` every 10 s
  during play → server `case 'perf'` appends one line (fps/draws/tris/parts/tex/mem/ps/projs).
  Two historical bugs fixed: the case used `m` instead of `msg` (ReferenceError swallowed by
  an empty catch) and the reporter gated on stale UI `state.phase` (now reads the snap's
  `ph` directly). Sample: `[04:09:59] phase=lobby fps=60 … ps=7 projs=3`.
- **User-session data shows fps 60 / mem stable** — the renderer is fine; the perceived
  choppiness was the collision trips + the TJAB ring tax (below).
- **TJAB bridge ring buffer is DISABLED** (`ringBuffer: { frames: 0 }` in render.js attach).
  The ring re-rendered the scene + JPEG-encoded every ~66 ms in EVERY page — a real stutter
  source in the user's browser AND the cause of the E2E input flakes. The bridge now honors
  `frames: 0` (patch in `C:\Users\Scott\tjab\packages\bridge\tjab-bridge.js` — **keep the
  `public/vendor/tjab-bridge.js` copy in sync when patching the tjab repo**).
- Known leaks already fixed + regression-guarded: killfeed `splice(0)` per snap; per-hit
  damage-number textures cached (Map) + disposed (E2E asserts < 120 live).
- Next: have the user playtest, read perf.log, hunt late-match growth.

## 4. Operations

### Server (Windows, git-bash)

```bash
# restart :3000 (kill ONLY the :3000 listener — NEVER taskkill hermes.exe!)
PID=$(netstat -ano | grep ':3000.*LISTENING' | awk '{print $5}' | head -1)
if [ -n "$PID" ]; then taskkill -f -pid $PID; fi
sleep 0.5
(ALLOW_ADMIN=1 node server/server.js > /tmp/canoe.log 2>&1 &)
```

- **⚠️ NEVER `taskkill -f -im hermes.exe`** — case-insensitive, kills the desktop app AND
  the orchestrator server. Kill by PID only (see memory: wmic/ExecutablePath filter).
- ⚠️ Duplicate `node server/server.js` listeners have appeared twice (leaked test servers) —
  check `wmic process where "name='node.exe'" get ProcessId,CommandLine` when behavior is odd.
- The server silently died twice historically — if the user reports "no changes" or dead
  matches, check `/tmp/canoe.log` and probe `curl -s localhost:3000` FIRST (ECONNREFUSED has
  masqueraded as "your changes don't work").
- `launch.bat` / `start.bat` = run server; `shutdown.bat` = by-port PID kill.

### Cache-buster

Every client change → bump **?v=NEXT** in `public/index.html` (1 tag — main.js only; the
server's `readCached` revalidates unversioned module imports by mtime, so edits to
render.js/ocean.js/ui.js/style.css are served fresh without a bump) AND restart the
server. No service worker exists; hard refresh alone isn't enough when the tag is stale.

### Tests

```bash
cd /c/Users/Scott/canoe-battler && timeout 340 npm test
# quick grep: "✅ ALL|💥|❌|zero JS|E2E PASS"
```

- Sim (`scripts/simtest.js`, **28 locks**) + E2E (`scripts/e2e.js`, ~82 checks in real
  Chrome: join→launch→play, HUD, shop-disabled check, scoreboard, killfeed, damage spots ON the hull,
  health bars, texture bound, drive-straight, terrain-graze parity, 0 JS errors). Exit 0 =
  everything green.
- **Test discipline (user-mandated):** never re-run a green suite on unchanged bytes; one
  fresh run after each change set. The user pre-approved iterative testing for the
  barge/perf workstream.
- E2E gameplay checks are **alive-gated + retried** (an idle pilot dies to bots — that was
  the flake source: jump/right-click/scoreboard/damage checks). The pilot holds W + LMB.
- `scripts/simtest.js` SIM COMBAT gotchas: **A = razorfin, B = barge** (the speeds were
  swapped once — the rails fired at the barge's pitch); solve pitches for the **water level**
  (`-PHYS.muzzleY`), not the hull center (the center sits below the waterline trajectory —
  shells explode short and splash-less rails miss); set `turretPitch` directly (convergence
  is slow).

## 5. TJAB (Three.js Agent Bridge) — self-validation tooling

- Spec: `TJAB.md` (repo root). Impl: `C:\Users\Scott\tjab` (its own gates: `npm run gates`).
- Integrated Mode A: `public/vendor/tjab-bridge.js` + script tag + `window.TJAB.attach(
  renderer, scene, camera, { three: THREE, ringBuffer: { frames: 0 } })` in render.js.
- Start the TJAB server (separate from the game server):
  `cd /c/Users/Scott/tjab && TJAB_HEADFUL=0 node packages/server/index.js > /tmp/tjab-server.log 2>&1 &`
  → `127.0.0.1:4701`.
- RPC: `POST http://127.0.0.1:4701/rpc` JSON-RPC 2.0. Key methods: `session.new {url}`,
  `eval.js {session, code}`, `_info`, `scene.graph`, `inputDrag`/`inputClick`
  (`button:'right'` = REAL CDP right-click that drives the page's own input loop).
- **eval.js code is a `new Function` body — queries MUST include explicit `return (…);`**
  (bare `2+3` returns undefined). Helper: `node scripts/tjab-rpc.js <method> <json> <session>`.
- Gotchas: the TJAB server crashed once after an attach (restart it); stale browser sessions
  keep their WS open and can hold the lobby as an AFK host ("WAITING FOR HOST…") — close ALL
  sessions and restart the canoe server for a clean lobby; the headless Chromium lacks the
  E2E's WebGL launch flags but scene/eval still work.
- Snapshot timing: `eval.js` RPCs take ~0.5 s round-trip — pellet-life (0.4 s) sampling from
  outside misses; prefer deterministic simtests for timing-sensitive assertions (the
  absPitch + range tests live in simtest.js).

## 6. Balance values (current, all in server/defs.js)

- Barge: hp 250, spd 8.6, boostMul 1.7, ramMul 1.5, cannons 15–100 u, dmg ×2.5 (08-05:
  20/20/22/26/72 → **50/50/55/65/180** — the DOOM MORTAR one-shots razorfin/rocket),
  chug gun → harpoon, MINE LAYER special (3 charges / 0.5 s / 10 s refill / dmg 45).
- **08-05: three UI/fix items** — (1) lob speed at 100 u → **0.5 s**: spd/grav 166/276 →
  **282.8/800** (v²/g ≈ 100, arcs unchanged; t(15) = 0.71 s; sim flight lock now 0.5–0.9 s;
  fire-live tolerance 0.11 — the one-tick bend is 800·0.0333/282.8 = 0.094 rad). (2) BOOST
  CD ANIMATION: `btnBoost` was MISSING from the ui.js el map — the whole boost cooldown
  block (`if (el.btnBoost)`) never ran; the overlay was dead. Added the entry — the boost
  now sweeps like the ability (transparent during the boost itself, conic sweep + countdown
  after). (3) BOT COUNT: the `host` message was host-gated; a stale auto-reconnected tab
  holds the host slot and silently ate the user's +/- clicks. `bots` is now settable by ANY
  human (mode/map/diff stay host-only).
- **08-05: PICKUPS REDONE (user: "remove all pickups aside from shields; add a weapon
  upgrade pickup floating at the top of one of the three boost ramps — take the ramp and
  jump to get it")** — (1) the heal/credits/overclock CRATES are gone (simulateCrates only
  drains now; the bots' economy rides on the credit trickle + kill credits). (2) NEW
  `upgradePickup`: spawns at a random boostZone's center at `y = zone.h + 2.7` (4.0 u on
  lagoon) — the 3D grab (`|p.y - up.y| < 1.4` + 2.2 u horizontal) means ONLY the ramp ride
  + jump reaches it (water hops peak ~2.4 u; pad + hop peaks ~3.2-4.2 u). Grants `+1
  upg1` (killUpMax-capped — the same as a kill) and respawns after 15-25 s at a
  RE-ROLLED ramp. Snap field `up`; the client renders a bobbing golden octahedron gem
  with a pulsing light BEACON column (render.js syncUpgradePickup — the gem WAS
  rendering (TJAB-verified: mesh visible at the ramp); the beacon makes it unmissable
  and doubles as the aim hint); SND.pickup('upgrade') = rising 3-tone chime. Sim lock:
  `✅ UPGRADE PICKUP (ramp-top float, ramp+jump only, respawns)`.
- **08-05: REALISTIC WATER — FULL FFT OCEAN (user: "everything incl. the FFT ocean")**: the
  sea is now a Tessendorf-style pipeline (public/js/ocean.js — spectrum → phase → 2D FFT →
  normals/foam), sampled by the water material (render.js WATER_VERT_F/FRAG_F) over the
  900 u tile, PLUS a procedural sky dome (gradient + sun disc + drifting clouds — the
  water's fresnel mixes its reflection) and a scene-reflection pass (mirrored camera at
  half-res, layer-1 water, y≥0 clip). The boats STILL ride the analytic waveH (server
  physics untouched — the FFT is visual-only; the sim is byte-identical). Knobs: ocean.js
  amp 12 / wind 9 / tile 900; render.js uHeight 1.0 / uChoppy 0.5; the reflection
  strength is the fresnel×0.95 in WATER_FRAG_F. Verification: `scripts/tjab-verify-ocean.js`
  (readback stats: mean~0, corr1>0.5 — smoothness, motion). **FFT PITFALLS PAID IN BLOOD**:
  (1) `input` and `half` are RESERVED words in the three.js WebGL2 shader pipeline —
  uniforms named that fail to compile SILENTLY (the pass renders the clear color);
  (2) GLSL vec2×vec2 is COMPONENT-WISE, never complex multiplication — the twiddle must
  be written out (tw.x·b.x − tw.y·b.y, …) — the stage-0 twiddle (1,0) masks it (the
  first stage verifies clean, every later stage is wrong); (3) the bit-reversed-TWIDDLE
  DIT is WRONG — the input bit-reversal PERMUTATION pass + plain twiddles is the correct
  no-permutation form (the N=4 hand-check passed because the 1-bit reversal is the
  identity); (4) verify an FFT against an ANALYTIC impulse (a CPU reference with a
  transposed column index gives plausible-looking smooth noise — the transpose bug hid
  in THREE separate CPU references before the analytic check caught it).
- **08-09: WHITE-SCENE FIX (user: \"the entire scene renders white\") — the shore-foam
  `uIsles[12]` array uniform was fed a 10-entry JS array** (lagoon = 1 isle + 9 rocks;
  cove = 12): three.js uploads vec4 arrays over the GLSL-DECLARED size, so the
  uploader read `undefined.toArray()` and THREW mid-frame inside the water draw —
  every frame died right after the sky dome (draw calls pinned at 1), the water never
  drew, and the whole scene was pale sky = \"white\". The game logic kept running (the
  rAF loop re-schedules BEFORE game.render) so the E2E stayed green — the crash code
  had also landed after the last green run. FIX in render.js buildArena: pad the array
  to the declared length (`while (uIsles.value.length < 12) push(Vector4(0,0,0,0))`;
  uIsleCount still guards the GLSL loop). RULE: every vec4/vec2 array uniform must be
  padded to its GLSL-declared size — count obstacle totals per map before sizing.
  VERIFIED VISUALLY (the user demanded it): `__dbg.game.sample(6)` pixel grid + 
  `stats()` — draws 1 → 106, tris 235k, glErr 0, rich gradient (deep teal → horizon);
  screenshot shots/shot_*.png decodes to 2,905 unique tones incl. hull colors.
  **E2E now carries a permanent RENDERER-ALIVE guard** (draws > 2 && non-flat pixels
  right after entering play) so a dead scene can never pass the suite again. v=52.
- **08-09: WATER REALISM PASS (user: \"the water in those screenshots is unacceptable — not realistic at all\")** — the v=54 sea read as smooth blue-painted plane + foam sheet (FFT swells are λ40–150 u = invisible 1–4° slopes; Jacobian foam averaged 0.31 with 31% > 0.5). v=55 (render.js WATER_VERT_F/WATER_FRAG_F + ocean.js NORMAL_FS): (1) **visible wave geometry** — 7 analytic chop octaves (λ5–52 u, ±0.45 max) layered on the FFT field in the vertex shader, with the SAME analytic slopes passed as vSlope into the fragment normal (ripples catch the light; boats still ride waveH ±1.28 — chop is small-amplitude detail); (2) **reflection-driven shading** — dark body uDeep #0b3447 / uShallow #1e7f96, fres pow-3, sky reflection (mirror pass) up to 0.96 at grazing, dist absorption 0.0018, NO flat ambient lift; (3) **sun path** — sharp glitter `pow(dot(reflect(-view,n),uSunDir),64)*0.9` capped 0.7 + spec pow-256 capped 0.85; (4) **sparse whitecaps** — Jacobian foam power-curved `pow(1-jac, 2.5)` (measured: avg 0.11, 11% > 0.5) + slope-foam on chop ridges `smoothstep(0.17,0.27,slope)*0.7`; uChoppy 0.55. **GLSL lesson: the FFT vertex shader previously never needed the clock (time lives in the phase texture) — adding uTime usage WITHOUT declaring `uniform float uTime` silently killed the water draw (compile error, sky-only frame; TJAB capture "succeeded" with 348 tones of pure horizon)** — probe-shader.js (playwright + console capture) surfaces THREE.WebGLProgram errors the PNG grid can't. Measured via tjab-foam-stat.js (normalRT alpha readback). Verified: probe-shader zero errors, foam stats, dual-orientation captures. v=55.
- **08-09: COLLISION PROTECTION (user: "canoes get off balance and don't drive correctly during collision — we need collision protection")** — v=60: the drive model converges velocity toward `ang`, but `ang` only changed via steering, so a solid hit killed the into-component and the drive then pulled velocity BACK into the obstacle — the crab-walk (measured grind: div 1.06 rad at contact, ~6-tick crab window, exit on the old heading). FIX — `collideSlide(p, nx, nz)` in game.js: kill the into-component (existing behavior) + ease `ang` toward the actual slide direction (35%/tick when |div| > 0.2, spd > 1.5) + arm a **0.5 s collision-recovery window** (`p.collideT`) that keeps aligning after contact ends (an event-only snap can't finish a full reversal while a rammed pair drifts apart below the snap threshold). Wired into ALL FOUR sites: collideTerrain, aabbPush (skyisles — its old blind `vx *= 0.6` damping replaced), the four walls, and ramCheck. **ramCheck impulse sign bug fixed**: the mass-weighted exchange used `a -= relv·am; b += relv·bm` — DIVERGENT (head-on rams accelerated BOTH hulls into each other every tick = the rubbing jitter); now `a += relv·am·1.15; b -= relv·bm·1.15` (symmetric averaging, slightly elastic so head-on rams reverse and separate). KNOWN QUIRK: ram damage still gates on `relSpd > 4.5` — head-on rams (relSpd −27) deal no ram damage; chase rams do (pre-existing, untouched). Client prediction mirrored in net.js (same snap + recovery + kill-into walls — it still had the ancient 0.35 wall bounce). Sim locks (23/23): COLLISION PROTECTION (grind: maxDiv < 0.8, headingTurned > 0.15, endDiv < 0.15), WALL GRIND REDIRECTS (alongWall < 0.3), BOAT RAM SEPARATES + ALIGNS (endDiv < 0.3, endDist > 3.5 — boats in the CLEAR LANE z=-40; the central island at (0,0) polluted the first attempt). Probe: scripts/probe-collision.js (per-tick grind trace), scripts/probe-ram.js. v=60.
- **08-13: DRIFT HARDENING + BULLET-STORM PERF (user: "still times when drifting that the orientation changes and it no longer drives straight" + "optimizations to reduce lag when lots of bullets are in the air — there should never be any lag, graphic or latency wise")** — probed FIRST (scripts/probe-drift.js): (1) **DRIFT-WALL: a COASTING hull touching a wall obliquely got its bow eased 45.7° off course** — the heading ease fired without forward throttle, so the ship then drove the rotated direction = the user's exact report (open-water drift + knockback-during-drift measured 0.0° — those were already clean). FIX: the collideSlide heading ease AND the 0.5 s recovery window are now GATED on `p.input.up` (driving intent) server + client — a drifting hull keeps its orientation; the velocity kill still slides it. Driving-into-obstacle redirect (v=60 behavior) unchanged — all driving locks stay green. BOAT RAM lock contract updated to the drift rule: coasting rams keep their bows (bow drift < 0.04 rad) + separate (endDist > 3.5) + re-straighten on throttle (endDiv < 0.3); both-driving face-to-face grinding at minD is two players holding W at each other, not the contract. (2) **client mirror spdP ReferenceError**: the last session's ease-removal left the recovery window referencing an undefined `spdP` — a per-frame crash for 0.5 s after every contact (prediction frozen mid-crash → hard snaps). Fixed by the window rewrite. (3) **ang divergence through grazes: 1.68 rad** — the E2E graze gained an ang-parity assertion and immediately caught it: the predicted heading reconciled ONLY on the 6 u hard snap (position blends, ang never did) and the client eased at 35%/FRAME vs the server's 35%/TICK. Fixes: soft ANG RECONCILIATION (`reconcile`: |dA| > 0.6 → snap, else blend 0.3 — mirrors the position blend) + continuous-time ease rate `easeK = 1 − 0.65^(30·dt)` at all three client ease sites. Graze check now: pos err < 5 u AND ang err < 0.35 rad (measured 0.138). (4) **BULLET-STORM PERF (the lag ask)**: syncProjectiles allocated `new THREE.Vector3(0,0,1)` PER SHELL PER FRAME (dozens of shells = GC hitches on any machine) → shared `_zAxis` temp; every splash/boom/muzzle created a fresh BoxGeometry PER EVENT (a GPU attribute upload per hit during storms) → two shared unit geometries (FX_UNIT_GEO 1,1,1 / FX_RING_GEO 1,0.12,1) scaled per instance, and the fx-expiry path no longer disposes geometry (shared — live forever); each boom spawned its own PointLight → concurrent booms crossed three.js's light-count recompile thresholds (0/1/2/4/8…) = shader recompile hitches mid-fight → capped at 3 concurrent boom lights (BOOM_LIGHT_MAX, counter decremented on expiry). Locks: sim +1 (26 total) DRIFT KEEPS ORIENTATION (coasting wall contact: ang change < 2°, slide speed survives > 2 u/s); E2E graze +ang-parity. v=63.
- **08-09: LARGER WAVES THAT AFFECT MOVEMENT (user: \"too reflective, not chaotic enough, there should be larger waves that affect movement\")** — v=56: the SHARED ride field `waveH()` (server/game.js + public/js/ballistics.js, byte-identical — verify with the regex-diff one-liner) grew from 4 octaves ±1.28 to **6 octaves ±2.8 max / RMS ~0.9** (new λ140 u swell 0.8×0.9 + λ114 u cross 0.65×0.9, existing octaves scaled up) — boats now heave ±2.8 u and hull tilt (render.js:1340 waveH gradients) rocks hard. FFT amp 12→22 (visual crests ±2.57 ≈ ride). Chaos: 4 more chop octaves (λ5-8 u, +0.21 max) in WATER_VERT_F; micro-normal blend 0.35→0.5. Reflection cut: `clamp(rfres*0.7, 0, 0.62)` (was 0.96). Foam gate (0.18, 0.30) + Jacobian pow 2.5 (re-measured avg 0.19, 17% > 0.5). The analytic FALLBACK shader's shared octaves updated to the new waveH too. **E2E JUMP CHECK IS NOW WAVE-RELATIVE** (`y - __dbg.waveH(x,z)`, exposed on the debug surface): the ±2.8 u swells move the water >1 u/s and swallowed the old +0.7 absolute-rise assertion (rest 0.61 → max 0.61 = hull jumping INSIDE a falling wave) — the relative assertion measured a clean −0.66 → +1.22 jump. Rule: any \"leaves the water / height\" E2E assertion on a wave-ride game must measure against the wave surface, not a fixed baseline. v=57.
- **08-09: GRID-LOOK FIX (user: \"I do not like how the water looks like a grid\")** — v=58: the grid was sub-cell geometry + Nearest-filtered FFT texels + ultra-sharp sun terms. Fixes in render.js/ocean.js: (1) REMOVED all 8 ripple chop octaves (λ5-10 u at 3.75 u/cell = 1.4-2.7 segments/wave = pure faceting) — vertex chop now carries only the 3 MID octaves (λ22-52 u, ≥6 segments); (2) dispRT/dispZRT/normalRT switched to **LinearFilter** (`floatRT(w,h,linear=true)`) — the Nearest-sampled displacement was a blocky staircase even where the field was smooth (texels 3.5 u vs cells 3.75 u); pipeline RTs (spectrum/phase/fft) stay Nearest — bilinear interpolation corrupts FFT stages; (3) fine chaos moved to the FRAGMENT: flow-normal fuv 0.09→0.13 + blend 0.5→0.75 (per-pixel detail cannot grid); (4) sun softened: glitter pow 64→48, spec pow 256→180; (5) mesh 240→288 segments (900 u → 3.13 u cells, 337k tris — E2E green on SwiftShader). Rule: vertex waves need ≥4-6 mesh segments per wavelength — anything shorter belongs in fragment normals, and render-facing float RTs get LinearFilter while FFT-pipeline RTs keep Nearest. Pixel signature of the grid: harsh alternating dark/bright cells in the 8×8 dump (v=56) vs smooth gradients (v=58). v=58.
- **08-09: REFLECTION SUBDUED (user: \"water is still too reflective — I can see the boundary and floating assets reflecting, even some canoes\")** — v=59: (1) **boundary assets excluded from the mirror pass via layers**: after buildArena, `arenaGroup.traverse` tags every object whose parent-chain position exceeds 94 u (corner towers, bleachers, crowd pixels, boundary buoys, cloud groups) with `layers.set(2)`; `camera.layers.enable(2)` keeps them visible to the main camera while the mirror camera (layer 0) skips them — verified 293 meshes layer-2, only the sun disc (desired) remains a far layer-0 mesh. Sky dome, sun, islands, rocks, ramps, canoes still reflect; (2) reflection strength halved: `clamp(rfres*0.45, 0, 0.4)` (was 0.7/0.62); (3) **wave-normal UV distortion** `ruv += n.xz*0.02` — near-object reflections break into dim smears (rough sea, never crisp mirror). The E2E's renderer-alive guard covers the changed material. Probe scripts: tjab-layers.js (layer audit), tjab-find-straggler.js. v=59.
- **08-13: BARGE → MINE LAYER (user: "the barge bots look like they're autofiring the
  shotgun blast pellets… I think it should be the one canoe that can drop mines")** — the
  THUNDER SHOTGUN is REMOVED; the barge special is MINE LAYER (defs.js:132): 3 charges,
  0.5 s between successive drops, 10 s refill re-grants all 3 (user later: "reduce barge
  special main cooldown from 60 sec to 10 sec"), each mine dmg 45, dropped
  BEHIND the hull — a fleeing trail. Sim locks: drop sequence 1/1/2/3/3/4, charges
  2/1/0/2, refill 10 s; MECH PARITY human/bot `mine:45` identical; bot cadence gap
  9.97 s on a 10 s cd. See section 2 for the parity-test pinning traps.
- **08-13: COLLECTIBLE PLACEMENT (user: "some are positioned too close together… the ramp
  upgrade collectible isn't placed logically")** — `sanitizePickups` (game.js ~1014)
  rewritten as ACCEPT-ONLY rejection sampling: pickups ≥ **26 u** apart, ≥ **8 u** clear of
  every rock/island face, outside every ramp pad footprint (+3 u), 80 tries within the
  ±82 u ring (the old spiral-nudge could exhaust its tries STILL violating — the spacing
  lock caught it). The upgrade gem floats **3 u PAST the ramp's exit edge** on the dir
  axis at `y = pad.h + 1.2` (≈2.5) — the MEASURED boosted-flight path (barge apex ≈2.6 u;
  the earlier y 4.3 was provably unreachable — the old positional lock never flew the
  trajectory). Riding the ramp snags it mid-flight. Sim locks: `✅ LAGOON/COVE
  COLLECTIBLE SPACING` + `✅ UPGRADE PICKUP (drives the ramp, flight grab)`. **TRAP:
  `new Game('ffa', mapId)` IGNORES the map arg** (the constructor takes none) —
  `gd.mapId = mapId` must be set explicitly or the spacing lock tests lagoon twice and
  passes vacuously.
- **08-13: MENU/UI NORMALIZATION + AA TRANSITIONS (user: "I do not like the way we
  currently transition from play to lobby screens, it needs a AA game vibe")** — a full-
  screen `#veil` fade (z-index 90, 0.38 s) covers every screen change: end→lobby,
  pause→title, lobby→battle. One `ui.transition(fn)` helper swaps the UI underneath the
  fade with a veilBusy guard + try/catch so the swap is never dropped. Panels enter with a
  fade+rise animation, buttons normalized (padding 7px 16px, letter-spacing, unified
  transition list, `:focus-visible` outline). All E2E ids kept stable. One regression run
  (run53) — the veil timing is the user's eyes to judge.
- **08-13: PRODUCT-WIDE OPTIMIZATION (user: "do an optimization pass… across my requests")
  ** — (1) FFT ocean + reflection re-render decimated to every other frame (phase evolution
  h·e^{iωt} is an exact function of time — mathematically lossless); (2) ws
  `perMessageDeflate {threshold:512}` (~70 → ~15 KB/s/client); (3) HUD dirty-check (DOM
  writes only on change; conic cooldown sweeps quantized to 0.1 steps); (4) cosmetics dirty
  flag (`cs` sent once, client persists per player in a Map); (5) auto quality tier — EMA
  frame time > 30 ms → one-way degrade to lo (FFT N 256→128, reflection quarter-res, water
  288→192 segs, DPR 1.0), `setQuality()` + `ql` in stats()/perf.log. E2E synergy:
  SwiftShader degrades mid-suite and the renderer-alive guard proves the lo tier renders.
- **08-13 (round 2): SHAKE / ASSISTS / BOT FEEL / PICKUP / CD — six user fixes:**
  (1) **SHAKE** — screen shake fires ONLY when the player TAKES damage (`f.v === myId`),
  scaled by the fx's damage field (`shake(min(0.3, 0.08 + d*0.0022))`, camera accumulator
  cap 1.2 → 0.45); removed: boom-proximity shake, attacker-hit shake (0.12), kill-credit
  shake (0.3). (2) **ASSISTS** — dmgDone now records damage BEFORE shield absorption
  (chewing a shield counts) and assists are granted POSTHUMOUSLY (no `p.alive` gate);
  assist killfeed entries no longer play the kill sound. New `✅ ASSISTS` sim lock.
  (3) **BOT AIM-REACTION REMOVED** — the periodic strafe-flip jinks are gone (bots hold a
  steady orbit); the jinks read as "reacting to me aiming at them". (4) **PELLET LINE** —
  the barge bot's full-auto chug (cd 0.16) read as "spraying a line of pellets": bot fire2
  is now BURST-gated (0.35–0.65 s bursts, 0.7–1.6 s pauses; weapon/envelope/in-burst
  cadence unchanged). (5) **UPGRADE PICKUP** — re-placed 3 u past the ramp exit at
  y ≈ 2.5 (measured flight path; old y 4.3 unreachable — flight apex ~2.6) + ramp launch
  arc raised (`vy = min(13.5, 7.5 + 0.18·spd)`); the sim lock now DRIVES the ramp.
  (6) **MINE LAYER CD 60 → 10 s**. Full suite green (run54). ?v=66.
- **08-13 (round 3): SHOP DISABLED (user: "disable all shop features and any upgrades
  purchased through the shop")** — after "enemy bots shoot multiple projectiles every
  shot" (they were BUYING multi-barrel w1 tiers: Twin Boom ×2, Broadside ×3, Twin/Triple
  rails ×2–3 via the same tryBuy shop as players): `PHYS.shopDisabled = true` (defs.js) →
  one gate at the top of `game.tryBuy` (`{ ok:false, why:'shop-disabled' }`), a
  `bots.js` tryBuy guard (bots stay tier 0 — no multi-barrel volleys), the HUD SHOP
  button removed, the B key inert (`SHOP_DISABLED` const in ui.js). KILL-GRANTED
  upgrades (kill = +1 weapon level, 2 assists = +1) and the ramp pickup STAY ON — they
  are free progression, not shop purchases. Sim lock `✅ SHOP DISABLED`; E2E now asserts
  B does not open the shop + the button is gone. Water round: reflection clamp
  0.45/0.4 → 0.22/0.18 + distortion 0.06, then chaos rolled back and wave MAGNITUDE
  raised instead (waveH ×1.125 → max ±3.5 SHARED server/client/fallback-shader; FFT amp
  22→30; chop amps ×1.2). The L10 kill-upgrade hot-pink "overdrive core" cube was REMOVED
  (user: "the giant pink cube needs to go away" — the ring + fins stay). Full suite green
  (run58). ?v=70.
- **08-13 (round 4): ONLINE-MULTIPLAYER-PREP LOBBY (user: "prepare for online
  multiplayer… true title screen… host panel… canoe cards with gun previews… lobby
  chat… style drawer… sound pass")** — (1) **TITLE SCREEN**: CREATE LOBBY / JOIN LOBBY /
  PRACTICE / SHOP (disabled, "COMING SOON"); joining any way lands in the LOBBY VIEW
  (name/lvl/XP moved to the title). (2) **HOST-ONLY LEFT PANEL** (collapsible `#hostPanel`):
  mode/map/ADD BOTS? Yes-No/±count/difficulty — the bots toggle is `game.botsOn` +
  `setBotsOn()` (No removes bots, fillBots respects it); server gates all host fields
  now. `kind` ('create'|'join'|'practice') rides the join message + joinArgs (reconnects
  keep it); practice sets `game.practice` (PRACTICE banner). (3) **CANOE CARDS**: real
  gun image per card (`game.canoeImage(def, 0)` — one shared cardRenderer, sequential
  render + dataURL) + hover popup `#previewPop` playing a live 1.6 s loop
  (`game.classClipFrame(def, t, canvas)` — recoil dip + muzzle flash + arcing shell). (4)
  **LOBBY CHAT** (right, collapsible): `{t:'chat'}` → `game.chatMsg` (cap 50) →
  broadcast; history rides `lobbyInfo().chat`; cleared ONLY on lobby close (last human
  leaves / admin reset) — play-again (end → lobby) keeps it. Client routing needed a
  `case 'chat'` in net.js's handle() (the classic missing-route drop). (5) **STYLE
  DRAWER** (bottom, collapsible, replaces the STYLE tab): paint/figurehead/flag/wake —
  wake trails are NOW wired (wake foam tints by `cosmetics.trail` via TRAIL_COLORS; the
  other three were already rendering); locked items show "level N" tooltips. (6)
  **SOUNDS**: 7 new bites (chat/send/join/leave/select/hover/unlock) on top of the full
  existing set. **PITFALL HIT: removing the `.tabs` row left `el.menuTabs` null and
  `switchTab` threw, silently aborting `leaveMatch` mid-transition (net.leave() never
  ran → no reconnect → menu never reappeared); the E2E return-to-title check caught it.
  Guard every removed-element reference.** E2E grew: title buttons, shop-disabled,
  gun images + hover clip, chat roundtrip, host-panel gating (hidden non-host, visible
  after solo rejoin), bots Yes/No toggle, style drawer + tooltip. Full suite green
  (run60, 82 checks). **Follow-up (user: "absolutely terrible — one giant window mashed
  together"): the lobby windows are now DOCKED to the screen edges, each collapsing to a
  visible LABELED tab** — `#hostPanel` docks LEFT (host only), `#chatPanel` docks RIGHT,
  `#styleDock` docks BOTTOM; collapsed = body hidden, tab pinned to the edge with its
  label (side tabs go vertical via writing-mode). The style dock STARTS collapsed
  (expanded it covered the center panel's buttons — playwright caught the click
  interception on `#botsOnNo`). Dock body max-height 38vh. Center keeps only the canoe
  picker + crew + launch. E2E: collapse/expand + label assertions for all three docks
  (run62, 86 checks). **Follow-up 2 (user sketch: "tabs that expand into full EXTENSIONS
  of the main lobby window… start collapsed… click the tab text")**: the docks are no
  longer viewport-pinned — `#menuRow` flex attaches them to the main window: host dock
  left, chat dock right, style dock directly beneath the panel (`#menuCol`), 6 u gaps,
  and ALL THREE start collapsed (labeled tabs only). Clicking the tab text toggles the
  extension. E2E re-sequenced: every dock asserts starts-collapsed → expands → collapses
  (run63, 88 checks). **Follow-up 3 (user: "style window normalization… Game Settings tab
  text upside-down… remove ALL emoji from tabs/buttons… canoe cards = card-shaped weapon
  picture + name only… preview video not working")** — (1) style window restyled to the
  lobby/settings theme (bordered navy tiles, gold sel ring, no lock emoji; paints/flags/
  trails = color tiles, figureheads = initial tiles); (2) collapsed tab text flipped via
  `text-orientation: upright` (mixed rendered Latin sideways); (3) EVERY emoji stripped
  from tab labels, title buttons, START MATCH, MUTE/SCORES, mode/map buttons, crew rows
  (E2E asserts an emoji-free regex over all of them); (4) canoe cards = `.cc-card` weapon
  picture (`game.weaponImage` — gun-only close-up render, shared cardRenderer) + name, no
  swatch/icon/color-block; (5) **PREVIEW VIDEO FIX — real bug**: `classClipFrame` rendered
  into the cardRenderer's PRIVATE canvas and only used the popup canvas for sizing, so
  `#previewCv` stayed blank; now a dedicated `previewRenderer` is bound to the popup's
  canvas (`new THREE.WebGLRenderer({ canvas })`) and draws into it (E2E adds a render
  smoke). Suite green (run66, 89 checks; run65 hit the KNOWN-FLAKY terrain-graze ang-err
  tolerance once — clean on immediate re-run, unrelated to this UI round). **Follow-up 4
  (user: "cards horizontal + playing-card miniature… weapon view = SIDE VIEW… hover video
  same for every canoe")** — cards: `#classCards` flex-row of 112px mini cards, portrait
  5:7 weapon pictures (weaponImage now renders 150×210 portrait). Clip: probe-clip.js
  proved the three classes DID render distinct frames (pixel-diff across three canvases —
  the wiring was right all along); the real problem was presentation — the clip framed
  the whole canoe at a 3/4 angle so the guns were unreadably small. The clip is now a
  WEAPON-ONLY SIDE PROFILE (same camera as the card picture: cam (4.6,1.25,0.9) looking
  at (0,0.3,0), no hull/water/rotation) with the recoil → flash → shell-arc loop, so each
  gun type reads instantly. probe-clip.js kept as a regression probe (playwright-core +
  CHROME_PATH, compares the three clip frames pixel-wise). Suite green (run68, 91
  checks). **Follow-up 5 (user: "gun points UP-LEFT in the card… clip shows the full
  shot: fire, projectile leaves the barrel, lands in the WATER")** — both card picture
  and clip rotate the weapon `y=-0.7, x=-0.45` so the barrel reads up-left diagonally;
  the flash rides the barrel tip as a child of the gun group. The clip's 2.4 s loop is
  now the FULL sequence: recoil + muzzle flash (0–0.22 s) → projectile arcs from the
  barrel tip across the frame (0.1–1.75 s, ballistic sine arc) → it LANDS in a water
  plate (0.1 s before cycle end: expanding foam patch with opacity fade at the impact
  point, lower-right) → rest → repeat. Suite green (run69, 91 checks). **Follow-up 6 (user:
  "preview gun ≠ canoe gun… projectile ≠ cannon… bigger clip… logical FORWARD arc, no
  illogical right-side splash")** — the clip projectile is now the REAL in-game shell
  per class (PROJ_SIZE/PROJ_COLORS/PROJ_EMIT: rail bolt, dark cannon ball, rocket +
  flame), the canvas grew to 360×230, and the trajectory launches ALONG the barrel line:
  barrel up-left (gun rot y=-0.85 x=-0.3, matching the card), projectile arcs from the
  barrel tip (s.tip) down to a landing point ON the firing line (s.land, below-left of
  the cannon), splash there. Also: probe-focus.js proved the game drives fine (8.3 u/s)
  while the E2E's drive-straight check failed 3× — the pilot was being killed in the
  pre-W window; the check now waits for the pilot to be alive first (same guard as
  attemptJump) and reports liveness. Suite green 2× (run73/74, 91 checks). **Follow-up 7
  (user: "style window cut off at any resolution… razorfin bolt too large… barrel exit
  illogical… loop = one basic + one special shot")** — (1) STYLE WINDOW: `#cosmWrap` is
  now a 2×2 grid of compact 38px tiles (all four sections visible at once), the 38vh cap
  is gone, and `#menu` scrolls with `#menuRow { margin:auto }` so nothing is ever cut
  off at any resolution. (2) clip projectiles scaled down for preview (rail ×0.55, others
  ×0.8 — the 1.5 u bolt dwarfed the gun). (3) **exit trajectory is now a quadratic
  BEZIER whose control point sits ON the barrel axis** — the tangent at the muzzle
  EXACTLY matches the barrel direction, then bends down into the water (also orients
  the projectile along the tangent). (4) the 5.2 s loop = one BASIC shot (recoil/flash →
  bezier flight → splash) then one SPECIAL ability shot per class: barge MINE drops
  from the hull and splashes (red pulsing core), razorfin GATLING fires three quick
  slugs, rocket MISSILE RAIN arcs one missile high with a bigger splash. Suite green
  (run75, 91 checks). ?v=80.
- **Round 8 (lobby overhaul: login, overlay style window, preview parity, trails)** —
  (1) LOGIN screen gates the title: persistent per-username profiles in localStorage
  (`canoe_arena_accounts_v1`), `test`/`test` seeded at MAX level 50 with all styles
  unlocked; new usernames auto-register at level 1; session persists (`LOG OUT` on the
  title). (2) "CHOOSE YOUR WEAPON" prompt above the canoe cards; the hover popup gained
  a stat card (WPN DMG / WPN SPD / CANOE SPEED from tier-0 defs). (3) RETURN TO MAIN
  MENU button in the lobby → `actions.leaveMatch()` (title view + net.leave). (4) STYLE
  & COSMETICS is now a BUTTON that opens an overlay over the lobby (staged edits;
  Apply commits / Cancel discards, both close). Overlay preview = real buildCanoe,
  CONSTANT wall-clock slow spin that never restarts on hover (cosmetic swaps are
  seamless); canvas uses preserveDrawingBuffer for pixel reads. (5) preview parity:
  clip + card image now share `buildProjVisual(kind)` with gameplay (REAL spiky mine
  with hp bar, REAL rocket+flame); barge barrel FLIPPED in previews only (builder
  droops toward the muzzle — `children[1].rotation.x=-0.7`); razorfin/rocket restored
  to the original `rotation.x=-0.3` up-angle; muzzle tip/dir still matrix-derived
  (localToWorld). (6) flags: 8 designs, aggressive ones LATER (jolly roger 14,
  blackbeard 16, kraken 19); flag texture draws the icon over the base color; sections
  get buffer spacing (border-top + 18px). (7) figureheads: icons matched to the 3D
  assets (none=🚫, phoenix=🦅), mounted on the STERN facing the camera (user: "backwards
  but fun"). (8) WAKE TRAILS (now E2E-tested): renamed stars/flames/poison/dookie/ice
  (old ids migrated in loadProfile); moving sprays pooled EMOJI-SPRITE icon pixels
  (5-7 per 0.13 s tick, ~45+ alive, budget 220) that drift, SINK into the ocean and
  fade; `stats().trailIcons` exposes the count; E2E asserts peak > 30 after the
  drive-straight check (own() uses `alive` NOT `al` — the first trail check polled
  dead pilots with the wrong field). Suite green (run79, 104 checks). ?v=82 / CSS v54.
- **Round 9 (wave shake removed + CANNON COVE becomes a real map)** — (1) the hull
  "shake" on the waves is GONE: the visual tilt was driven by the FULL waveH slope —
  the chop octave (t·2.7, ~20 u wavelength) wobbled the canoe AND the title plate
  riding it. Tilt now uses a swell-only `swellH()` (4 low-freq octaves, no chop) with
  a slower 0.12 ease, and the client prediction's wave clock locks to the server
  clock each snap (`local.predT += (srvTime-predT)*0.5` — the free-running predT
  drifted and made wave-follow y fight the reconcile). Fluid bobbing only.
  (2) CANNON COVE redesigned: a horseshoe BAY (two long headland arms + head island,
  ramp-jumpable) with 4 boost ramps (mouth launches in, head-island launches out,
  flank ramps jump OVER the arms), 5 shield pickups, crow's-nest skyisle, and THREE
  fortress cannon batteries (the namesake): idle → 1.4 s WARN telegraph (red pulsing
  ring + beacon at the aim point) → high-arc lob (spd 220/200, grav 800, dmg 26/22,
  splash 4.5/4). owner -1 = environmental (hits everyone, credits nobody, kills read
  "claimed by the cove cannons" via kill()'s new cause param). Batteries render in
  buildArena with recoil on fire. Sim lock (warn→lob→26 dmg) + E2E map-distinctness
  check added. E2E hardening: trail test now circles (W+D) so the hull never parks on
  a wall/pad; jump test steers to open water (25,-25) first and measures against the
  FROZEN launch-time surface (a rising wave face used to eat the peak); wake/trail
  spawning is now wall-clock scheduled (`time >= pv.nextWakeAt`) — the frame-counted
  `wakeT -= 1/60` collapsed at low headless fps and killed the icon stream. Suite
  green (run85, 106 checks). ?v=83.
- **Publishing round** — repo initialized + pushed to GitHub (`scottramos09/canoe-battler`,
  private; `gh` CLI authed as scottramos09). Deploy scaffolding verified: `render.yaml`
  blueprint (Node web service, free plan, `npm install --omit=dev` → `node server/server.js`,
  ALLOW_ADMIN=1 for /admin/reset), `netlify.toml` (build `node scripts/build.js`, publish
  `public/`, CANOE_SERVER env), `scripts/build.js` injects the server host into
  `server-config.js` (verified: env set → host injected; empty → same-origin). Client
  connection logic: `CANOE_SERVER || location.host` → `wss://host/ws` on https. Added
  `.gitignore` (node_modules/shots/perf.log), `engines.node >=18`, bumped
  server-config.js to ?v=52. **`docs/PUBLISHING.md` = the full free-tier walkthrough**
  (Render blueprint → Netlify env → UptimeRobot keep-alive → smoke test → friend link +
  lobby flow, troubleshooting, limits). NOTE: one shared lobby per server instance —
  two simultaneous friend groups need a second blueprint instance + second site.
- Razorfin: hp 140, spd 13.5, rails spd 46–64 (pierce), mines/torps, GATLING BURST cd 6.
- Rocket: hp 180, spd 11, rockets cd 1.05 (MISSILE RAIN cd 10), shotgun tiers, CLUSTER HELL
  split.
- Bots: low/med/high ladder (low=36, med=492, high=768); low fireChance 0.2; shock mechanic
  `noise*(1.7-aggr)*shockMul(game,t)`; abilityChance med 0.65 / low 0.4.
- Controls (client truth in `public/js/input.js`): W/S/A/D + arrows, LMB=FIRE1,
  **RMB=ability**, Q=FIRE2, E=ability alt, Shift=boost, Space=jump, B=(shop disabled), Tab=scoreboard,
  Esc=pause, M=mute.
- Steering convention (locked, server/bots/prediction/gamepad identical): `ang` increasing =
  bow toward screen-right; LEFT = CCW = `ang` DECREASES; `turn=(right?1:0)-(left?1:0)`.
  Aim convention `atan2(dz, dx)`; pitch positive = aim UP; turret converges to `input.aimYaw`
  each tick (simtests must set `a.input.aimYaw` + turret directly).

## 7. UI (delivered, no active complaints)

Title screen (CREATE / JOIN / PRACTICE / SHOP-disabled) → gacha-styled lobby: host-only
settings panel, canoe cards with real gun renders + hover fire-clips, crew list,
collapsible lobby chat, bottom style drawer (paint/figurehead/flag/wake — all render,
locked items show unlock levels). Bottom-center HUD panel (SCORE/KILLS/WEAPON +
FIRE1/SPECIAL/BOOST + toggles), WoW-style cooldown sweeps, health/shield bars above
heads, killfeed-only notifications. Camera: eased chase, MMB orbit, wheel zoom, shake,
centrifugal lean, boost pull-back. FOV: player-perspective transitions; mini-game keeps
the OLD orbit camera (user reversed the all-perspective idea).

## 8. Known issues / next steps

1. **Deploy (never executed):** `netlify.toml` + `render.yaml` blueprints exist. Git init →
   push → Render blueprint (rootDir `server/`) → Netlify build `node scripts/build.js` with
   `CANOE_SERVER`. LAN playtest first.
2. **User tuning may continue:** the mine layer's charge cadence (0.5 s / 10 s), mine
   damage (45), the pickups' airborne height (h + 1.2), and the shake curve
   (0.08 + 0.0022·dmg, cap 0.3) are recent choices; expect re-tunes. Also the user's
   earlier asks around min-range feel.
3. **SceneProof evidence** (`shots/arena-evidence.png`) is stale — re-render for visual QA.
4. **perf.log:** capture a full user match, check late-match growth (tex/draws/parts/projs/mem).
5. **Godling** (`C:\Users\Scott\godling`, parked) — planet-crumble physics, out of band.
6. TJAB validation scripts were cleaned up; `scripts/tjab-rpc.js` is the keeper helper.
   `scripts/tjab-validate-shotgun.js` was deleted after serving its purpose — recreate from
   the pattern in section 5 if needed.

## 9. Memory-resident facts worth honoring

- Frontier models via OpenCode Go only; cheapest capable per task, flagship for
  orchestration. Never substitute model names — verify via API.
- Debugging: one-variable hypotheses, read the real code, probe empirically with tiny
  scripts (never hand-roll physics/formulas), quick diagnostic builds, restore assets after
  fix, loop-gauntlet elusive flakes 3×.
- Orchestrator chain (hy3→deepseek-v4-pro→grok-4.5→kimi-k3) lives at
  `C:\Users\Scott\hermes-agent-orchestrator` (start.bat/run.bat, kill stale :8080 first).
- `npm run gates` = P0–P4 phase gates in the tjab repo; `npm start` = tjab server :4701.

---
*End of handoff. When in doubt: read the code, run the suite once, restart the server, bump the cache-buster.*
