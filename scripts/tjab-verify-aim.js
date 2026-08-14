// TJAB ground-truth check for the barge aim window ("fixed range, can't pull
// the reticle closer"). The old `high: 1` solve lobbed EVERY shot at the
// clamped maxPitch (~60°) → fixed ~435 u landing, and the 1.6 s aim-path cap
// pinned the reticle at ~176 u. This verifies:
//   1. the yellow impact X moves WITH the cursor (close aim → close X)
//   2. firing at close aim spawns shells at the close-solve pitch, NOT the
//      maxPitch clamp (read the snap's pr[].p — spawn field, never velocity)
const RPC = 'http://127.0.0.1:4701/rpc';
async function rpc(method, params, session) {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, session } }),
  });
  const body = await res.json();
  if (body.error) throw new Error(method + ': ' + JSON.stringify(body.error));
  return body.result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let sid = null;
(async () => {
  const { id } = await rpc('session.new', { url: 'http://localhost:3000', width: 1280, height: 720 });
  sid = id;
  console.log('session', id);
  // PROVEN boot (matches scripts/tjab-debug-snap.js which reaches play):
  // single unconditional join, no admin/reset (it kills this page's WS),
  // poll the FULL snap object (bare-value evals were flaky through RPC).
  await rpc('eval.js', { code: 'window.__dbg.join(); return 1;' }, id);
  await sleep(2000);
  console.log('joined:', JSON.stringify(await rpc('eval.js', { code: 'return ({ myId: window.__dbg.state.myId, joined: window.__dbg.state.joined });' }, id)));
  await rpc('eval.js', { code: 'window.__dbg.net.setClass("barge"); return 1;' }, id);
  await sleep(400);
  await fetch('http://localhost:3000/admin/start', { method: 'POST' });
  let inPlay = false;
  for (let i = 0; i < 24; i++) {
    await sleep(700);
    const s = await rpc('eval.js', { code: 'return (window.__dbg.net.snapInfo());' }, id);
    if (s && s.ph === 'play') { inPlay = true; break; }
  }
  if (!inPlay) throw new Error('never reached play (leaking session avoided)');
  console.log('in play');

  // aim sweep: cursor Y up the screen = aim farther out on the water
  const ys = [640, 600, 560, 520, 480, 440, 400, 370, 340];
  for (const y of ys) {
    await rpc('input.move', { to: [640, y] }, id);
    await sleep(1300); // turret pitch convergence + snap round-trip
    const info = await rpc('eval.js', {
      code: `return (() => {
        const sn = window.__dbg.net.snapInfo();
        const myId = window.__dbg.state.myId;
        const me = sn && sn.ps ? sn.ps.find(p => p.i === myId) : null;
        if (!me) return { err: 'no own' };
        let x = null;
        const v = new THREE.Vector3();
        window.__dbg.game.scene.traverse(o => {
          if (x !== null || !o.visible || !o.material || !o.material.color) return;
          const g = o.geometry;
          if (o.material.color.getHexString() === 'ffd23f' && g && g.parameters && g.parameters.width === 1.4 && g.parameters.depth === 0.16) {
            o.getWorldPosition(v);
            x = { x: v.x, z: v.z };
          }
        });
        const d = x ? Math.hypot(x.x - me.x, x.z - me.z) : -1;
        return { xDist: Math.round(d), tpDeg: +(me.tp * 57.3).toFixed(1) };
      })()`,
    }, id);
    console.log('aimY', y, JSON.stringify(info));
  }

  // fire at CLOSE aim; read the snap projectile spawn pitch (ground truth)
  await rpc('input.move', { to: [640, 640] }, id);
  await sleep(1400);
  // hold LMB through a small drag (a close shell is airborne only ~0.12 s)
  await rpc('input.drag', { from: [640, 640], to: [642, 640], steps: 6, durationMs: 220, button: 'left' }, id);
  await sleep(80);
  const fire = await rpc('eval.js', {
    code: `return (() => {
      const sn = window.__dbg.net.snapInfo();
      const myId = window.__dbg.state.myId;
      const own = sn && sn.pr ? sn.pr.filter(q => q.o === myId && q.k === 'cannon') : [];
      const last = own[own.length - 1];
      return { shellPitchDeg: last ? +(last.p * 57.3).toFixed(1) : null, shells: own.length };
    })()`,
  }, id);
  console.log('close-aim fire', JSON.stringify(fire));

  await rpc('session.close', {}, id).catch(() => {});
  const d = fire && fire.shellPitchDeg !== null ? fire.shellPitchDeg : 999;
  console.log(d < 30 && d > -40 ? '✅ TJAB: CLOSE AIM FIRES LOW (not clamped at 60°)' : '❌ TJAB: SHELL PITCH STILL CLAMPED');
})().catch(async (e) => {
  // never leak a session — a stale session holds the lobby as an AFK host
  if (sid) await rpc('session.close', {}, sid).catch(() => {});
  console.error('FAIL', e.message);
  process.exit(1);
});
