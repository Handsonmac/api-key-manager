'use strict';
// 诊断：捕获所有 JS 错误和 CSP 事件
const http = require('http');
const CDP_PORT = process.argv[2] || 9348;

async function getTarget() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).find(t => t.type === 'page')); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function cdpEval(ws, expr) {
  return new Promise((resolve, reject) => {
    ws._id = (ws._id || 0) + 1;
    const id = ws._id;
    const handler = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) { ws.removeEventListener('message', handler);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result && msg.result.result !== undefined ? msg.result.result.value : msg.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true }}));
  });
}

async function main() {
  const target = await getTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });

  // 捕获所有事件
  ws.addEventListener('message', m => {
    const msg = JSON.parse(m.data);
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args || []).map(a => String(a.value ?? a.description ?? ''));
      console.log('[PAGE]', ...args);
    }
    if (msg.method === 'Security.securityPolicyEventReceived') {
      console.log('[CSP]', msg.params.violatedDirective, '→', (msg.params.blockedURI || '').substring(0, 100));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      const exc = d.exception ? (d.exception.description || d.exception.value || JSON.stringify(d.exception)) : '(unknown)';
      const loc = d.throwLocation ? ` at ${d.throwLocation.fileName}:${d.throwLocation.lineNumber}` : '';
      console.log('[JS ERROR]', exc.slice(0, 200), loc);
    }
  });

  await new Promise(r => setTimeout(r, 4000));

  const info = await cdpEval(ws, `
    JSON.stringify({
      hasInit: typeof init,
      hasApi: typeof api,
      hasProviders: typeof providers,
      bodyHtml: document.body ? document.body.innerHTML.substring(0, 300) : 'NO_BODY',
    })
  `);
  console.log('\n=== FINAL ===');
  console.log(info);

  ws.close();
  setTimeout(() => process.exit(0), 500);
}

main().catch(e => { console.error(e); process.exit(1); });
