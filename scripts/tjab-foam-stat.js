'use strict';
// Measure the FFT normal-texture alpha (Jacobian foam) distribution.
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
      // warmup readback (r160 WeakMap glitch on first read)
      try { g.ocean.readback(g.ocean.normalRT, 0, 0, 1, 1); } catch (e) {}
      const alphas = [];
      for (let gy = 0; gy < 8; gy++) {
        for (let gx = 0; gx < 8; gx++) {
          const buf = g.ocean.readback(g.ocean.normalRT, Math.floor(gx*32), Math.floor(gy*32), 1, 1);
          alphas.push(Number(buf[3].toFixed(3)));
        }
      }
      const avg = alphas.reduce((a,b)=>a+b,0)/alphas.length;
      const over = { '0.2': 0, '0.35': 0, '0.5': 0 };
      for (const a of alphas) { if (a > 0.2) over['0.2']++; if (a > 0.35) over['0.35']++; if (a > 0.5) over['0.5']++; }
      return JSON.stringify({ avg: avg.toFixed(3), alphas, frac: { '>0.2': over['0.2'], '>0.35': over['0.35'], '>0.5': over['0.5'] } });
    })();`,
  }, id);
  console.log(r);
  await rpc('session.close', {}, id);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
