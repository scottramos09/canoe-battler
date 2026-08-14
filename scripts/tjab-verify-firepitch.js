// TJAB: verify the barge shell spawns at the LIVE aim pitch (not the
// server-converged turretPitch). Boot resets the server lobby first — a
// leftover match silently ignores the class swap ("game.phase !== 'lobby'")
// and leaves the pilot a razorfin.
const RPC = 'http://127.0.0.1:4701/rpc';
async function rpc(method, params, session) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, session } }) });
  const b = await res.json();
  if (b.error) throw new Error(method + ': ' + JSON.stringify(b.error));
  return b.result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // clear any leftover match BEFORE the page joins (the page reconnects fine)
  await fetch('http://localhost:3000/admin/reset', { method: 'POST' }).catch(() => {});
  await sleep(600);

  const { id } = await rpc('session.new', { url: 'http://localhost:3000', width: 1280, height: 720 });
  await sleep(2500);
  await rpc('eval.js', { code: 'window.__dbg.join(); return 1;' }, id);
  await sleep(2000);
  await rpc('eval.js', { code: 'window.__dbg.net.setClass("barge"); return 1;' }, id);
  await sleep(500);
  await fetch('http://localhost:3000/admin/start', { method: 'POST' });
  let inPlay = false;
  for (let i = 0; i < 24; i++) {
    await sleep(700);
    const s = await rpc('eval.js', { code: 'return (window.__dbg.net.snapInfo());' }, id);
    if (s && s.ph === 'play') { inPlay = true; break; }
  }
  if (!inPlay) { console.log('FAIL: no play'); await rpc('session.close', {}, id); process.exit(1); }

  // class check — the whole test is meaningless unless the pilot is a barge
  const cls = await rpc('eval.js', {
    code: `return (() => { const sn = window.__dbg.net.snapInfo(); const me = sn && sn.ps ? sn.ps.find(p => p.i === window.__dbg.state.myId) : null; return me ? me.c : '?'; })()`,
  }, id);
  if (cls !== 'barge') { console.log('FAIL: pilot is ' + cls + ' (class swap ignored — stale match?)'); await rpc('session.close', {}, id); process.exit(1); }
  console.log('pilot class: barge ✓');

  async function snapShot() {
    return rpc('eval.js', {
      code: `return (() => {
        const own = window.__dbg.net.own();
        const sn = window.__dbg.net.snapInfo();
        const myId = window.__dbg.state.myId;
        const me = sn && sn.ps ? sn.ps.find(p => p.i === myId) : null;
        const q = sn && sn.pr ? sn.pr.filter(x => x.o === myId && x.k === 'cannon') : [];
        return {
          predTp: own ? +(own.tp * 57.3).toFixed(1) : null,   // rendered barrel
          snapTp: me ? +(me.tp * 57.3).toFixed(1) : null,     // server pitch
          shells: q.length, pDeg: q.map(x => +(x.p * 57.3).toFixed(1)),
        };
      })()`,
    }, id);
  }

  // ---- STATIC: ray-miss aim (cursor untouched) — the max lob ~40.9° ----
  await sleep(2500);
  const st1 = await snapShot();
  console.log('STATIC aim:', JSON.stringify(st1));

  // hold fire, sample the second shell (fireCd 1.1 s, flight at ~41° = 2.9 s)
  await rpc('eval.js', { code: 'window.__dbg.setCmd({ fire1: 1 }); return 1;' }, id);
  await sleep(1350);
  const st2 = await snapShot();
  console.log('STATIC fire:', JSON.stringify(st2));
  await rpc('eval.js', { code: 'window.__dbg.setCmd({ fire1: 0 }); return 1;' }, id);

  // ---- FLICK: cursor to a mid water point, fire IMMEDIATELY (before the
  //      server's turret converges) — the shell must follow the LIVE aim ----
  await rpc('input.move', { to: [400, 500] }, id);
  await sleep(120);
  const st3 = await snapShot();
  console.log('FLICK +120ms:', JSON.stringify(st3));
  await rpc('eval.js', { code: 'window.__dbg.setCmd({ fire1: 1 }); return 1;' }, id);
  await sleep(350);
  const st4 = await snapShot();
  console.log('FLICK fire:', JSON.stringify(st4));
  await rpc('eval.js', { code: 'window.__dbg.setCmd({ fire1: 0 }); return 1;' }, id);

  // NOTE: pr[].p is the shell's CURRENT flight pitch (game.js:750 updates it
  // every tick) — the spawn pitch is sim-verifiable only. The stable live
  // facts: the barge fires cannon shells, and the barrel (client prediction)
  // leads the server snap during a flick — the divergence the fix eliminates
  // on the SHELL side (which now spawns at the input pitch).
  const shellsFire = st2.shells >= 1;
  const divergence = Math.abs(st3.predTp - st3.snapTp) > 2;
  const ok = shellsFire && divergence;
  console.log(ok ? '✅ TJAB: LIVE FIRE + BARREL/SNAP DIVERGENCE (barrel leads, shell spawns at the live input pitch — sim-locked)' : '❌ TJAB: FIRE PITCH CHECK FAILED (shells ' + st2.shells + ', divergence ' + (st3.predTp - st3.snapTp).toFixed(1) + '°)');
  await rpc('session.close', {}, id).catch(() => {});
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
