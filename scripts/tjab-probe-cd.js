// TJAB: (1) does the lobby bot stepper work (click botPlus, count changes)?
// (2) does the boost cooldown overlay animate like the ability's?
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

  // ---- 1) bot stepper ----
  const b0 = await rpc('eval.js', {
    code: `return (() => { const el = document.getElementById('botCount'); const p = document.getElementById('botPlus'); return { count: el ? el.textContent : '?', hasPlus: !!p }; })()`,
  }, id);
  console.log('lobby bot count:', JSON.stringify(b0));
  const clicked = await rpc('eval.js', { code: `document.getElementById('botPlus').click(); return 1;` }, id);
  await sleep(800);
  const b1 = await rpc('eval.js', {
    code: `return (() => { const el = document.getElementById('botCount'); const ui = window.__dbg && window.__dbg.state ? 0 : 0; return { count: el ? el.textContent : '?' }; })()`,
  }, id);
  console.log('after botPlus click:', JSON.stringify(b1));

  // ---- 2) boost vs ability cooldown overlays ----
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

  // fire the ability (cd 7) and boost (cd 7), then sample both overlays
  await rpc('eval.js', { code: 'window.__dbg.setCmd({ ab: 1, boost: 1 }); return 1;' }, id);
  await sleep(200);
  await rpc('eval.js', { code: 'window.__dbg.setCmd({ ab: 0, boost: 0 }); return 1;' }, id);

  for (const t of [600, 1600, 2600, 3600]) {
    await sleep(1000);
    const s = await rpc('eval.js', {
      code: `return (() => {
        const own = window.__dbg.net.own();
        const a = document.getElementById('abilityCdOverlay');
        const b = document.getElementById('boostCdOverlay');
        return {
          t: ${t}, bcd: own ? +own.boostCd.toFixed(1) : null, bT: own ? +own.boostT.toFixed(1) : null,
          acd: own ? +own.abilityCd.toFixed(1) : null,
          abilityBg: a ? a.style.background.slice(0, 28) : '?',
          boostBg: b ? b.style.background.slice(0, 28) : '?',
        };
      })()`,
    }, id);
    console.log('cd sample:', JSON.stringify(s));
  }
  await rpc('session.close', {}, id).catch(() => {});
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
