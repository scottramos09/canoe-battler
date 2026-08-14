// Probe: does a Playwright Chromium page join the LIVE :3000 lobby?
// Captures page errors WITH STACKS + post-click __dbg state.
const { chromium } = require('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.PROBE_BASE || 'http://localhost:3000';

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => {
    const stack = (e.stack || '').split('\n').slice(0, 12).join(' < ');
    errors.push('PAGEERROR: ' + e.message + ' || ' + stack);
  });
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  console.log('btn visible:', await page.locator('#btnStart').isVisible());
  console.log('__dbg:', await page.evaluate(() => !!window.__dbg));
  await page.locator('#btnStart').click();
  await page.waitForTimeout(2000);
  const st = await page.evaluate(() => ({
    joined: window.__dbg.state.joined,
    myId: window.__dbg.state.myId,
    btn: document.getElementById('btnStart').textContent.trim(),
    crew: document.querySelectorAll('#playerList .prow').length,
    phase: window.__dbg.state.phase,
  }));
  console.log('after join click:', JSON.stringify(st));
  console.log('errors:', JSON.stringify(errors.slice(0, 4)));
  await browser.close();
})().catch((e) => { console.error('PROBE FAIL', e.message); process.exit(1); });
