'use strict';
const fs = require('fs');
const wsUrl = process.argv[2];
if (!wsUrl) { console.error('usage: node test.js <ws-url>'); process.exit(1); }
const ws = new WebSocket(wsUrl);
let id = 0;
ws.addEventListener('message', m => {
  const msg = JSON.parse(m.data);
  if (msg.id === ++id) {
    const v = msg.result && msg.result.result !== undefined ? msg.result.result.value : msg.result;
    console.log('resp['+id+']:', JSON.stringify(v).slice(0, 200));
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const args = (msg.params.args || []).map(a => String(a.value ?? a.description ?? ''));
    console.log('[PAGE]', ...args);
  }
});
ws.addEventListener('open', () => {
  ws.send(JSON.stringify({id:++id,method:'Runtime.evaluate',params:{expression:'window.__testInit',returnByValue:true}}));
  setTimeout(()=>{ws.close();process.exit(0);},3000);
});
ws.addEventListener('error', e => console.error('WS err:', e.message));
