// Probe: does playwright-core launch Chrome with SceneProof's exact args on this box?
import { chromium } from 'playwright-core';

const exe = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
console.log('launching with sceneproof args...');
const t0 = Date.now();
try {
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'],
    executablePath: exe,
    headless: true,
  });
  console.log('launched in', Date.now() - t0, 'ms');
  const page = await browser.newPage();
  await page.goto('about:blank');
  const webgl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    return gl ? gl.getParameter(gl.RENDERER) + ' | ' + gl.getParameter(gl.VENDOR) : 'NO WEBGL';
  });
  console.log('webgl:', webgl);
  await browser.close();
  console.log('OK');
  process.exit(0);
} catch (e) {
  console.error('FAIL:', e.message);
  process.exit(1);
}
