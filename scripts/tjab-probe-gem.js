// TJAB: is the ramp-top upgrade pickup rendering? Check the snap's up field,
// the mesh's existence/visibility/position, and any page errors.
const RPC = 'http://127.0.0.1:4701/rpc';
async function rpc(method, params, session) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, session } }) });
  const b = await res.json();
  if (b.error) throw new Error(method + ': ' + JSON.stringify(b.error));
  return b.result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await fetch('http://localhost:3000/admin/reset', { method: 'POST' }).catch(() => {});
  await sleep(600);
  const { id } = await rpc('session.new', { url: 'http://localhost:3000', width: 1280, height: 720 });
  await sleep(2500);
  await rpc('eval.js', { code: 'window.__dbg.join(); return 1;' }, id);
  await sleep(2000);
  await fetch('http://localhost:3000/admin/start', { method: 'POST' });
  let inPlay = false;
  for (let i = 0; i < 24; i++) {
    await sleep(700);
    const s = await rpc('eval.js', { code: 'return (window.__dbg.net.snapInfo());' }, id);
    if (s && s.ph === 'play') { inPlay = true; break; }
  }
  if (!inPlay) { console.log('FAIL: no play'); await rpc('session.close', {}, id); process.exit(1); }

  const st = await rpc('eval.js', {
    code: `return (() => {
      const sn = window.__dbg.net.snapInfo();
      // find the gem mesh: the ONLY octahedron in the scene
      let gem = null;
      window.__dbg.game.scene.traverse(o => {
        if (gem !== null || !o.geometry || o.geometry.type !== 'OctahedronGeometry') return;
        gem = { vis: o.visible, x: +o.position.x.toFixed(1), y: +o.position.y.toFixed(1), z: +o.position.z.toFixed(1) };
      });
      return { up: sn ? sn.up : null, gem, hasSync: typeof window.__dbg.game.syncUpgradePickup === 'function' };
    })()`,
  }, id);
  console.log('upgrade pickup state:', JSON.stringify(st));

  const errs = await rpc('errors.tail', { n: 5 }, id);
  console.log('errors:', JSON.stringify((errs.entries || errs).slice(0, 3)));
  await rpc('session.close', {}, id).catch(() => {});
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
