// TJAB: verify the FFT ocean field (stats + wave structure + motion) and
// capture a frame. A working FFT gives: mean ~0, std ~0.3-0.8, strong lag-1
// autocorrelation (smooth waves, NOT white noise), and time-evolution.
const RPC = 'http://127.0.0.1:4701/rpc';
async function rpc(method, params, session) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, session } }) });
  const b = await res.json();
  if (b.error) throw new Error(method + ': ' + JSON.stringify(b.error));
  return b.result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('fs');

const STATS = `(() => {
  const o = window.__dbg.game.ocean;
  if (!o) return { err: 'no ocean' };
  const N = 256;
  const H = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    const row = o.readback(o.dispRT, 0, y, N, 1);
    for (let x = 0; x < N; x++) H[y * N + x] = row[x * 4];
  }
  let mean = 0; for (let i = 0; i < H.length; i++) mean += H[i]; mean /= H.length;
  let varc = 0; for (let i = 0; i < H.length; i++) varc += (H[i] - mean) * (H[i] - mean); varc /= H.length;
  let c1 = 0, c2 = 0, cnt = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N - 2; x++) {
      const i = y * N + x;
      c1 += (H[i] - mean) * (H[i + 1] - mean);
      c2 += (H[i] - mean) * (H[i + 2] - mean);
      cnt++;
    }
  }
  c1 /= cnt * varc; c2 /= cnt * varc;
  let mn = 1e9, mx = -1e9;
  for (let i = 0; i < H.length; i++) { if (H[i] < mn) mn = H[i]; if (H[i] > mx) mx = H[i]; }
  return { mean: +mean.toFixed(4), std: +Math.sqrt(varc).toFixed(4), min: +mn.toFixed(3), max: +mx.toFixed(3), corr1: +c1.toFixed(3), corr2: +c2.toFixed(3) };
})()`;

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
  await sleep(1500);

  const s1 = await rpc('eval.js', { code: `return ${STATS}` }, id);
  await sleep(1000);
  const s2 = await rpc('eval.js', { code: `return ${STATS}` }, id);
  console.log('FFT field t0:', JSON.stringify(s1));
  console.log('FFT field t+1s:', JSON.stringify(s2));
  const moving = s1 && s2 && (Math.abs(s1.max - s2.max) > 0.01 || Math.abs(s1.min - s2.min) > 0.01);
  const wavey = s1 && Math.abs(s1.mean) < 0.1 && s1.corr1 > 0.5 && s1.corr2 > 0.3;
  console.log(moving ? '✅ OCEAN FIELD MOVES (time evolution)' : '❌ OCEAN FIELD STATIC');
  console.log(wavey ? '✅ OCEAN FIELD IS SMOOTH WAVES (mean~0, corr strong — not white noise)' : '❌ OCEAN FIELD NOT WAVE-LIKE');

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
  if (m) {
    fs.writeFileSync('C:/Users/Scott/canoe-battler/scripts/water-fft-evidence.png', Buffer.from(m[1], 'base64'));
    console.log('saved scripts/water-fft-evidence.png');
  }
  await rpc('session.close', {}, id).catch(() => {});
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
