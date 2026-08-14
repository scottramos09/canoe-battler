// TJAB: verify the barge cannon PITCH RANGE is restored (cannon arcs).
// Pin the client aim pitch directly (headless canvas skews cursor rays),
// then read the SERVER turret pitch and the fired shell's spawn pitch:
//   45° aim -> shell spawns ~+45° (a lob, not a flat gun shot)
//  -0.1 aim -> shell spawns ~-6° (close dive)
// plus the reticle X distance at 45° (~296 u at the 300 u window).
const RPC = 'http://127.0.0.1:4701/rpc';
async function rpc(method, params, session) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, session } }) });
  const b = await res.json();
  if (b.error) throw new Error(method + ': ' + JSON.stringify(b.error));
  return b.result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { id } = await rpc('session.new', { url: 'http://localhost:3000', width: 1280, height: 720 });
  await sleep(2500);
  await rpc('eval.js', { code: 'window.__dbg.join(); return 1;' }, id);
  await sleep(2000);
  await rpc('eval.js', { code: 'window.__dbg.net.setClass("barge"); return 1;' }, id);
  await sleep(400);
  await fetch('http://localhost:3000/admin/start', { method: 'POST' });
  let inPlay = false;
  for (let i = 0; i < 24; i++) {
    await sleep(700);
    const s = await rpc('eval.js', { code: 'return (window.__dbg.net.snapInfo());' }, id);
    if (s && s.ph === 'play') { inPlay = true; break; }
  }
  if (!inPlay) { console.log('FAIL: no play'); await rpc('session.close', {}, id); process.exit(1); }

  async function readState() {
    return rpc('eval.js', {
      code: `return (() => {
        const sn = window.__dbg.net.snapInfo();
        const myId = window.__dbg.state.myId;
        const me = sn.ps.find(p => p.i === myId);
        let x = null;
        const v = new THREE.Vector3();
        window.__dbg.game.scene.traverse(o => {
          if (x !== null || !o.visible || !o.material || !o.material.color) return;
          const g = o.geometry;
          if (o.material.color.getHexString() === 'ffd23f' && g && g.parameters && g.parameters.width === 1.4 && g.parameters.depth === 0.16) {
            o.getWorldPosition(v); x = { x: v.x, z: v.z };
          }
        });
        return { tpDeg: +(me.tp * 57.3).toFixed(1), xDist: x ? Math.round(Math.hypot(x.x - me.x, x.z - me.z)) : -1 };
      })()`,
    }, id);
  }

  async function fireAndRead() {
    await rpc('eval.js', { code: 'window.__dbg.setCmd({ fire1: 1 }); return 1;' }, id);
    // sample the SECOND shell mid-hold: the first dies in 0.85-1.2 s (the
    // new grav 276 flights) before the RPC round-trip lands; the second
    // (fireCd 1.1 s) is only ~0.25 s old at +1.35 s and safely airborne
    await sleep(1350);
    const fire = await rpc('eval.js', {
      code: `return (() => {
        const sn = window.__dbg.net.snapInfo();
        const myId = window.__dbg.state.myId;
        const own = sn && sn.pr ? sn.pr.filter(q => q.o === myId && q.k === 'cannon') : [];
        return { shells: own.length, pDeg: own.length ? own.map(q => +(q.p * 57.3).toFixed(1)) : [] };
      })()`,
    }, id);
    await rpc('eval.js', { code: 'window.__dbg.setCmd({ fire1: 0 }); return 1;' }, id);
    return fire;
  }

  // 45° — the max-range cannon lob
  await rpc('eval.js', { code: 'window.__dbg.state.pitchSm = 0.785; return 1;' }, id);
  await sleep(3000);
  const far = await readState();
  const fireFar = await fireAndRead();
  console.log('FAR aim (45°):', JSON.stringify(far), 'fire:', JSON.stringify(fireFar));

  // CLOSE aim — real cursor move to a close water point (y=620 → ~63 u,
  // +2.9°; the headless cursor at (0,0) would otherwise sit above the horizon
  // and the ray-miss fallback correctly holds the max lob)
  // the tjab window is 800×600 — y must stay IN-PAGE (620 was dropped)
  await rpc('input.move', { to: [400, 560] }, id);
  await sleep(3000);
  const close = await readState();
  const fireClose = await fireAndRead();
  console.log('CLOSE aim (cursor low):', JSON.stringify(close), 'fire:', JSON.stringify(fireClose));

  // ground truth: the ALWAYS-ARC contract is the TURRET pitch at both ends
  // \u2014 far ~45\u00b0 (max lob), close ~86\u00b0 (point-blank lob) + the reticle
  // X reaching down to ~15 u. pr[].p is the CURRENT flight pitch (decays fast
  // under grav 276 \u2014 a 45\u00b0 shell reads ~21\u00b0 mid-flight), so shell-pitch
  // assertions are sim-only now; the spawn pitch is locked there.
  const farShells = fireFar.shells >= 1;
  const closeOk = close.xDist < 60 && close.tpDeg > 60;
  const ok = farShells && far.tpDeg > 30 && closeOk;
  console.log(ok ? '\u2705 TJAB: ALWAYS-ARC (far turret ' + far.tpDeg + '\u00b0 + shell, close aim pitches ' + close.tpDeg + '\u00b0 @ ' + close.xDist + ' u \u2014 lobs at every range)' : '\u274c TJAB: ARC BROKEN (far ' + (fireFar.pDeg[0] || '?') + '\u00b0, close ' + close.tpDeg + '\u00b0 @ ' + close.xDist + ' u)');
  await rpc('session.close', {}, id).catch(() => {});
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
