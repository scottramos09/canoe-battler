// probe-focus.js — does the page still have keyboard focus + does W move the
// predicted canoe, after the join→start flow? (drive-straight regression)
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const { existsSync } = require('fs');
if (!existsSync(CHROME)) { console.log('chrome not found'); process.exit(2); }

(async () => {
  await fetch('http://localhost:3000/admin/reset', { method: 'POST' }).catch(() => {});
  // raw host claims the lobby first (mirrors the E2E)
  let host;
  for (let i = 0; i < 5 && !host; i++) {
    try {
      const ws = new WebSocket('ws://localhost:3000/ws');
      await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
      ws.send(JSON.stringify({ t: 'join', name: 'ProbeHost', cls: 'barge', cosmetics: {} }));
      host = ws;
    } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  const b = await chromium.launch({ executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await p.goto('http://localhost:3000/', { waitUntil: 'load' });
  await p.waitForTimeout(1200);
  await p.locator('#btnJoin').click();
  await p.waitForTimeout(1500);
  await p.locator('.classcard').nth(1).click();
  await p.waitForTimeout(500);
  host.send(JSON.stringify({ t: 'start' }));
  await p.waitForTimeout(7000); // countdown → play
  const before = await p.evaluate(() => ({
    focus: document.hasFocus(),
    active: document.activeElement ? document.activeElement.tagName + '#' + (document.activeElement.id || '') : 'none',
  }));
  await p.keyboard.down('KeyW');
  const samples = [];
  for (let i = 0; i < 12; i++) {
    await p.waitForTimeout(250);
    samples.push(await p.evaluate(() => {
      const o = window.__dbg && window.__dbg.net && window.__dbg.net.own();
      return { spd: o ? +Math.hypot(o.vx, o.vz).toFixed(1) : -1, focus: document.hasFocus(),
        active: document.activeElement ? document.activeElement.tagName : 'none' };
    }));
  }
  console.log(JSON.stringify({ before, samples }));
  await b.close();
  try { host.close(); } catch { }
  process.exit(0);
})();
