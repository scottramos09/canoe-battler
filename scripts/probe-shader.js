'use strict';
// Minimal probe: load the game, capture console/pageerrors (shader compile
// errors surface as THREE.WebGLProgram console errors), sample the canvas.
const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'],
  });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text().slice(0, 400)); });
  await p.goto('http://localhost:3000', { waitUntil: 'load' });
  await p.waitForTimeout(2500);
  const r = await p.evaluate(() => {
    const g = window.__dbg && window.__dbg.game;
    return {
      draws: g ? g.renderer.info.render.calls : -1,
      progs: g ? g.renderer.info.programs.length : -1,
      tris: g ? g.renderer.info.render.triangles : -1,
      sample: g ? g.sample(4) : null,
    };
  });
  console.log(JSON.stringify(r));
  console.log('---errors---');
  console.log(errs.slice(0, 8).join('\n') || '(none)');
  await b.close();
})().catch(e => { console.error('PROBE FAIL:', e.message); process.exit(1); });
