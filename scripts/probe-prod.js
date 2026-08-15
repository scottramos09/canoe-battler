'use strict';
// probe-prod.js — load the PRODUCTION page headless, capture console/page
// errors, then attempt the login flow and report what actually happens.
const { chromium } = require('playwright-core');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.env.PROD_URL || 'https://canoearena.netlify.app/';

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const logs = [];
  page.on('pageerror', e => logs.push('PAGEERROR: ' + e.message));
  page.on('console', m => logs.push(`CONSOLE[${m.type()}]: ${m.text()}`));
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(5000);
  const before = await page.evaluate(() => ({
    loginVisible: !document.getElementById('login').classList.contains('hidden'),
    hasDbg: !!window.__dbg,
    defs: !!(window.__dbg && window.__dbg.net && window.__dbg.net.defs),
    serverCfg: window.CANOE_SERVER,
    connMsg: document.getElementById('connMsg') ? document.getElementById('connMsg').textContent : '?',
    btnLogin: !!document.getElementById('btnLogin'),
  }));
  console.log('before login:', JSON.stringify(before));
  // attempt the login exactly like a user
  await page.locator('#loginUser').fill('test');
  await page.locator('#loginPass').fill('test');
  await page.locator('#btnLogin').click();
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => ({
    loginHidden: document.getElementById('login').classList.contains('hidden'),
    err: document.getElementById('loginErr').textContent,
    menuShown: !document.getElementById('menu').classList.contains('hidden'),
  }));
  console.log('after login:', JSON.stringify(after));
  console.log('--- logs (first 20) ---');
  for (const l of logs.slice(0, 20)) console.log('  ' + l);
  await browser.close();
})().catch(e => { console.error('probe crashed:', e.message); process.exit(2); });
