// ============================================================
// SceneProof inspector: builds the REAL canoe-arena scene from
// production source (public/js/render.js) with a declared fixture
// state — 6 canoes across all classes & weapon tiers, in-flight
// projectiles, crates, on map "Box Lagoon".
// ============================================================
import { createGame, setPaintDefs } from '../../public/js/render.js';
import { CLASSES, MAPS } from '../../server/defs.js';
import { PAINTS } from '../../public/js/profile.js';

export function createArenaEvidence() {
  setPaintDefs(PAINTS);
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const g = createGame(canvas);
  g.setMap(MAPS.lagoon);

  const setups = [
    { id: 1, cls: 'razorfin', name: 'Razor', cs: { paint: 'lagoon', figurehead: 'skull', flag: 'skull', trail: 'none' }, x: -40, z: 20, yaw: 0.7, ty: 0.7, tp: 0.22, w: [4, 4, 2], hp: 140 },
    { id: 2, cls: 'barge', name: 'Thunder', cs: { paint: 'royal', figurehead: 'dragon', flag: 'bolt', trail: 'embers' }, x: 35, z: -25, yaw: -2.6, ty: -2.6, tp: 0.6, w: [4, 4, 3], hp: 250 },
    { id: 3, cls: 'rocket', name: 'Scrap', cs: { paint: 'sunset', figurehead: 'phoenix', flag: 'anchor', trail: 'frost' }, x: 5, z: 45, yaw: 2.9, ty: 2.9, tp: 0.3, w: [3, 2, 1], hp: 180 },
    { id: 4, cls: 'razorfin', name: 'Pea', cs: { paint: 'classic', figurehead: 'none', flag: 'plain', trail: 'none' }, x: 55, z: 40, yaw: -1.2, ty: -1.2, tp: 0.05, w: [0, 0, 0], hp: 140 },
    { id: 5, cls: 'barge', name: 'Doom', cs: { paint: 'battle', figurehead: 'kraken', flag: 'crown', trail: 'toxic' }, x: -55, z: -35, yaw: 0.4, ty: 0.4, tp: 0.9, w: [4, 4, 4], hp: 250 },
    { id: 6, cls: 'rocket', name: 'Hoppin', cs: { paint: 'toxic', figurehead: 'shark', flag: 'star', trail: 'sparkle' }, x: -10, z: -40, yaw: 1.8, ty: 1.8, tp: 0.4, w: [2, 1, 2], hp: 180 },
  ];
  for (const s of setups) {
    g.upsertPlayer(s.id, { clsDef: CLASSES[s.cls], cosmetics: s.cs, name: s.name });
    g.applyPlayer(s.id, {
      x: s.x, y: s.id === 6 ? 3.4 : 0, z: s.z, vx: 8, vz: 2,
      yaw: s.yaw, ty: s.ty, tp: s.tp,
      hp: s.hp, maxHp: s.hp, alive: true, boost: s.id === 2, w: s.w, turn: 0,
    }, -1);
    // stable SceneProof ids for targeting
    const pv = g.players.get(s.id);
    pv.group.name = `canoe-${s.id}-${s.cls}`;
    pv.group.userData.sceneproofId = `canoe-${s.id}`;
  }

  // in-flight projectiles: mortar high-arc, rail, rocket, mine, torp, shot, bomblet
  g.syncProjectiles([
    { i: 1, x: -30, y: 3.5, z: 25, a: 0.7, p: 0.5, k: 'mortar', o: 2 },
    { i: 2, x: 42, y: 1.1, z: -20, a: -2.6, p: 0.06, k: 'rail', o: 2 },
    { i: 3, x: 12, y: 0.4, z: 42, a: 2.9, p: 0.1, k: 'rocket', o: 3 },
    { i: 4, x: 50, y: 0.4, z: 34, a: -1.2, p: 0, k: 'mine', o: 4 },
    { i: 5, x: -48, y: 0.5, z: -30, a: 0.4, p: 0, k: 'torp', o: 5 },
    { i: 6, x: -2, y: 0.4, z: -36, a: 1.8, p: 0.05, k: 'shot', o: 6 },
    { i: 7, x: 0, y: 6.5, z: 0, a: 0, p: 0, k: 'bomblet', o: 3 },
  ]);
  g.syncCrates([
    { i: 1, x: -25, z: -5, k: 'heal' },
    { i: 2, x: 25, z: 10, k: 'credits' },
    { i: 3, x: 0, z: 25, k: 'overclock' },
  ]);

  // broadcast-style evidence camera
  const cam = g.camera;
  cam.position.set(0, 55, 85);
  cam.lookAt(0, 0, 0);
  // settle a few frames so water time, bobbing, crate spin are live
  for (let i = 0; i < 4; i++) g.render(1 / 30);

  g.scene.name = 'arena';
  g.scene.userData.sceneproofId = 'arena';

  // IMPORTANT: return ONLY { scene, camera } — omitting the renderer lets
  // SceneProof create its own capture renderer/canvas (per three-fixtures.md).
  return { scene: g.scene, camera: g.camera };
}
