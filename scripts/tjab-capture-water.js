// TJAB: capture the water mid-match as a small PNG for pixel verification.
const RPC = 'http://127.0.0.1:4701/rpc';
async function rpc(method, params, session) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, session } }) });
  const b = await res.json();
  if (b.error) throw new Error(method + ': ' + JSON.stringify(b.error));
  return b.result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('fs');

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
  await sleep(1200); // let a few wave frames render

  const b64 = await rpc('eval.js', {
    code: `return (() => {
      const c = document.querySelector('canvas');
      const out = document.createElement('canvas');
      out.width = 420; out.height = 236;
      out.getContext('2d').drawImage(c, 0, 0, out.width, out.height);
      return out.toDataURL('image/png');
    })()`,
  }, id);
  const m = /^data:image\/png;base64,(.*)$/.exec(b64);
  if (!m) { console.log('FAIL: no data URL'); process.exit(1); }
  fs.writeFileSync('C:/Users/Scott/canoe-battler/scripts/water-evidence.png', Buffer.from(m[1], 'base64'));
  console.log('saved scripts/water-evidence.png', Buffer.from(m[1], 'base64').length, 'bytes');
  await rpc('session.close', {}, id).catch(() => {});
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
