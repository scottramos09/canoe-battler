'use strict';
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
  await sleep(800);
  const { id } = await rpc('session.new', { url: 'http://localhost:3000', width: 1280, height: 720 });
  await sleep(3000);
  const dbg0 = await rpc('eval.js', { code: 'return JSON.stringify({ dbg: !!window.__dbg, phase: window.__dbg ? (window.__dbg.net.snapInfo()||{}).ph : null, state: window.__dbg ? window.__dbg.state.phase : null });' }, id);
  console.log('after load:', dbg0);
  const j = await rpc('eval.js', { code: 'try { window.__dbg.join(); return "join-ok"; } catch (e) { return "join-err: " + e.message; }' }, id);
  console.log('join:', j);
  await sleep(2000);
  const dbg1 = await rpc('eval.js', { code: 'return JSON.stringify({ myId: window.__dbg.state.myId, phase: (window.__dbg.net.snapInfo()||{}).ph });' }, id);
  console.log('after join:', dbg1);
  const st = await fetch('http://localhost:3000/admin/start', { method: 'POST' });
  console.log('start http:', st.status);
  await sleep(1500);
  const dbg2 = await rpc('eval.js', { code: 'return JSON.stringify({ myId: window.__dbg.state.myId, phase: (window.__dbg.net.snapInfo()||{}).ph, players: (window.__dbg.net.snapInfo()||{}).ps ? window.__dbg.net.snapInfo().ps.length : -1 });' }, id);
  console.log('after start:', dbg2);
  await rpc('session.close', {}, id);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
