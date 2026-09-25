'use strict';
/**
 * E2E 测试：通过 CDP 驱动真实 Electron 应用，验证自动获取模型、保存、持久化。
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..');
// 每次运行用随机 CDP 端口，避免上次残留的僵尸进程占用固定端口
const CDP_PORT = 9342 + Math.floor(Math.random() * 400);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-e2e-'));
const SHOT_DIR = path.join(ROOT, 'test', 'screenshots');

// 静态端口 mock（固定端口，代理/测试都用同一个）
const STATIC = { A: 18311, B: 18312, C: 18313, D: 18314 };
let electronProc = null;
let servers = [];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function jsonResp(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function startMock() {
  const A = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u.endsWith('/v1/models')) {
      if ((req.headers.authorization || '') !== 'Bearer sk-test') return jsonResp(res, 401, { error: { message: 'bad key' } });
      return jsonResp(res, 200, { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] });
    }
    if (u.endsWith('/v1beta/models')) {
      if (req.headers['x-goog-api-key'] !== 'sk-test') return jsonResp(res, 403, {});
      return jsonResp(res, 200, { models: [{ name: 'models/gemini-2.0-flash' }] });
    }
    if (u === '/models') return jsonResp(res, 200, { data: [{ id: 'deepseek-chat' }] });
    jsonResp(res, 404, {});
  });
  const B = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u.endsWith('/v1/models')) {
      if (req.headers['x-api-key'] !== 'sk-test' || !req.headers['anthropic-version']) return jsonResp(res, 401, {});
      return jsonResp(res, 200, { data: [{ id: 'claude-sonnet-4' }, { id: 'claude-haiku-4' }] });
    }
    jsonResp(res, 404, {});
  });
  const C = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/models') return jsonResp(res, 200, { data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] });
    jsonResp(res, 404, {});
  });
  const D = http.createServer((req, res) => jsonResp(res, 401, { error: { message: 'bad key' } }));
  return Promise.all([
    new Promise(r => A.listen(STATIC.A, '127.0.0.1', r)),
    new Promise(r => B.listen(STATIC.B, '127.0.0.1', r)),
    new Promise(r => C.listen(STATIC.C, '127.0.0.1', r)),
    new Promise(r => D.listen(STATIC.D, '127.0.0.1', r)),
  ]).then(() => { servers = [A, B, C, D]; console.log(`mock: A=${STATIC.A} B=${STATIC.B} C=${STATIC.C} D=${STATIC.D}`); });
}

class CDPClient {
  constructor(ws) {
    this.ws = ws;
    this._id = 0;
    this._pending = new Map();
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this._pending.has(msg.id)) {
        const { resolve, reject, timer } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = ++this._id;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP 超时: ${method}`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  eval(expr) {
    return this.send('Runtime.evaluate', { expression: expr, returnByValue: true }).then(r => {
      if (r && r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error('页面异常: ' + ((d.exception && d.exception.description) || d.text));
      }
      return r && r.result && r.result.value !== undefined ? r.result.value : r;
    });
  }
  close() { this.ws.close(); }
}

async function getTarget(retries = 25) {
  for (let i = 0; i < retries; i++) {
    try {
      const t = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, res => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d).find(t => t.type === 'page')); } catch(e) { reject(e); } });
        }).on('error', reject);
      });
      if (t) return t;
    } catch (e) {
      if (i === retries - 1) throw e;
    }
    await sleep(700);
  }
  throw new Error(`CDP target 等待超时（端口 ${CDP_PORT}）`);
}

async function launchElectron() {
  try { execSync('pkill -9 -f "api-key-manager/node_modules/electron" 2>/dev/null || true'); } catch (_) {}
  // 确认 CDP 端口已释放，最多等 3 秒
  for (let i = 0; i < 6; i++) {
    const busy = await new Promise((resolve) => {
      const probe = http.get(`http://127.0.0.1:${CDP_PORT}/json/version`, (res) => { res.resume(); resolve(true); });
      probe.on('error', () => resolve(false));
      probe.setTimeout(400, () => { probe.destroy(); resolve(false); });
    });
    if (!busy) break;
    await sleep(500);
  }
  await sleep(300);
  electronProc = spawn(
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    [ROOT, `--remote-debugging-port=${CDP_PORT}`],
    { cwd: ROOT, env: { ...process.env, AKM_DATA_DIR: DATA_DIR }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const proc = electronProc;
  proc.stderr.on('data', (d) => {
    const s = String(d);
    if (/ERROR|error|crash|FATAL/.test(s)) console.log('  [electron]', s.trim().split('\n').slice(0, 3).join(' | '));
  });
  proc.on('exit', (code) => { if (!proc.__expected) console.log(`  [electron] 实例退出 code=${code}`); });
  await new Promise((resolve, reject) => {
    electronProc.once('exit', (code, signal) => reject(new Error(`Electron exited code=${code}`)));
    resolve();
  });
  await sleep(5000); // 等窗口打开
}

async function killElectron() {
  if (!electronProc || electronProc.killed) return;
  electronProc.__expected = true;
  const proc = electronProc;
  return new Promise((r) => {
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); r(); } };
    const timer = setTimeout(() => {
      try { if (!proc.killed) proc.kill('SIGKILL'); } catch (_) {}
      execSync(`pkill -9 -f "remote-debugging-port=${CDP_PORT}" 2>/dev/null || true`);
      finish();
    }, 3000);
    proc.once('exit', finish);
    proc.kill('SIGTERM');
  });
}

async function screenshot(cdp, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(r.data, 'base64'));
  console.log(`  截图：test/screenshots/${name}`);
}

async function fillInput(cdp, selector, value) {
  await cdp.eval(`(function(){const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('missing '+${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}

async function main() {
  console.log('启动 mock 服务器...');
  await startMock();
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  console.log('第一次启动（新建 → 获取模型 → 保存）...');
  await launchElectron();
  const target = await getTarget();
  if (!target) throw new Error('找不到 CDP target');
  console.log('  target:', target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const cdp = new CDPClient(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await sleep(2000);

  // 验证页面已渲染（并捕获 promise rejection —— 页面里的 async 异常不会走 error 事件）
  await cdp.eval('window.__errs=[];window.addEventListener("error",e=>window.__errs.push("E:"+String(e.message||e)));window.addEventListener("unhandledrejection",e=>window.__errs.push("R:"+String((e.reason&&e.reason.stack)||e.reason)));0');
  const bodyOk = await cdp.eval('!!document.body');
  const btnOk = await cdp.eval('!!document.querySelector("#btn-add")');
  console.log('  body:', bodyOk, 'btn-add:', btnOk);
  if (!btnOk) {
    const html = await cdp.eval('document.body ? document.body.innerHTML.substring(0, 500) : "EMPTY"');
    throw new Error('页面未渲染: ' + html);
  }

  // 点击添加
  await cdp.eval('document.querySelector("#btn-add").click()');
  await sleep(800);
  const errsAfterAdd = await cdp.eval('JSON.stringify(window.__errs||[])');
  console.log('  [errs after btn-add]', errsAfterAdd);

  // 填表
  await fillInput(cdp, '#f-name', 'Mock 供应商');
  await fillInput(cdp, '#f-url', `http://127.0.0.1:${STATIC.A}/v1/`);

  // 添加一个 Key 并填值（新版多 Key 结构）
  await cdp.eval('document.querySelector("#btn-add-key").click()');
  await sleep(300);
  await fillInput(cdp, '#key-rows .key-val', 'sk-test');
  await sleep(300);

  // 点击自动获取模型 → 应弹出勾选浮层 → 全选替换
  await cdp.eval('document.querySelector("#btn-fetch").click()');
  await sleep(4000);
  const pickerVisible = await cdp.eval('!document.querySelector("#modal-root").hidden');
  if (!pickerVisible) {
    const toastText = await cdp.eval('document.querySelector("#toast")?.textContent || ""');
    throw new Error(`模型勾选浮层未弹出（toast: ${toastText || '无'}）`);
  }
  const pickerCount = await cdp.eval('document.querySelectorAll(".picker-item").length');
  console.log(`  ✓ 拉取到 ${pickerCount} 个模型，勾选浮层已弹出`);
  await screenshot(cdp, '1-model-picker.png');
  await cdp.eval('document.querySelector("#picker-replace").click()');
  await sleep(800);
  const chipCount = await cdp.eval('document.querySelectorAll(".chip").length');
  console.log(`  ✓ 勾选替换后得到 ${chipCount} 个模型`);

  // 健康检测：点唯一 Key 行的「检测」
  await cdp.eval('document.querySelector(".key-check").click()');
  await sleep(3000);
  const meta = await cdp.eval('document.querySelector(".key-meta")?.textContent || ""');
  if (!meta.includes('有效')) throw new Error(`健康检测未通过: ${meta}`);
  console.log(`  ✓ 健康检测通过：${meta.trim()}`);
  await screenshot(cdp, '2-key-check.png');

  // 保存
  await cdp.eval('document.querySelector("#btn-save").click()');
  await sleep(1000);
  const items1 = await cdp.eval('document.querySelectorAll(".provider-item").length');
  console.log(`  ✓ 保存成功，侧栏有 ${items1} 个供应商`);
  cdp.close();
  await killElectron();

  console.log('第二次启动（验证持久化 + Key 解密回填）...');
  await launchElectron();
  const target2 = await getTarget();
  const ws2 = new WebSocket(target2.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws2.addEventListener('open', resolve); ws2.addEventListener('error', reject); });
  const cdp2 = new CDPClient(ws2);
  await cdp2.send('Runtime.enable');
  await sleep(2000);

  const name = await cdp2.eval('document.querySelector(".provider-item .name")?.textContent || ""');
  const url = await cdp2.eval('document.querySelector("#f-url")?.value || ""');
  const key = await cdp2.eval('document.querySelector("#key-rows .key-val")?.value || ""');
  const models = await cdp2.eval('document.querySelectorAll(".chip").length');
  const dots = await cdp2.eval('document.querySelectorAll(".dots .dot").length');
  const meta2 = await cdp2.eval('document.querySelector(".key-meta")?.textContent || ""');
  console.log(`  名称: "${name}" (期望 "Mock 供应商")`);
  console.log(`  URL:  "${url}" (期望 "http://127.0.0.1:${STATIC.A}/v1/")`);
  console.log(`  Key:  "${key}" (期望 "sk-test")`);
  console.log(`  模型数: ${models} (期望 ${chipCount})`);
  console.log(`  健康点: ${dots} 个 (期望 1)，状态行: "${meta2.trim()}"`);

  if (name !== 'Mock 供应商') throw new Error(`名称回读失败: ${name}`);
  if (url !== `http://127.0.0.1:${STATIC.A}/v1/`) throw new Error(`URL 回读失败: ${url}`);
  if (key !== 'sk-test') throw new Error(`API Key 解密回填失败（长度 ${key.length}）`);
  if (models !== chipCount) throw new Error(`模型数量回读失败: ${models}`);
  if (dots !== 1) throw new Error(`健康点数量错误: ${dots}`);
  if (!meta2.includes('有效')) throw new Error(`检测结果未持久化: ${meta2}`);
  console.log('  ✓ 重启后数据完整（含检测结果）');
  await screenshot(cdp2, '3-after-restart.png');
  cdp2.close();
  await killElectron();

  servers.forEach(s => s.close());
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log('\n端到端测试全部通过 ✅');
}

main().catch(err => {
  console.error('\n端到端测试失败 ❌\n' + err.stack);
  killElectron().then(() => { servers.forEach(s => s.close()); process.exit(1); });
});
