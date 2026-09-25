'use strict';
// 诊断：检查 CSP 违规 + 脚本加载状态
const http = require('http');
const CDP_PORT = process.argv[2] || 9346;

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

  // 监听所有事件
  ws.addEventListener('message', m => {
    const msg = JSON.parse(m.data);
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args || []).map(a => String(a.value ?? a.description ?? ''));
      console.log('[PAGE]', ...args);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const details = msg.params.exceptionDetails;
      console.log('[EXCEPTION]', details.exception?.description || JSON.stringify(details).slice(0, 400));
    }
    if (msg.method === 'Security.securityPolicyEventReceived') {
      console.log('[CSP]', msg.params.securityPolicyEvent.documentURL, msg.params.violatedDirective, msg.params.blockedURI);
    }
  });

  await new Promise(r => setTimeout(r, 3000));

  // 检查 scripts 和全局变量
  const info = await cdpEval(ws, `
    (() => {
      const scripts = Array.from(document.querySelectorAll('script')).map(s => ({
        src: s.src,
        ready: s.readyState,
        text: s.textContent ? 'HAS_SCRIPT' : 'EMPTY'
      }));
      return {
        scripts,
        hasApi: typeof api !== 'undefined',
        hasInit: typeof init !== 'undefined',
        hasProviders: typeof providers !== 'undefined',
        mainInner: document.querySelector('#main')?.innerHTML?.substring(0, 200) || 'EMPTY'
      };
    })()
  `);
  console.log('\n=== PAGE INFO ===');
  console.log(JSON.stringify(info, null, 2));

  ws.close();
  setTimeout(() => process.exit(0), 500);
}

main().catch(e => { console.error(e); process.exit(1); });
