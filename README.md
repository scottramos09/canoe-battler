# 🛶 CANOE ARENA — Box Geometry Naval Battler

A fully 3D multiplayer canoe battler built with **three.js** where **every mesh is a box**.
Steer a boxy canoe across a wave-swept ocean, mount progressively ridiculous artillery,
and sink your friends. Server-authoritative physics (30 Hz) with client-side prediction.

## 🌐 Online play & the lobby

The **title screen** has four doors: **CREATE LOBBY** (you host), **JOIN LOBBY**, and
**PRACTICE** (solo warm-up with a PRACTICE banner) all lead to the lobby; **SHOP** is
temporarily disabled. In the lobby:

- **Host only** (left, collapsible): game settings — Mode, Map, **Add Bots? Yes/No**
  (with a ± count and bot difficulty).
- **Everyone**: canoe cards showing a real render of each gun, with a **hover video
  clip** of the canoe firing it; the CREW list; a **lobby chat** (right, collapsible —
  scoped to this lobby, cleared when it closes, kept through "play again"); and a
  **STYLE drawer** (bottom, collapsible) for hull paint, figurehead, flag, and wake
  trail — all render in-game; locked styles show their unlock level on hover.

## 🎮 Controls

| Input | Action |
|---|---|
| `W` / `S` | thrust / reverse |
| `A` / `D` | steer (ramped, speed-scaled — weighty at speed, crisp at low speed) |
| Mouse | aim turret (crosshair on water; turret tracks at high traverse speed) |
| `LMB` | fire weapon 1 |
| `RMB` | **class ability / special** (MINE LAYER, GATLING BURST, MISSILE RAIN) |
| `Q` | fire weapon 2 |
| `E` | ability (alt binding) |
| `Shift` | boost (ramped surge) |
| `Space` | jump (hop with forward kick) |
| `B` | — (shop disabled) |
| `Tab` | scoreboard (hold) |
| `Esc` | pause menu (resume / leave match / mute) — **gamepad Start** too |
| `M` | mute |

**Gamepad:** left stick drives (analog steering with deadzone remap), right stick aims
(camera-relative), `RT`/`LT` fire, `RB` boost, `LB` ability, D-pad `↓` scoreboard.
In the lobby and pause menu: D-pad navigates, `A` activates, Start = join/launch/pause.

**Aiming aids:** the aim-line traces your shell's predicted arc from the barrel tip;
a **yellow X** marks the water impact point and a **red X** marks the predicted intercept
(flight-time lead) of the enemy you're tracking — World-of-Warships-style assisted aiming
(never auto-fire; a subtle magnet pulls the crosshair onto nearby targets).

## 🚤 Canoes & progression

Three starters, each with its own 5-tier weapon/hull trees. **The shop is disabled** —
upgrades come free from kills (kill = +1 weapon level; 2 assists = +1) and the ramp
upgrade pickup; upgrades persist through death:

- **RAZORFIN DART** — featherweight racer (hp 140, spd 13.5). Rail lance (fast piercing
  slugs) + wake mines → homing torpedoes. Ability: **GATLING BURST** (10-rail churn, cd 6).
- **THUNDER BARGE** — floating fortress (hp 250, spd 8.6). High-arc explosive cannons →
  DOOM MORTAR + a rapid chug gun → harpoon cannon. Ability: **MINE LAYER** (3 sea-mine
  charges, 0.5 s between drops, 10 s refill).
- **SCRAP ROCKET** — junk-built (hp 180, spd 11). Rocket pods → CLUSTER HELL + scrap
  shotgun → DEVASTATOR. Ability: **MISSILE RAIN** (4-rocket fan, cd 10).

### Barge basic attack — DEFINED range window

The barge cannon is the **long-range specialist**. The window is explicit and enforced:

- **MINIMUM range: 15 u** (`arm: 15`) — shells fly through everything (players, mines,
  water) until they've traveled 15 u, so the close range belongs to the mine layer and
  the secondary.
- **MAXIMUM range: 100 u** (`maxRange: 100`, hard travel cap) — the user's final tuning:
  "let's do a range of 15–100 u" — a mid-range specialist. Cannons `spd 282.8 / grav 800`
  (per-tier grav), high-arc (`high: 1`, `maxPitch` 1.5 = 86°) so every shot lobs
  45–86°, flights 0.5–0.71 s, real ballistic reach ≈ 96–100 u. The tier `desc` shows the
  window ("range 15–100 u"). DOOM MORTAR: same window.

The old `life × spd` figure was *theoretical flat travel* — the shells arc and explode
on the water. The simtest measures the **actual ballistic water-impact distance**.

### Barge special — MINE LAYER

The barge drops sea mines: **3 charges, 0.5 s between successive drops, 10 s refill**
re-granting all 3. Each press drops ONE mine (dmg 45) BEHIND the hull — flee and leave
a trail. Mines bob at the waterline and detonate on proximity.

Weapon tiers change the barrels on your canoe visually (bigger + gold trim + glowing
core); hull tiers bolt on armor plates.

## 🏆 Modes

- **FFA** — first to 2,000 pts or most points at 8:00. Respawn on, upgrades persist.
- **King of the Hill** — hold the gold-ringed hill (22 m zone, pulsing beacons) for
  points; most points at 5:00 wins. Bots contest the hill.

XP from kills/wins/points levels your **profile** (localStorage) and unlocks cosmetics:
hull paints, figureheads, flags, wake trails.

## 🌊 The sea

A full FFT (Tessendorf) ocean: spectrum → phase → FFT displacement + normals, layered
analytic chop octaves in the vertex shader, a scene-reflection pass, sun glitter, and
sparse whitecaps. **Canoes ride the shared 6-octave analytic wave field with a buoyancy
spring** —
they lag crests and plunge into troughs, and muzzle height rides the swell so long-range
aim genuinely drifts. The same wave function runs server-side, client-side, and in the
shader. Horizon-fogged open ocean with volumetric clouds and a visible sun; the play
boundary is an invisible wall.

## 🧱 Tech notes

- **Server** (`server/`): Node + `ws`. Authoritative sim at 30 Hz — physics, ballistics
  (`solvePitch` 3D arc solver), buoyancy, collisions, damage with hit-located visual
  damage spots, bot AI (lead + pitch aiming, human-scale error), crates, modes.
- **Collisions are slide, not trip** — a single normal-based terrain pass (rocks +
  island beaches) that pushes the hull out and kills only the INTO-obstacle velocity
  component; walls kill only the inward component. The old dual-push system (two
  conflicting passes) bled 40% speed per frame while grazing and rattled at corners,
  which read as "canoes trip on assets and won't drive straight".
- **Client** (`public/js/`): three.js renderer (box geometry everywhere, pooled
  particles, chased eased camera with centrifugal lean), prediction + reconciliation
  for self, 120 ms interpolation for remotes, WebAudio synth SFX, vibration with
  hard-stop on focus loss.
- **Shared truth:** `server/defs.js` (classes/weapons/modes/maps) ships to clients on
  join; `server/game.js` ↔ `public/js/ballistics.js` wave + ballistics math are mirrors.
- **TJAB (Three.js Agent Bridge)** is integrated for self-validation: `public/vendor/
  tjab-bridge.js` + `window.TJAB.attach(renderer, scene, camera, { ringBuffer: {frames: 0} })`.
  The ring buffer is **disabled** — its per-frame offscreen re-render + JPEG tax
  stuttered real gameplay and made E2E input checks flaky. Validation uses the snap +
  live scene queries. Ops in `TJAB.md` and `handoff.md`.

## 🧪 Testing

```bash
npm test          # headless sim combat + Playwright E2E (real Chrome, real clicks)
npm start         # run the server (port 3000)
```

`scripts/run-tests.js` boots a scratch server (`ALLOW_ADMIN=1`), runs the combat sim
(28 locks: SIM COMBAT, BOOST PLATFORM, MINES, SHIELD, UPGRADES, BOT LADDER, MINE LAYER
cadence + MECH PARITY, ASSISTS, SHOP DISABLED, LOBBY CHAT + BOTS TOGGLE + PRACTICE,
COLLECTIBLE SPACING, SINGLEPLAYER QUIT,
GATLING churn, STRAIGHT-DRIVE MASTER, **BARGE REAL RANGE ~96–100 u**, **CANOE SLIDE**,
KILLFEED), then drives Chrome through
join → launch → play asserting HUD, shop-disabled, scoreboard, killfeed, damage spots, health
bars, and zero console errors (~40 checks, alive-gated so bot kills can't false-fail).

**Test discipline:** never re-run a green suite on unchanged bytes. E2E checks that
sample gameplay (jump, right-click, damage) are alive-gated + retried — an idle pilot
dies to bots.

## 🚀 Deploy

Client is static (`public/`); the WS server needs a host. Free-tier setup, fully
walked through in **`docs/PUBLISHING.md`**:

- **Render.com** (free): `render.yaml` blueprint — Node web service serving both the
  static client and the `/ws` WebSocket. Repo is pushed to GitHub
  (`scottramos09/canoe-battler`, private).
- **Netlify** (free): build `node scripts/build.js` (injects `CANOE_SERVER` env),
  publish `public/`. Set `CANOE_SERVER` to the Render host (no scheme/port).
- **UptimeRobot** (free): 5-min HTTP ping keeps the Render instance from sleeping.
- Client connection: `CANOE_SERVER` non-empty → `wss://<host>/ws`; empty → same-origin
  (localhost / LAN play).
- LAN: `npm start`, friends join at `http://YOUR-IP:3000`.
- **Status:** code pushed to GitHub; Render/Netlify deploys pending (walkthrough in
  `docs/PUBLISHING.md`).

## 📊 Performance

- `perf.log` (repo root): client `reportPerf` every 10 s during play (reads the snap's
  phase directly — a stale UI `state.phase` previously gated it into silence) → server
  `case 'perf'` appends one line (fps/draws/tris/parts/tex/mem/ps/projs). Verified
  writing; use it to hunt late-match growth (tex/draws/parts/projs/mem).
- Fixed leaks: server killfeed drained per snap (`splice(0)`); per-hit damage-number
  canvas textures cached (Map) + disposed; E2E asserts texture count bounded (< 120).

## 📚 References used

- **three.js** `examples/jsm/objects/Water2.js` — flow-blended normal technique (fused
  into the water shader).
- **MarineSim3D / BoatPhysics3D** (github.com/MohamedQatish/BoatPhysics3D, cloned in
  `reference/`) — Archimedes buoyancy concept for the hull spring; rotation-rate
  steering model.
- World of Warships-style aiming: reticle-centered turret traverse, shell flight-time
  lead indicator, water impact markers.
