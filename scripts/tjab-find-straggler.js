'use strict';
const RPC = 'http://127.0.0.1:4701/rpc';
async function rpc(method, params, session) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, session } }) });
  const b = await res.json();
  if (b.error) throw new Error(method + ': ' + JSON.stringify(b.error));
  return b.result;
}
(async () => {
  const { id } = await rpc('session.new', { url: 'http://localhost:3000', width: 1280, height: 720 });
  await new Promise(r => setTimeout(r, 2500));
  const out = await rpc('eval.js', {
    code: `return JSON.stringify((() => {
      const g = window.__dbg.game;
      const hits = [];
      g.scene.traverse(o => {
        if (!o.isMesh) return;
        if (o.layers.mask === 1 && (Math.abs(o.position.x) > 94 || Math.abs(o.position.z) > 94)) {
          hits.push({ x: Math.round(o.position.x), z: Math.round(o.position.z), c: o.material && o.material.color ? o.material.color.getHexString() : '?' });
        }
      });
      return hits;
    })());`,
  }, id);
  console.log('layer0 far meshes:', out);
  await rpc('session.close', {}, id);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
