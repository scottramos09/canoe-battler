'use strict';
// ============================================================
// CANOE ARENA — input: WASD + mouse aim + firing
// ============================================================
import * as THREE from 'three';

const keys = new Set();
const mouse = { x: 0, y: 0, down: [false, false] };

// debug override: window-level injected command (used by QA harness)
let dbgCmd = null;
export function setDbgCmd(c) { dbgCmd = c; }

const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const raycaster = new THREE.Raycaster();
const hit = new THREE.Vector3();
let cam = null, dom = null;

// typing in a form field must never drive the game: skip ALL game key
// handling while an input/textarea is focused (Tab moves between the login
// fields instead of opening the scoreboard, W doesn't steer while chatting…)
const typing = (e) => e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);

export function initInput(camera, domEl) {
  cam = camera; dom = domEl;
  window.addEventListener('keydown', (e) => {
    if (typing(e)) return;
    if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    actDev = 'kbm'; actIdle = 0;
    if (e.code === 'Tab') onScoreboard(true);
    if (e.code === 'KeyM') onMute && onMute();
  });
  window.addEventListener('keyup', (e) => {
    keys.delete(e.code);
    if (e.code === 'Tab' && !typing(e)) onScoreboard(false);
  });
  window.addEventListener('blur', () => keys.clear());
  window.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; actDev = 'kbm'; actIdle = 0; });
  window.addEventListener('mousedown', (e) => { if (e.button <= 2) mouse.down[e.button] = true; });
  window.addEventListener('mouseup', (e) => { if (e.button <= 2) mouse.down[e.button] = false; });
  domEl.addEventListener('contextmenu', (e) => e.preventDefault());
}

export function setCallbacks(cb) { onScoreboard = cb.scoreboard || (() => {}); onMute = cb.mute || (() => {}); }
let onScoreboard = () => {}, onMute = () => {};

// compute aim angle from mouse ray → water plane, relative to canoe pos
export function computeAim(canoeX, canoeZ) {
  // the ray needs NORMALIZED device coords (-1..1); `mouse` holds client px
  const nx = (mouse.x / window.innerWidth) * 2 - 1;
  const ny = -(mouse.y / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(new THREE.Vector2(nx, ny), cam);
  if (raycaster.ray.intersectPlane(plane, hit)) {
    const A = 99;
    const cx = Math.max(-A, Math.min(A, hit.x));
    const cz = Math.max(-A, Math.min(A, hit.z));
    return { aim: Math.atan2(cz - canoeZ, cx - canoeX), worldX: cx, worldZ: cz };
  }
  return null;
}

// ---------------- gamepad ----------------
const GP_DEAD = 0.3;
// stick auto-centering: worn controllers rest off-center; sample the resting
// position when the stick sits still and subtract it — kills drift bias forever
let gpCenter = { x: 0, y: 0 };
let gpRestT = 0;
// right-stick axis detection: 'standard' mapping → axes [2,3]; some pads
// (XInput raw / wrappers) report it on [4,5]. Auto-swap to the alternate
// pair when the primary has been dead for 1.5 s and the alternate is live.
let gpRsUseAlt = false, gpRsPrimT = 0, gpRsAltT = 0;
// active input device for the dynamic control tips
let actDev = 'kbm', actIdle = 0;
export function getGamepad() {
  try {
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const g of gps) if (g && g.connected) return g;
  } catch { /* no gamepad API */ }
  return null;
}
function gpBtn(gp, i) {
  const b = gp.buttons[i];
  return b ? (b.pressed || b.value > 0.4) : false;
}

export function getInputState(ownPos, camYaw = 0) {
  const dbg = dbgCmd;
  let up = keys.has('KeyW') || keys.has('ArrowUp') || (dbg && dbg.up);
  let down = keys.has('KeyS') || keys.has('ArrowDown') || (dbg && dbg.down);
  let left = keys.has('KeyA') || keys.has('ArrowLeft') || (dbg && dbg.left);
  let right = keys.has('KeyD') || keys.has('ArrowRight') || (dbg && dbg.right);
  let boost = keys.has('ShiftLeft') || keys.has('ShiftRight') || (dbg && dbg.boost);
  let jump = keys.has('Space') || (dbg && dbg.jump);
  let fire1 = mouse.down[0] || (dbg && dbg.fire1);
  // fire2 (secondary weapon) lives on Q — RIGHT CLICK is the SPECIAL
  let fire2 = keys.has('KeyQ') || (dbg && dbg.fire2);
  let ab = mouse.down[2] || keys.has('KeyE') || (dbg && dbg.ab);
  let gpAim = null;
  let st = undefined;

  // gamepad: left stick drives (ANALOG steering), right stick aims, triggers fire, bumpers boost/ability
  const gp = getGamepad();
  let gpActive = false;
  let gpAimTurn = 0; // +1 = rotate aim right, -1 = left (continuous while held)
  let gpPitch = undefined;
  if (gp) {
    // auto-center the resting stick position (drift killer)
    const rawX = gp.axes[0] || 0, rawY = gp.axes[1] || 0;
    if (Math.hypot(rawX, rawY) < 0.1) {
      gpRestT += 1 / 60;
      if (gpRestT > 0.6) { gpCenter = { x: rawX, y: rawY }; gpRestT = 0; }
    } else gpRestT = 0;
    const ax = rawX - gpCenter.x, ay = rawY - gpCenter.y;
    // right-stick axes: standard mapping → [2,3]; auto-swap to [4,5] for
    // XInput-raw pads (triggers on standard pads can't hijack — the swap
    // only happens after the primary pair has been dead for 1.5 s)
    const std = gp.mapping === 'standard';
    const px = gp.axes[std ? 2 : 4] || 0, py = gp.axes[std ? 3 : 5] || 0;
    const altX = gp.axes[std ? 4 : 2] || 0, altY = gp.axes[std ? 5 : 3] || 0;
    const tNow = performance.now();
    if (Math.hypot(px, py) > 0.3) gpRsPrimT = tNow;
    if (Math.hypot(altX, altY) > 0.3) gpRsAltT = tNow;
    if (!gpRsUseAlt && gpRsAltT > gpRsPrimT && tNow - gpRsPrimT > 1500) gpRsUseAlt = true;
    if (gpRsUseAlt && gpRsPrimT > gpRsAltT && tNow - gpRsAltT > 1500) gpRsUseAlt = false;
    const rx = gpRsUseAlt ? altX : px, ry = gpRsUseAlt ? altY : py;
    // device normalization: the gamepad OWNS movement when actively used
    gpActive = Math.hypot(ax, ay) > GP_DEAD || Math.hypot(rx, ry) > 0.2 ||
      [0, 1, 2, 3, 4, 5, 6, 7, 9].some(i => gpBtn(gp, i));
    if (gpActive) {
      // keyboard movement zeroed — no more mixed-input weirdness
      up = down = left = right = boost = ab = jump = false;
      if (ay < -GP_DEAD) up = true;
      if (ay > GP_DEAD) down = true;
      if (Math.abs(ax) > GP_DEAD) {
        st = Math.max(-1, Math.min(1, (ax - Math.sign(ax) * GP_DEAD) / (1 - GP_DEAD)));
        left = ax < -0.6; right = ax > 0.6;
      }
    }
    // right stick aim: camera-relative direction (stick up = screen up = heading)
    // worldAng = camYaw + atan2(rx, -ry)  (screen-right = heading+90°)
    // Yaw and pitch have INDEPENDENT deadzones: a weak stick axis still
    // drives its own channel (direction for yaw, magnitude for elevation).
    // CARDINAL-ONLY aim: the right stick never mixes axes — the dominant
    // direction wins. Horizontal pushes ROTATE the aim continuously while
    // held (full 360°); vertical pushes move elevation with PROPORTIONAL
    // deflection (small push = small, precise elevation change).
    if (Math.hypot(rx, ry) > 0.25) {
      if (Math.abs(rx) >= Math.abs(ry)) {
        gpAimTurn = rx > 0 ? 1 : -1;
      } else {
        gpPitch = -ry; // raw magnitude: -1..1, POSITIVE = aim UP (stick up = -1 → +1)
      }
    }
    fire1 = fire1 || gpBtn(gp, 7);                  // RT
    fire2 = fire2 || gpBtn(gp, 6);                  // LT
    boost = boost || gpBtn(gp, 5);                  // RB
    ab = ab || gpBtn(gp, 4);                        // LB
    jump = jump || gpBtn(gp, 0);                    // A
    // device detection for the dynamic control tips (hysteresis: a resting
    // controller doesn't flip the sheet; 3 s idle flips back to kbm)
    if (gpActive) { actDev = 'gamepad'; actIdle = 0; }
    else { actIdle += 1 / 60; if (actIdle > 3) actDev = 'kbm'; }
  }

  let aim = ownPos ? (computeAim(ownPos.x, ownPos.z) || { aim: ownPos.a }).aim : 0;
  if (dbg && typeof dbg.aim === 'number') aim = dbg.aim;
  return { up, down, left, right, boost, fire1, fire2, ab, jump, aim, gpAim, gpAimTurn, gpPitch, st };
}

// which input device the control tips should show (updated live)
export function getActiveDevice() { return actDev; }

// controller diagnostics for remote debugging (window.__dbg.gp())
export function gpDebug() {
  try {
    const g = getGamepad();
    if (!g) return null;
    return { mapping: g.mapping, axes: Array.from(g.axes, v => +(+v).toFixed(2)), useAlt: gpRsUseAlt };
  } catch { return null; }
}

export function mouseScreen() { return { x: mouse.x, y: mouse.y }; }
