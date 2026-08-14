// probe-clip.js — are the hover-preview clip frames actually DIFFERENT per
// class? Renders each class at the same t into its own canvas and compares.
const { chromium } = require('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const { existsSync } = require('fs');
if (!existsSync(CHROME)) { console.log('chrome not found at', CHROME); process.exit(2); }

(async () => {
  const b = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'],
  });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  await p.goto('http://localhost:3000/', { waitUntil: 'load' });
  await p.waitForTimeout(1500);
  const r = await p.evaluate(async () => {
    const g = window.__dbg && window.__dbg.game;
    const defs = window.__dbg && window.__dbg.net.defs;
    if (!g || !defs) return { err: 'no __dbg' };
    const mk = () => { const cv = document.createElement('canvas'); cv.width = 264; cv.height = 170; document.body.appendChild(cv); return cv; };
    const a = mk(), bb = mk(), cc = mk();
    try {
      g.classClipFrame(defs.CLASSES.razorfin, 0.6, a);
      const da = a.toDataURL();
      g.classClipFrame(defs.CLASSES.barge, 0.6, bb);
      const db = bb.toDataURL();
      g.classClipFrame(defs.CLASSES.rocket, 0.6, cc);
      const dc = cc.toDataURL();
      return { lens: [da.length, db.length, dc.length], ab: da === db, ac: da === dc, bc: db === dc };
    } catch (e) { return { err: e.message }; }
  });
  console.log(JSON.stringify(r));
  await b.close();
  process.exit(0);
})();
