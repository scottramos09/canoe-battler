'use strict';
// Full-res mid-match screenshot via TJAB (1280x720 canvas -> /shot endpoint).
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
  await rpc('eval.js', { code: 'window.__dbg.shot(); return 1;' }, id);
  await sleep(400);
  await rpc('session.close', {}, id);
  console.log('shot taken');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
