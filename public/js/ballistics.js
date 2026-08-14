'use strict';
// ============================================================
// CANOE ARENA — client ballistic solver.
// MUST mirror server/game.js solvePitch() exactly.
// ============================================================
export const MUZZLE_Y = 0.6;
export const GRAVITY = 24;
export const PLAYER_CENTER_Y = 0.45;

// Volumetric swell — MUST match server/game.js waveH() and the water shader's
// primary octaves in render.js. ±~1.28 so crests genuinely read as waves.
export function waveH(x, z, t) {
  // 08-13: octave amps ×1.25 → max ~±3.5 (user: "increase wave magnitude
  // instead of volume of waves" — same 6 octaves, taller). KEEP IN SYNC
  // with server/game.js + the WATER_VERT fallback in render.js.
  const w = Math.sin(x * 0.045 + t * 0.7) * 0.8
          + Math.sin(z * 0.055 + t * 0.85) * 0.65
          + Math.sin(x * 0.10 + t * 1.1) * 0.55
          + Math.sin(z * 0.08 + t * 0.9) * 0.45
          + Math.sin((x + z) * 0.05 + t * 0.6) * 0.35
          + Math.sin(x * 0.31 + z * 0.19 + t * 2.7) * 0.28;
  return w * 1.125;
}

// Solve launch pitch (radians) to hit horizontal distance d with
// vertical drop `drop` (targetY - muzzleY). high = high-arc solution.
// Returns null when unreachable.
export function solvePitch(d, drop, speed, high = false, grav = GRAVITY) {
  if (d < 0.001) return high ? Math.PI / 4 : 0;
  const A = (grav * d * d) / (2 * speed * speed);
  const disc = d * d - 4 * A * (A + drop);
  if (disc < 0) return null;
  const u = high
    ? (d + Math.sqrt(disc)) / (2 * A)
    : (d - Math.sqrt(disc)) / (2 * A);
  return Math.atan(u);
}
