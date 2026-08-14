'use strict';
// ============================================================
// CANOE ARENA — full test suite runner.
// Spins up a fresh server (ALLOW_ADMIN=1) on a scratch port,
// runs the headless sim test and the browser E2E, reports.
// Run: npm test
// ============================================================
const { spawn } = require('child_process');
const http = require('http');

const PORT = 3199;
const server = spawn(process.execPath, ['server/server.js'], {
  cwd: __dirname + '/..',
  env: { ...process.env, ALLOW_ADMIN: '1', PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

function waitReady(retries = 40) {
  return new Promise((res) => {
    const tryOnce = (n) => {
      if (n <= 0) return res(false);
      http.get(`http://localhost:${PORT}/`, (r) => res(r.statusCode === 200))
        .on('error', () => setTimeout(() => tryOnce(n - 1), 250));
    };
    tryOnce(retries);
  });
}

function run(script, env) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [script], {
      cwd: __dirname + '/..',
      env: { ...process.env, E2E_BASE: `http://localhost:${PORT}`, ...env },
      stdio: 'inherit',
    });
    child.on('exit', (code) => res(code === 0));
  });
}

(async () => {
  console.log('━━━ CANOE ARENA test suite ━━━');
  const ready = await waitReady();
  if (!ready) { console.error('❌ server failed to start'); server.kill(); process.exit(1); }
  console.log(`server up on :${PORT}`);

  const sim = await run('scripts/simtest.js');
  const e2e = await run('scripts/e2e.js');

  server.kill();
  console.log(sim && e2e ? '\n✅ ALL TESTS PASS' : '\n💥 TESTS FAILED');
  process.exit(sim && e2e ? 0 : 1);
})();
