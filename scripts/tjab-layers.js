'use strict';
// Verify boundary assets are layer-2 (excluded from the mirror pass) + capture.
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
  await sleep(1200);
  const r = await rpc('eval.js', {
    code: `return (() => {
      const g = window.__dbg.game;
      let layer2 = 0, layer0far = 0, total = 0;
      g.scene.traverse(o => {
        if (!o.isMesh) return;
        total++;
        if (o.layers.mask === 4) layer2++;
        if (o.layers.mask === 1 && (Math.abs(o.position.x) > 94 || Math.abs(o.position.z) > 94)) layer0far++;
      });
      window.__dbg.shot();
      return JSON.stringify({ total, layer2, layer0far });
    })();`,
  }, id);
  console.log('layers:', r);
  await sleep(400);
  await rpc('session.close', {}, id);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
