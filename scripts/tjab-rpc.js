// TJAB RPC helper — POST a JSON-RPC command to the tjab server and print the result.
// Usage: node scripts/tjab-rpc.js '<method>' '<json params>' [session]
// e.g.   node scripts/tjab-rpc.js 'eval.js' '{"code":"1+1"}' s1-xxxxx
const SESS = process.argv[3] || 's1-e4bdo';
const method = process.argv[2];
const params = JSON.parse(process.argv[3] || '{}');
// eval bodies are `new Function` bodies — a value is only returned with an
// explicit `return` (they don't act like eval's last-expression rule)
if (method === 'eval.js') params.code = 'return (' + params.code + ');';
params.session = params.session || SESS;
(async () => {
  const res = await fetch('http://127.0.0.1:4701/rpc', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) { console.error('ERR', body.error.data ? body.error.data.code : body.error.message, body.error.message); process.exit(1); }
  console.log(JSON.stringify(body.result, null, 1));
})().catch((e) => { console.error('RPC FAIL', e.message); process.exit(1); });
