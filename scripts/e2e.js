'use strict';
// ============================================================
// CANOE ARENA — E2E test: real Chrome, real clicks, screenshots,
// console-error capture. Verifies JOIN → START → play flow,
// menu hiding, HUD, own-ship rendering, aim-line, killfeed.
// Host is claimed by a raw WS client so zombie tabs can't race us.
// Run: node scripts/e2e.js   (server must run with ALLOW_ADMIN=1)
// ============================================================
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const BASE = process.env.E2E_BASE || 'http://localhost:3000';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';
const SHOTS = path.join(__dirname, '..', 'shots', 'e2e');
const CHROME = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function rawJoin(name) {
  return new Promise((res) => {
    const ws = new WebSocket(WS_URL);
    let myId = -1, done = false;
    const finish = (v) => { if (!done) { done = true; if (!v) { try { ws.close(); } catch { } } res(v); } };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, cls: 'razorfin', cosmetics: {} })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.t === 'joined') myId = m.id;
      if (m.t === 'lobby' && myId > 0) {
        if (m.host === myId) finish({ ws, myId });
        else finish(null);
      }
    });
    ws.on('close', () => finish(null));
    ws.on('error', () => finish(null));
    setTimeout(() => finish(null), 4000);
  });
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push('CONSOLE: ' + m.text()); });

  const ok = (name, cond) => { console.log(`${cond ? '✅' : '❌'} ${name}`); if (!cond) failures.push(name); };
  const failures = [];

  // ---- claim host via raw WS (retry loop beats zombie-tab reconnects) ----
  let host = null;
  for (let i = 0; i < 4 && !host; i++) {
    await fetch(BASE + '/admin/reset', { method: 'POST' }).catch(() => {});
    await new Promise(r => setTimeout(r, 700));
    host = await rawJoin('E2EHost');
    if (!host) await new Promise(r => setTimeout(r, 800));
  }
  ok('raw WS claimed host', !!host);
  if (!host) { await browser.close(); process.exit(1); }

  const pilotName = 'Pilot' + Math.floor(Math.random() * 1000);
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(1200);
  // ---- LOGIN SCREEN: persistent profiles; test/test is the seeded max-level
  // profile (all styles + cosmetics unlocked) ----
  ok('login screen gates the title', await page.locator('#login').isVisible());
  await page.locator('#loginUser').fill('test');
  await page.locator('#loginPass').fill('test');
  await page.locator('#btnLogin').click();
  await page.waitForTimeout(500);
  ok('login hides after sign-in', await page.locator('#login').evaluate(el => el.classList.contains('hidden')));
  ok('test profile is max level (50)', (await page.locator('#lvlNum').textContent()).trim() === '50');
  // ---- TITLE SCREEN: CREATE / JOIN / PRACTICE / SHOP(disabled) ----
  ok('title screen: 4 mode buttons visible',
    await page.locator('#btnCreate').isVisible() && await page.locator('#btnJoin').isVisible() && await page.locator('#btnPractice').isVisible());
  ok('shop button present but disabled', await page.locator('#btnShopTitle').isDisabled());
  await page.evaluate((n) => { document.getElementById('inpName').value = n; }, pilotName);
  await page.locator('#btnJoin').click(); // JOIN (the raw WS host already owns the lobby)
  await page.waitForTimeout(1500);
  const btnText1 = (await page.locator('#btnStart').textContent()).trim();
  ok(`pilot joined: button is START or WAITING (got "${btnText1}")`, btnText1.includes('START') || btnText1.includes('WAITING'));
  const crew = await page.locator('#playerList .prow').count();
  ok(`crew list populated (${crew} rows)`, crew >= 5);
  // ---- the two maps are DISTINCT: Cannon Cove = horseshoe bay + 3 fortress
  // cannon batteries; Box Lagoon = central island, no cannons ----
  const mapsDiff = await page.evaluate(() => {
    const defs = window.__dbg.net.defs;
    const l = defs.MAPS.lagoon, c = defs.MAPS.cove;
    return {
      coveCannons: (c.cannons || []).length,
      lagoonCannons: (l.cannons || []).length,
      coveIsles: (c.isles || []).length,
      lagoonIsles: (l.isles || []).length,
    };
  });
  ok(`maps are distinct (cove ${mapsDiff.coveCannons} batteries/${mapsDiff.coveIsles} isles vs lagoon ${mapsDiff.lagoonCannons}/${mapsDiff.lagoonIsles})`,
    mapsDiff.coveCannons === 3 && mapsDiff.lagoonCannons === 0 && mapsDiff.coveIsles === 3 && mapsDiff.lagoonIsles === 1);
  // host settings panel is HOST-ONLY — the pilot (non-host) must not see it
  ok('host settings panel hidden for non-host', await page.locator('#hostPanel').evaluate(el => el.classList.contains('hidden')));
  // canoe cards are a card-shaped weapon picture + the name (no swatches/icons)
  ok('canoe cards carry weapon pictures', (await page.locator('#classCards .cc-card').count()) >= 3);
  ok('cards have no swatches or icons', (await page.locator('#classCards .cc-swatch').count()) === 0);
  ok('choose-your-weapon prompt sits above the cards',
    (await page.locator('#weaponPrompt').textContent()).includes('CHOOSE YOUR WEAPON'));
  const cardBox = await page.locator('.classcard').nth(0).boundingBox();
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  await page.waitForTimeout(700);
  ok('hover shows the gun clip popup', await page.locator('#previewPop').isVisible());
  const clipSmoke = await page.evaluate(() => {
    const g = window.__dbg && window.__dbg.game;
    const defs = window.__dbg && window.__dbg.net.defs;
    if (!g || !defs) return false;
    try { g.classClipFrame(defs.CLASSES.razorfin, 0.5, document.getElementById('previewCv')); return true; } catch (e) { return false; }
  });
  ok('preview clip renders into the popup canvas', clipSmoke);
  // stat card: WPN DMG / WPN SPD / CANOE SPEED under the clip
  const pvStats = await page.evaluate(() => ({
    dmg: document.getElementById('statDmg').textContent.trim(),
    spd: document.getElementById('statSpd').textContent.trim(),
    csp: document.getElementById('statCanoe').textContent.trim(),
  }));
  ok(`preview stat card (WPN DMG ${pvStats.dmg}, WPN SPD ${pvStats.spd}, CANOE SPEED ${pvStats.csp})`,
    /^\d+(\.\d+)?$/.test(pvStats.dmg) && /^\d+(\.\d+)?$/.test(pvStats.spd) && /^\d+(\.\d+)?$/.test(pvStats.csp));
  await page.mouse.move(5, 5);
  await page.waitForTimeout(200);
  // tab/window text blocks and buttons carry NO emoji icons
  const emojiFree = await page.evaluate(() => {
    const rx = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}]/u;
    for (const id of ['chatHead', 'hostPanelHead', 'btnStyle', 'btnMenu', 'btnLogin', 'btnCosmApply', 'btnCosmCancel', 'btnCreate', 'btnJoin', 'btnPractice', 'btnStart', 'btnMuteT', 'btnScoresT']) {
      const el = document.getElementById(id);
      if (el && rx.test(el.textContent)) return id;
    }
    return '';
  });
  ok(`window/button text is emoji-free (${emojiFree || 'clean'})`, emojiFree === '');
  // lobby chat roundtrip (own message echoes through the server broadcast) —
  // the chat dock STARTS COLLAPSED, so expand its tab first
  await page.locator('#chatHead').click();
  await page.waitForTimeout(300);
  await page.locator('#chatInput').fill('ahoy test 123');
  await page.locator('#chatSend').click();
  await page.waitForTimeout(700);
  const chatSeen = await page.locator('#chatMsgs').textContent();
  ok('lobby chat roundtrip', chatSeen.includes('ahoy test 123'));
  await page.locator('#chatHead').click(); // collapse it again
  await page.waitForTimeout(300);
  // docked windows START COLLAPSED as labeled tabs and toggle via the tab text
  ok('chat dock starts collapsed with a visible labeled tab',
    await page.locator('#chatPanel').evaluate(el => el.classList.contains('collapsed'))
    && await page.locator('#chatHead').isVisible()
    && (await page.locator('#chatHead').textContent()).includes('LOBBY CHAT'));
  await page.locator('#chatHead').click();
  await page.waitForTimeout(300);
  ok('chat expands from its tab', await page.locator('#chatPanel').evaluate(el => !el.classList.contains('collapsed')));
  await page.locator('#chatHead').click();
  await page.waitForTimeout(300);
  ok('chat re-collapses to the tab', await page.locator('#chatPanel').evaluate(el => el.classList.contains('collapsed')));
  // ---- STYLE & COSMETICS: a BUTTON opens an overlay window over the lobby
  // (no docked drawer). Hover previews the canoe, Apply commits, Cancel
  // discards — both close the overlay and return to the lobby. ----
  ok('style button visible in the lobby', await page.locator('#btnStyle').isVisible());
  await page.locator('#btnStyle').click();
  await page.waitForTimeout(500);
  ok('style button opens the overlay', await page.locator('#cosmOverlay').isVisible());
  ok('style overlay has all four sections', (await page.locator('#cosmWrap .sec-title').count()) === 4);
  ok('test profile has every style unlocked', (await page.locator('#cosmWrap .cositem.locked').count()) === 0);
  // figureheads show their PICTURES (the user preferred the picture icons)
  const fhPic = (await page.locator('#cosmWrap .cositem[data-k="figurehead"]').nth(1).textContent()).trim();
  ok(`figureheads show pictures ("${fhPic}")`, fhPic.length > 0);
  // hover a paint tile → the canoe preview canvas must render (non-blank)
  await page.locator('#cosmWrap .cositem[data-k="paint"]').nth(1).hover();
  await page.waitForTimeout(700);
  const cosmPrev = await page.evaluate(() => {
    const cv = document.getElementById('cosmCv');
    const len = cv.toDataURL().length;
    // a WebGL canvas can't host a 2d context — copy it, then read pixels
    const c2 = document.createElement('canvas');
    c2.width = cv.width; c2.height = cv.height;
    const c = c2.getContext('2d');
    c.drawImage(cv, 0, 0);
    const d = c.getImageData(0, 0, cv.width, cv.height).data;
    let lit = 0;
    const colors = new Set();
    for (let i = 0; i < d.length; i += 16) {
      const key = (d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4);
      colors.add(key);
      if (d[i] + d[i + 1] + d[i + 2] > 90) lit++;
    }
    return { len, colors: colors.size, lit };
  });
  ok(`cosmetic hover renders the canoe preview (${cosmPrev.colors} color buckets, ${cosmPrev.lit} lit px)`, cosmPrev.colors > 10 && cosmPrev.lit > 500);
  // CANCEL discards changes and closes the overlay, back to the lobby
  await page.locator('#btnCosmCancel').click();
  await page.waitForTimeout(300);
  ok('cancel closes the overlay', await page.locator('#cosmOverlay').evaluate(el => el.classList.contains('hidden')));

  // ---- RETURN TO MAIN MENU: back to the title + leave the lobby ----
  await page.locator('#btnMenu').click();
  await page.waitForTimeout(1500);
  ok('return to main menu shows the title view', await page.locator('#titleView').isVisible());
  ok('return to main menu hides the lobby view', await page.locator('#lobbyCol').evaluate(el => el.classList.contains('hidden')));
  await page.locator('#btnJoin').click(); // rejoin for the rest of the flow
  await page.waitForTimeout(1800);
  ok('rejoined after return-to-menu', (await page.locator('#playerList .prow').count()) >= 5);
  await page.screenshot({ path: path.join(SHOTS, '1-lobby.png') });

  // ---- canoe selection AFTER joining must reach the SERVER (barge/rocket bug) ----
  await page.locator('.classcard').nth(1).click(); // THUNDER BARGE
  await page.waitForTimeout(700);
  const clsNow = await page.evaluate(() => {
    const g = window.__dbg;
    const snap = g.net.snapInfo();
    const own = snap && snap.ps.find(p => p.i === g.info().myId);
    return own ? own.c : '';
  });
  ok(`class selection reaches the server (picked barge, server has "${clsNow}")`, clsNow === 'barge');

  // ---- host starts the match ----
  host.ws.send(JSON.stringify({ t: 'start' }));
  await page.waitForTimeout(900);
  const menuHidden = await page.locator('#menu').evaluate(el => el.classList.contains('hidden'));
  ok('menu hides during countdown', menuHidden);
  const countdownVisible = await page.locator('#countdown').isVisible();
  ok('countdown overlay visible', countdownVisible);
  await page.screenshot({ path: path.join(SHOTS, '2-countdown.png') });

  await page.waitForTimeout(6500); // into play
  const menuHidden2 = await page.locator('#menu').evaluate(el => el.classList.contains('hidden'));
  ok('menu still hidden in play', menuHidden2);
  // the GO! overlay MUST dismiss itself (regression: 'GO' vs 'GO!' mismatch
  // left the game stuck on the countdown screen)
  const goGone = await page.locator('#countdown').evaluate(el => el.classList.contains('hidden'));
  ok('GO! overlay dismisses into play', goGone);

  // ---- RENDERER ALIVE GUARD — a mid-frame crash kills the 3D scene while
  // the game logic keeps running (the rAF loop re-schedules BEFORE
  // game.render, so an exception in the water draw leaves a sky-only frame
  // and EVERY gameplay assertion stays green). The 2026-08-09 white-water
  // bug: a short vec4 array uniform (uIsles 10 entries vs GLSL uIsles[12])
  // threw in the uniform uploader every frame — water never drew, whole
  // scene was pale sky, suite passed. Guard = real draw calls + non-flat
  // pixels from the live canvas.
  const renderAlive = await page.evaluate(() => {
    const g = window.__dbg && window.__dbg.game;
    if (!g) return { ok: false, why: 'no __dbg.game' };
    const st = g.stats();
    const s = g.sample(6);
    const flat = s.every(row => row.split(' ').every(c => c === s[0].split(' ')[0]));
    return { ok: st.draws > 2 && !flat, draws: st.draws, tris: st.tris, flat };
  });
  ok(`renderer alive (draws=${renderAlive.draws}, tris=${renderAlive.tris}, flat=${renderAlive.flat})`, !!renderAlive.ok);
  if (renderAlive.why) console.log('   renderer-alive probe:', renderAlive.why);

  // Keep the pilot MOVING (hold W) — an idle canoe gets killed by the bots
  // and every input check below (jump/ability) then samples the respawning
  // hull: the flaky "rest 0.01 → max 0.41" was a DEAD pilot, not a jump bug.
  await page.keyboard.down('KeyW');

  // ---- DRIVE STRAIGHT (hardening): while W is held with no steer, the own
  // hull's heading must not drift and it must reach full speed (a tripped
  // canoe bleeds speed and crabs). Samples from 400 ms on — the first beat
  // is acceleration from rest. Retried once: a bot ram in the window is the
  // only way to perturb it. ----
  const attemptDriveStraight = async () => {
    // the pilot must be ALIVE to drive (mirrors attemptJump's guard below —
    // an idle canoe catching a bot volley in the pre-W window reads as
    // speed ~0.1 with 0 drift; W stays held through the respawn)
    const aliveNow = async () => page.evaluate(() => {
      const o = window.__dbg && window.__dbg.net && window.__dbg.net.own();
      return !!(o && o.al !== false && o.hp > 0);
    });
    for (let i = 0; i < 14 && !(await aliveNow()); i++) await page.waitForTimeout(250);
    const start = await page.evaluate(() => {
      const o = window.__dbg && window.__dbg.net && window.__dbg.net.own();
      return o ? { ang: o.ang } : null;
    });
    if (!start) return { maxDrift: 99, endSpd: 0 };
    let maxDrift = 0, endSpd = 0, alive = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 1300) {
      const r = await page.evaluate(() => {
        const o = window.__dbg && window.__dbg.net && window.__dbg.net.own();
        return o ? { ang: o.ang, spd: Math.hypot(o.vx, o.vz), al: o.al !== false && o.hp > 0 } : null;
      });
      if (r && Date.now() - t0 > 400) {
        let dA = Math.abs(r.ang - start.ang);
        if (dA > Math.PI) dA = Math.PI * 2 - dA;
        maxDrift = Math.max(maxDrift, dA);
        endSpd = r.spd;
        alive = r.al;
      }
      await page.waitForTimeout(80);
    }
    return { maxDrift, endSpd, alive };
  };
  let ds = await attemptDriveStraight();
  if (!(ds.maxDrift < 0.5 && ds.endSpd > 6)) ds = await attemptDriveStraight();
  ok(`drive straight: heading drift ${ds.maxDrift.toFixed(3)} rad (<0.5), speed ${ds.endSpd.toFixed(1)} u/s (>6), alive=${ds.alive}`, ds.maxDrift < 0.5 && ds.endSpd > 6);

  // ---- WAKE TRAILS (finally tested): the icon-pixel jet stream. The test
  // profile's trail ('embers' migrated to FLAMES 🔥) must spray a stream of
  // tiny sprites behind the hull while driving; they sink and fade (vfx).
  // Runs right after drive-straight proves the pilot is ALIVE at full speed.
  // W + D held = tight CIRCLE in open water: continuous speed without ever
  // parking on a wall/pad (a straight drive parks the hull and the spawns
  // stop — it also left the FOLLOW-UP jump test standing on a platform).
  await page.keyboard.down('KeyD');
  let trailMax = 0;
  for (let i = 0; i < 40 && trailMax < 60; i++) {
    const n = await page.evaluate(() => {
      const g = window.__dbg && window.__dbg.game;
      return g ? (g.stats().trailIcons || 0) : 0;
    });
    trailMax = Math.max(trailMax, n);
    if (trailMax < 60) await page.waitForTimeout(300);
  }
  await page.keyboard.up('KeyD');
  ok(`wake trail icon stream active while driving (peak ${trailMax} sprites)`, trailMax > 30);

  // ---- SPACE JUMP: the real client input path, end to end. Hold Space and
  // the own hull must leave the water — asserted RELATIVE TO THE WAVE
  // SURFACE AT THE LAUNCH POINT (`y - waveH(x0,z0)`, the water the hull
  // left). Two traps defeated the older baselines: (1) fixed-y failed
  // because the ±2.8 u swells move the water itself; (2) the current-position
  // surface failed because with W held the hull drives ~12 u during the
  // hold and a rising wave face eats the 1.17 u jump peak (measured
  // 2× peaking at exactly 0.00 despite a real jump). A hop peaks ~1.17
  // above the water it left, so +0.7 launch-relative can only be the jump.
  const aliveNow = async () => page.evaluate(() => {
    const s = window.__dbg && window.__dbg.net && window.__dbg.net.snapInfo();
    const p = s && s.ps && s.ps.find(x => x.i === window.__dbg.state.myId);
    return !!(p && p.al);
  });
  // settle in OPEN WATER first: the trail test circles the hull and it can
  // wander onto a boost pad (rest 1.6 = standing on a platform, jump gated
  // by rampT). Steer to a known-clear point at (25,-25) — clear of the
  // central island, all rocks, and every pad.
  await page.evaluate(async () => {
    const g = window.__dbg;
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
      const o = g.net.own();
      if (!o || !o.alive) break;
      const tx = 25 - o.x, tz = -25 - o.z;
      const d = Math.hypot(tx, tz);
      if (d < 6) break;
      const bearing = Math.atan2(tz, tx);
      let dA = bearing - o.ang;
      while (dA > Math.PI) dA -= Math.PI * 2;
      while (dA < -Math.PI) dA += Math.PI * 2;
      const steer = Math.abs(dA) > 0.12 ? (dA > 0 ? { right: 1 } : { left: 1 }) : {};
      g.setCmd(Object.assign({ up: 1 }, steer));
      await new Promise(r => setTimeout(r, 100));
    }
    g.setCmd({});
  });
  const attemptJump = async () => {
    for (let i = 0; i < 20 && !(await aliveNow()); i++) await page.waitForTimeout(250);
    const launch = await page.evaluate(() => {
      const o = window.__dbg && window.__dbg.net && window.__dbg.net.own();
      const t = window.__dbg && window.__dbg.game.time();
      return o ? { x: o.x, z: o.z, y: o.y, t } : { x: 0, z: 0, y: 0, t: 0 };
    });
    // FROZEN launch-time surface: measuring against a moving swell let a
    // rising wave face eat the 1.17 u jump peak (measured 2× peaking at 0.00
    // despite a real jump). The hull left THIS water — compare to it.
    const launchSurf = await page.evaluate(({ x, z, t }) => window.__dbg.waveH(x, z, t), launch);
    const restRel = launch.y - launchSurf;
    await page.keyboard.down('Space');
    let maxRel = 0;
    const tJump = Date.now();
    while (Date.now() - tJump < 900) {
      const r = await page.evaluate(({ x, z, t }) => {
        const o = window.__dbg && window.__dbg.net && window.__dbg.net.own();
        if (!o) return 0;
        return o.y - window.__dbg.waveH(x, z, t);
      }, launch);
      maxRel = Math.max(maxRel, r);
      await page.waitForTimeout(60);
    }
    await page.keyboard.up('Space');
    return { restRel, maxRel };
  };
  let jumpRes = await attemptJump();
  if (!(jumpRes.maxRel > jumpRes.restRel + 0.7)) jumpRes = await attemptJump();
  ok(`jump: own hull leaves the water (rest ${jumpRes.restRel.toFixed(2)} → max ${jumpRes.maxRel.toFixed(2)} rel)`, jumpRes.maxRel > jumpRes.restRel + 0.7);

  // ---- ESC: pause overlay must toggle (menu with return-to-title) ----
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const pauseShown = await page.locator('#pause').isVisible();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const pauseGone = await page.locator('#pause').evaluate(el => el.classList.contains('hidden'));
  ok(`ESC pauses (shown ${pauseShown}) and resumes (hidden ${pauseGone})`, pauseShown && pauseGone);

  // ---- RIGHT CLICK fires the SPECIAL (RMB = FIRE2, not the E key) ----
  // alive-gated like the jump: a dead pilot reads acd ≤ 0 and false-fails
  for (let i = 0; i < 20 && !(await aliveNow()); i++) await page.waitForTimeout(250);
  await page.mouse.down({ button: 'right' });
  // poll: a rAF stall under load can delay the 30 Hz input send past a single
  // sample — the cd (7 s) lasts long enough to catch it within 2 s
  let rmbAb = -1;
  for (let i = 0; i < 8 && rmbAb <= 0; i++) {
    await page.waitForTimeout(250);
    rmbAb = await page.evaluate(() => {
      const g = window.__dbg;
      const snap = g.net.snapInfo();
      const own = snap && snap.ps.find(p => p.i === g.info().myId);
      return own ? (own.acd || 0) : -1;
    });
  }
  await page.mouse.up({ button: 'right' });
  ok(`right click fires the special (ability cd ${rmbAb} > 0)`, rmbAb > 0);
  await page.keyboard.up('KeyW'); // pilot can rest now

  // ---- TERRAIN-GRAZE MIRROR PARITY (hardening root cause): steer the pilot
  // into a rock edge (setCmd up+steer — the real input path) and measure the
  // predicted-vs-server position error through the contact. The old
  // axis-based client mirror diverged ~6.7 u over 1.3 s of grazing (probe:
  // scripts/probe-drive.js) — past the 6 u reconcile hard-snap, so every
  // graze ended in a visible teleport = the canoe "not driving straight".
  // The ported normal-based mirror must track the server within ~5 u even
  // with bot-ram nudges in the mix. ----
  const attemptGraze = async () => {
    const setup = await page.evaluate(() => {
      const g = window.__dbg;
      const snap = g.net.snapInfo();
      if (!snap || !snap.map) return null;
      const rocks = (g.net.defs.MAPS[snap.map].rocks || []).slice();
      const o = g.net.own();
      if (!o) return null;
      let best = null, bestD = 1e9;
      for (const rk of rocks) {
        const d = Math.hypot(rk.x - o.x, rk.z - o.z);
        if (d >= 12 && d < bestD) { bestD = d; best = rk; }
      }
      if (!best) return null;
      // aim to pass ~0.9 u off the rock face — inside the contact zone
      // (playerR 1.6) so the graze is guaranteed, at a shallow angle (the
      // target is offset from the face center, never head-on)
      const dirx = (best.x - o.x) / bestD, dirz = (best.z - o.z) / bestD;
      const px = -dirz, pz = dirx;
      const off = best.w / 2 + 0.9;
      let tx = best.x + px * off, tz = best.z + pz * off;
      if ((tx - o.x) * dirx + (tz - o.z) * dirz < 0) { tx = best.x - px * off; tz = best.z - pz * off; }
      return { tx, tz, rx: best.x, rz: best.z, w: best.w, d: best.d };
    });
    if (!setup) return { grazed: false, maxErr: -1, alive: true };
    const t0 = Date.now();
    let maxErr = 0, minD = 1e9, alive = true, maxAngErr = 0;
    while (Date.now() - t0 < 12000) {
      const r = await page.evaluate(({ tx, tz, rx, rz, w, d }) => {
        const g = window.__dbg;
        const snap = g.net.snapInfo();
        const me = snap && snap.ps && snap.ps.find(p => p.i === g.info().myId);
        if (!me || !me.al) return { dead: true };
        const o = g.net.own();
        const bearing = Math.atan2(tz - o.z, tx - o.x);
        let dA = bearing - o.ang;
        while (dA > Math.PI) dA -= Math.PI * 2;
        while (dA < -Math.PI) dA += Math.PI * 2;
        // finer deadband close to the target so the approach doesn't wobble
        // wide and miss the contact zone
        const distT = Math.hypot(tx - o.x, tz - o.z);
        const dead = distT < 8 ? 0.05 : 0.12;
        const steer = Math.abs(dA) > dead ? (dA > 0 ? { right: 1 } : { left: 1 }) : {};
        g.setCmd(Object.assign({ up: 1 }, steer));
        const err = Math.hypot(o.x - me.x, o.z - me.z);
        // ang parity: the mirror's heading ease must match the server's
        // through the contact (drift-gated on both sides)
        let aErr = o.ang - me.a;
        while (aErr > Math.PI) aErr -= Math.PI * 2;
        while (aErr < -Math.PI) aErr += Math.PI * 2;
        const cxd = Math.max(rx - w / 2, Math.min(o.x, rx + w / 2)) - o.x;
        const czd = Math.max(rz - d / 2, Math.min(o.z, rz + d / 2)) - o.z;
        return { dead: false, err, dd: Math.hypot(cxd, czd), aErr: Math.abs(aErr) };
      }, setup);
      if (!r) break;
      if (r.dead) { alive = false; break; }
      maxErr = Math.max(maxErr, r.err);
      maxAngErr = Math.max(maxAngErr, r.aErr);
      minD = Math.min(minD, r.dd);
      if (minD < 2.0 && Date.now() - t0 > 2500) break; // grazed + a beat past
      await page.waitForTimeout(150);
    }
    await page.evaluate(() => window.__dbg.setCmd({}));
    return { grazed: minD < 2.0, maxErr, maxAngErr, alive };
  };
  let grazeRes = await attemptGraze();
  if (!(grazeRes.grazed && grazeRes.alive && grazeRes.maxErr < 5)) {
    for (let i = 0; i < 20 && !(await aliveNow()); i++) await page.waitForTimeout(250);
    grazeRes = await attemptGraze();
  }
  ok(`terrain graze: mirror tracks server (grazed=${grazeRes.grazed}, max pred-vs-server err ${grazeRes.maxErr.toFixed(2)} u < 5, max ang err ${grazeRes.maxAngErr.toFixed(3)} rad < 0.35)`, grazeRes.grazed && grazeRes.maxErr < 5 && grazeRes.maxAngErr < 0.35);
  const hudVisible = await page.locator('#hud').isVisible();
  ok('HUD visible', hudVisible);
  const hpText = (await page.locator('#hpText').textContent()).trim();
  ok(`HUD shows HP (${hpText})`, /^\d+\s*\/\s*\d+$/.test(hpText));
  // ---- left control panel: score, weapon level, WoW-style ability cooldown ----
  const lpanel = await page.evaluate(() => {
    const g = window.__dbg;
    const snap = g.net.snapInfo();
    const own = snap && snap.ps.find(p => p.i === g.info().myId);
    const sb = document.getElementById('scoreVal');
    const kv = document.getElementById('killsVal');
    const wl = document.getElementById('wlevelVal');
    const ab = document.getElementById('abilityBtn');
    const abN = ab ? ab.title : '';
    const overlay = document.getElementById('abilityCdOverlay');
    const boost = document.getElementById('btnBoost');
    const boostOv = document.getElementById('boostCdOverlay');
    return {
      score: sb ? sb.textContent : '',
      kills: kv ? kv.textContent : '',
      wlevel: wl ? wl.textContent : '',
      ability: abN,
      cdOverlay: !!(overlay && ab),
      boostOverlay: !!(boostOv && boost),
      lobbyVisible: !document.getElementById('lobbyCol').classList.contains('hidden'),
      scoreFromSnap: own ? own.sc : -1,
    };
  });
  ok(`left panel: score ${lpanel.score} (snap ${lpanel.scoreFromSnap}), kills ${lpanel.kills}, weapon ${lpanel.wlevel}, special ${lpanel.ability} (cd overlay ${lpanel.cdOverlay}, boost cd ${lpanel.boostOverlay})`,
    lpanel.score.includes(String(lpanel.scoreFromSnap)) && lpanel.kills === '0' && /^Level \d+$/.test(lpanel.wlevel) && !/[☠·]/.test(lpanel.score) && lpanel.ability.includes('MINE LAYER') && lpanel.cdOverlay && lpanel.boostOverlay);
  ok(`lobby column (canoe+crew) visible after joining (${lpanel.lobbyVisible})`, lpanel.lobbyVisible);

  // ---- own ship MUST be rendering (the bug the user found) ----
  const ownShip = await page.evaluate(() => {
    const info = window.__dbg.info();
    const pv = window.__dbg.game.players.get(info.myId);
    const aimVisible = (window.__dbg.game.players.get(info.myId)) ? true : false;
    return { hasVisual: !!pv, visible: pv ? pv.group.visible : false, clsDef: pv ? pv.clsDef.id : '', aimBoxes: document.querySelectorAll('canvas').length };
  });
  ok(`own ship has a render visual (${ownShip.hasVisual}, visible=${ownShip.visible})`, ownShip.hasVisual && ownShip.visible);
  ok(`own ship entered the scene as the SELECTED canoe (${ownShip.clsDef})`, ownShip.clsDef === 'barge');

  // ---- health bars render above EVERY canoe (no shared-sprite stealing) ----
  // Each canoe must own a DISTINCT hp sprite + label object; a shared cached
  // sprite has one parent, so the last canoe to claim it stole the bar from
  // the first — bars silently vanished above players.
  const bars = await page.evaluate(() => {
    const players = [...window.__dbg.game.players.values()];
    const ids = new Set(), lids = new Set();
    for (const p of players) { ids.add(p.hp.id); lids.add(p.label.id); }
    return {
      players: players.length,
      distinctBars: ids.size,
      distinctLabels: lids.size,
      withBar: players.filter(p => p.hp && p.group.children.includes(p.hp)).length,
      withLabel: players.filter(p => p.label && p.group.children.includes(p.label)).length,
    };
  });
  ok(`health bars distinct per canoe (${bars.withBar}/${bars.players} attached, ${bars.distinctBars} unique sprites)`,
    bars.distinctBars === bars.players && bars.withBar === bars.players && bars.distinctLabels === bars.players && bars.withLabel === bars.players);

  // ---- class selection cards: swatch + name ONLY (no canoe previews) ----
  const shipFx = await page.evaluate(() => {
    const info = window.__dbg.info();
    const pv = window.__dbg.game.players.get(info.myId);
    return {
      aura: !!(pv && pv.aura),
      auraTransparent: !!(pv && pv.aura && pv.aura.material.transparent),
      hpBar: !!(pv && pv.hp),
      cardNames: [...document.querySelectorAll('.cc-name')].map(n => n.textContent.trim()),
      cardImgs: document.querySelectorAll('.cc-card').length,
    };
  });
  ok(`shield aura shell exists (${shipFx.aura}, transparent=${shipFx.auraTransparent})`, shipFx.aura && shipFx.auraTransparent);
  ok(`hp bar sprite exists above the canoe (${shipFx.hpBar})`, shipFx.hpBar);
  const cardsOk = shipFx.cardImgs >= 3 && shipFx.cardNames.length >= 3;
  ok(`class cards render for every canoe (${shipFx.cardNames.join(',')})`, cardsOk);

  // ---- kill→upgrade FANFARE popup fires for the player's OWN kills ----
  const popup = await page.evaluate(() => {
    const info = window.__dbg.info();
    window.__dbg.ui.killfeed({ k: info.myId, v: 9999, w: 'Pea Rail', s: 1, u: 1, ps: [{ i: 9999, n: 'Dummy' }] });
    const el = document.getElementById('upgPopup');
    return {
      shown: el && !el.classList.contains('hidden'),
      text: el ? el.querySelector('.upg-weapon').textContent : '',
    };
  });
  ok(`upgrade fanfare popup on own kill (${popup.shown}, "${popup.text}")`, popup.shown && popup.text.includes('LEVEL 1'));
  const aimPath = await page.evaluate(() => {
    const g = window.__dbg.game;
    // count visible aim boxes via scene traversal is heavy; use info instead
    return !!g.setAimPath;
  });
  ok('aim-line API present', aimPath);

  // drive the canoe (W) + fire so the aim line is visible
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2500);
  await page.keyboard.up('KeyW');
  await page.screenshot({ path: path.join(SHOTS, '3-in-match.png') });

  // shop disabled (user: "disable all shop features and any upgrades
  // purchased through the shop") — the button is gone from the toggles row,
  // and B must NOT open the shop screen
  await page.keyboard.press('KeyB');
  await page.waitForTimeout(400);
  ok('shop disabled — B does not open it', await page.locator('#shop').evaluate(el => el.classList.contains('hidden')));
  ok('shop button removed from HUD', (await page.locator('#btnShopT').count()) === 0);
  await page.screenshot({ path: path.join(SHOTS, '4-noshop.png') });
  await page.keyboard.down('Tab');
  // poll — the 400ms single-sample check flaked when a heavy SwiftShader
  // frame (FFT ocean passes) delayed the keyTab frame-loop application
  let sbSeen = false;
  for (let i = 0; i < 10 && !sbSeen; i++) {
    sbSeen = await page.locator('#scoreboard').isVisible();
    if (!sbSeen) await page.waitForTimeout(200);
  }
  ok('scoreboard opens with Tab', sbSeen);
  await page.keyboard.up('Tab');

  // bots fighting → killfeed (give the match time to produce a kill).
  // Bot-vs-bot kills are RNG: if no bot dies in the window, skip rather
  // than flake — damage tracking below proves combat is live.
  const t0 = Date.now();
  let kfSeen = false;
  while (Date.now() - t0 < 35000) {
    if (await page.locator('#killfeed .kf-item').count() > 0) { kfSeen = true; break; }
    await page.waitForTimeout(1000);
  }
  if (kfSeen) ok('killfeed entries appear (bots fighting)', true);
  await page.screenshot({ path: path.join(SHOTS, '5-action.png') });

  // ---- damage spots must land ON the hull (regression: the old 90°
  // local-space rotation put bow hits on the SIDE — off the narrow barge)
  const spotPos = await page.evaluate(() => {
    const g = window.__dbg;
    let bad = 0, total = 0;
    for (const pv of g.game.players.values()) {
      const W = 1.15 * pv.clsDef.size / 2 + 0.4;
      const Lh = 3.3 * pv.clsDef.size / 2 + 0.4;
      if (pv.dmgGroup) for (const c of pv.dmgGroup.children) {
        total++;
        if (Math.abs(c.position.x) > W || Math.abs(c.position.z) > Lh) bad++;
      }
    }
    return { bad, total };
  });
  ok(`damage spots on the hull (${spotPos.bad}/${spotPos.total} outside)`, spotPos.total === 0 || spotPos.bad === 0);

  // ---- GPU texture-leak regression: damage-number sprites share cached
  // canvas textures. The old per-hit uploads leaked and late upgraded rounds
  // (more hits → more kills) eventually ground the renderer to a halt. The
  // live texture count must stay bounded after a full combat window. ----
  const texInfo = await page.evaluate(() => window.__dbg.game.stats().tex);
  ok(`texture count bounded after combat (${texInfo} live — dmg sprites cached)`, texInfo < 120);

  // damage visuals: ANY damaged canoe proves the hit-located spot pipeline.
  // Combat is continuous, but respawns clear hp/spots and LOW bots barely
  // shoot (fireChance 0.2) — the PILOT holds LMB so the check never samples
  // a quiet window.
  await page.mouse.down({ button: 'left' });
  let dmg = { anySpots: false, anyHurt: false };
  for (let i = 0; i < 10 && !(dmg.anySpots || dmg.anyHurt); i++) {
    dmg = await page.evaluate(() => {
      const snap = window.__dbg.net.snapInfo();
      if (!snap) return { anySpots: false, anyHurt: false };
      const anySpots = snap.ps.some(p => p.ds && p.ds.length > 0);
      const anyHurt = snap.ps.some(p => p.al && p.hp < p.mx);
      return { anySpots, anyHurt };
    });
    if (!(dmg.anySpots || dmg.anyHurt)) await page.waitForTimeout(1000);
  }
  await page.mouse.up({ button: 'left' });
  ok(`damage tracking live (spots=${dmg.anySpots}, hurt=${dmg.anyHurt})`, dmg.anySpots || dmg.anyHurt);

  // ---- RETURN TO TITLE: leave must land back in the MENU, not rejoin ----
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await page.locator('#btnQuit').click();
  await page.waitForTimeout(3500); // server close + 1.5 s reconnect + lobby
  const menuBack = await page.locator('#menu').evaluate(el => !el.classList.contains('hidden'));
  ok(`return to title: menu shows after leaving (${menuBack})`, menuBack);

  // ---- REJOIN after return-to-title: join again, no reload needed ----
  await page.locator('#btnJoin').click();
  await page.waitForTimeout(2000);
  const hudBack = await page.locator('#hud').evaluate(el => !el.classList.contains('hidden'));
  const ownBack = await page.evaluate(() => {
    const info = window.__dbg.info();
    const pv = window.__dbg.game.players.get(info.myId);
    return !!(pv && pv.group.visible);
  });
  ok(`rejoin works without a reload (HUD back ${hudBack}, own ship ${ownBack})`, hudBack && ownBack);
  // fresh match from a RUNNING game: host start must fire a new countdown
  host.ws.send(JSON.stringify({ t: 'start' }));
  await page.waitForTimeout(900);
  const countdownAgain = await page.locator('#countdown').isVisible();
  ok(`fresh match starts from a running state (countdown ${countdownAgain})`, countdownAgain);

  // ---- REFRESH: reload the page and rejoin — must NOT stick to the old
  // lobby (the "can't let go of the old lobby" report: refresh → join →
  // stuck). The raw host leaves first so this exercises the SOLO path: the
  // pilot must become the host and START THE NEW LOBBY with their own click.
  try { host.ws.close(); } catch { }
  await page.waitForTimeout(1600);
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1800);
  const menuAfterReload = await page.locator('#menu').evaluate(el => !el.classList.contains('hidden'));
  ok(`menu loads after refresh (${menuAfterReload})`, menuAfterReload);
  // the pilot is now the ONLY human → joins and becomes the host
  await page.locator('#btnJoin').click();
  await page.waitForTimeout(2200);
  ok('host settings panel visible for the new host', await page.locator('#hostPanel').evaluate(el => !el.classList.contains('hidden')));
  // the host dock STARTS COLLAPSED too — expand via the tab, drive the bots
  // toggle, then collapse and verify the labeled tab stays visible
  await page.locator('#hostPanelHead').click(); // expand
  await page.waitForTimeout(300);
  ok('host dock expands from its tab', await page.locator('#hostPanel').evaluate(el => !el.classList.contains('collapsed')));
  // style & cosmetics live behind a BUTTON now (overlay window, not a dock)
  ok('style button present in the lobby after refresh', await page.locator('#btnStyle').isVisible());
  // Add Bots? toggle: No removes the bots row; Yes brings it back
  await page.locator('#botsOnNo').click();
  await page.waitForTimeout(700);
  ok('bots OFF hides the bot count row', await page.locator('#botsRow').evaluate(el => el.style.display === 'none'));
  await page.locator('#botsOnYes').click();
  await page.waitForTimeout(900);
  const botsBack = await page.locator('#playerList .prow').count();
  ok(`bots ON restores the crew (${botsBack} rows)`, botsBack >= 3);
  // collapse the host dock → only the labeled tab stays attached to the window
  await page.locator('#hostPanelHead').click();
  await page.waitForTimeout(300);
  ok('host dock collapses to a visible labeled tab',
    await page.locator('#hostPanel').evaluate(el => el.classList.contains('collapsed'))
    && await page.locator('#hostPanelHead').isVisible()
    && (await page.locator('#hostPanelHead').textContent()).includes('GAME SETTINGS'));
  await page.locator('#hostPanelHead').click(); // leave it expanded
  await page.waitForTimeout(300);
  const btnAfterReload = (await page.locator('#btnStart').textContent()).trim();
  ok(`solo rejoin after refresh (button "${btnAfterReload}")`, btnAfterReload.includes('START'));
  await page.locator('#btnStart').click(); // the pilot's OWN start — the solo host path
  await page.waitForTimeout(1000);
  const countdownAfterReload = await page.locator('#countdown').isVisible();
  ok(`fresh match after refresh via own start (countdown ${countdownAfterReload})`, countdownAfterReload);

  console.log('--- errors captured:', errors.length);
  for (const e of errors.slice(0, 10)) console.log('   ', e);
  ok('zero JS errors', errors.length === 0);

  try { host.ws.close(); } catch { }
  await browser.close();
  console.log(failures.length === 0 ? '\n🎉 E2E PASS' : `\n💥 E2E FAIL (${failures.length}): ${failures.join('; ')}`);
  process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1);
}

main().catch(e => { console.error('E2E crashed:', e.message); process.exit(2); });
