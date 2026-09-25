'use strict';

/**
 * 端到端测试：通过 Chrome DevTools 协议驱动真实 Electron 应用。
 * 流程：添加供应商 → 填表 → 自动获取模型（打到本地 mock 接口）→ 保存 →
 *       杀掉应用重启 → 验证数据持久化与 API Key 解密回填。
 *
 * 机制：用 http-proxy 把 127.0.0.1:18111/18112/18113 重定向到 mock 动态端口，
 *       这样渲染进程的 fetch 只需填固定的 1811x 端口即可。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const mock = require('./mock-server');

const ROOT = path.join(__dirname, '..');
const PORT = 9333;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'akm-e2e-'));
const SHOT_DIR = path.join(ROOT, 'test', 'screenshots');
const MOCK_STATIC_PORT_A = 18111;
const MOCK_STATIC_PORT_B = 18112;
const MOCK_STATIC_PORT_C = 18113;
const MOCK_STATIC_PORT_D = 18114;

let electronProc = null;
let proxyServer = null;
let proxyPort = null;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(fn, timeout = 20000, every = 300) {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor 超时');
    await sleep(every);
  }
}

/**
 * 静态端口代理服务器：监听 18111/18112/18113/18114，转发到 mock 的动态端口。
 * 渲染进程只需填 http://127.0.0.1:18111/v1/ 等固定 URL 即可。
 */
async function startProxy(mockPorts) {
  return new Promise((resolve, reject) => {
    proxyPort = 0;
    proxyServer = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      // 根据目标端口映射到 mock server
      let targetPort;
      if (req.headers['authorization'] === 'Bearer sk-test') {
        // OpenAI/Gemini 兼容（port A）
        if (u.endsWith('/v1/models') || u.endsWith('/v1beta/models') || u === '/models') targetPort = mockPorts.A;
      } else if (req.headers['x-api-key'] === 'sk-test') {
        // Anthropic（port B）
        if (u.endsWith('/v1/models')) targetPort = mockPorts.B;
      }
      // DeepSeek 风格（port C）
      if (!targetPort && u === '/models' && req.url.includes('/18113')) targetPort = mockPorts.C;
      // 401 测试（port D）
      if (!targetPort && u.endsWith('/v1/models') && req.url.includes('/18114')) targetPort = mockPorts.D;

      if (!targetPort) {
        // fallback：按端口号直查
        const staticPort = parseInt(req.url.match(/:(\d+)\//)?.[1] || '0', 10);
        if (staticPort === MOCK_STATIC_PORT_A) targetPort = mockPorts.A;
        else if (staticPort === MOCK_STATIC_PORT_B) targetPort = mockPorts.B;
        else if (staticPort === MOCK_STATIC_PORT_C) targetPort = mockPorts.C;
        else if (staticPort === MOCK_STATIC_PORT_D) targetPort = mockPorts.D;
      }

      if (!targetPort) {
        res.writeHead(500); res.end('no target');
        return;
      }

      const opts = {
        hostname: '127.0.0.1',
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
      };
      const proxy = http.request(opts, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      });
      proxy.on('error', (e) => { res.writeHead(502); res.end(e.message); });
      req.pipe(proxy, { end: true });
    });
    proxyServer.listen(0, '127.0.0.1', () => {
      proxyPort = proxyServer.address().port;
      resolve(proxyPort);
    });
  });
}

async function launchElectron(mockPorts) {
  try { spawn.execSync('pkill -x "API Key Manager" 2>/dev/null || true'); } catch (_) {}
  sleep(500).then(() => {});
  electronProc = spawn(
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    [ROOT, `--remote-debugging-port=${PORT}`],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        AKM_DATA_DIR: DATA_DIR,
        // 让渲染进程的 fetch 通过 HTTP_PROXY 走代理，代理把 URL 转发到 mock
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
        http_proxy: `http://127.0.0.1:${proxyPort}`,
        HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
        https_proxy: `http://127.0.0.1:${proxyPort}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  electronProc.stderr.on('data', () => {});
  await new Promise((resolve, reject) => {
    electronProc.once('exit', (code, signal) => reject(new Error(`Electron 意外退出 code=${code} signal=${signal}`)));
    resolve();
  });
  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      return list.find((t) => t.type === 'page' && t.url.startsWith('file://'));
    } catch (_) { return null; }
  });
}

function killElectron() {
  return new Promise((resolve) => {
    if (!electronProc || electronProc.killed) return resolve();
    electronProc.once('exit', resolve);
    electronProc.kill('SIGTERM');
    setTimeout(() => { if (!electronProc.killed) electronProc.kill('SIGKILL'); resolve(); }, 4000);
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  static async connect(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面执行出错: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }

  close() { this.ws.close(); }
}

async function screenshot(cdp, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(r.data, 'base64'));
  console.log(`  截图：test/screenshots/${name}`);
}

async function getPageTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  return list.find((t) => t.type === 'page' && t.url.startsWith('file://'));
}

const setInput = `(sel, val) => {
  const el = document.querySelector(sel);
  el.value = val;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}`;

async function main() {
  console.log('mock 接口启动中…');
  const mockPorts = await mock.start();
  console.log(`mock 端口: A=${mockPorts.A} B=${mockPorts.B} C=${mockPorts.C} D=${mockPorts.D}`);

  console.log('静态端口代理启动中…');
  await startProxy(mockPorts);
  console.log(`代理监听在端口 ${proxyPort}，将 18111-18114 转发到 mock`);

  fs.mkdirSync(SHOT_DIR, { recursive: true });

  console.log('第一次启动（新建供应商 → 获取模型 → 保存）…');
  await launchElectron(mockPorts);
  await waitFor(async () => !!(await getPageTarget()));
  let cdp = await CDP.connect(await getPageTarget());
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await waitFor(() => cdp.eval('document.querySelector("#btn-add") ? 1 : 0'));

  await cdp.eval('document.querySelector("#btn-add").click()');
  await waitFor(() => cdp.eval('document.querySelector("#f-name") ? 1 : 0'));

  // 使用固定的静态端口 URL（代理会转发到 mock）
  await cdp.eval(`(${setInput})("#f-name", "Mock 供应商")`);
  await cdp.eval(`(${setInput})("#f-url", "http://127.0.0.1:${MOCK_STATIC_PORT_A}/v1/")`);
  await cdp.eval(`(${setInput})("#f-key", "sk-test")`);

  await cdp.eval('document.querySelector("#btn-fetch").click()');
  await waitFor(() => cdp.eval('document.querySelectorAll(".chip").length >= 2 ? 1 : 0'), 25000);
  const chipCount = await cdp.eval('document.querySelectorAll(".chip").length');
  console.log(`  ✓ 自动获取模型成功，得到 ${chipCount} 个模型`);
  await screenshot(cdp, '1-fetch-models.png');

  await cdp.eval('document.querySelector("#btn-save").click()');
  await waitFor(() => cdp.eval('document.querySelector("#dirty-dot").hidden ? 1 : 0'));
  const items1 = await cdp.eval('document.querySelectorAll(".provider-item").length');
  if (items1 !== 1) throw new Error(`侧栏应有 1 个供应商，实际 ${items1}`);
  console.log('  ✓ 保存成功，侧栏出现该供应商');
  cdp.close();
  await killElectron();

  console.log('第二次启动（验证持久化与 Key 解密回填）…');
  await launchElectron(mockPorts);
  await waitFor(async () => !!(await getPageTarget()));
  cdp = await CDP.connect(await getPageTarget());
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await waitFor(() => cdp.eval('document.querySelectorAll(".provider-item").length === 1 ? 1 : 0'));

  const name = await cdp.eval('document.querySelector(".provider-item .name").textContent');
  const url = await cdp.eval('document.querySelector("#f-url").value');
  const key = await cdp.eval('document.querySelector("#f-key").value');
  const models = await cdp.eval('document.querySelectorAll(".chip").length');
  if (name !== 'Mock 供应商') throw new Error(`名称回读失败: ${name}`);
  if (url !== `http://127.0.0.1:${MOCK_STATIC_PORT_A}/v1/`) throw new Error(`URL 回读失败: ${url}`);
  if (key !== 'sk-test') throw new Error(`API Key 解密回填失败（长度 ${key.length}）`);
  if (models !== chipCount) throw new Error(`模型数量回读失败: ${models}`);
  console.log(`  ✓ 重启后数据完整：名称/URL/Key（加密存储、解密回填）/ ${models} 个模型`);
  await screenshot(cdp, '2-after-restart.png');

  cdp.close();
  await killElectron();
  await mock.stop();
  if (proxyServer) proxyServer.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log('\n端到端测试全部通过 ✅');
}

main()
  .catch((err) => {
    console.error('\n端到端测试失败 ❌\n' + err.stack);
    return Promise.allSettled([killElectron(), mock.stop(), new Promise(r => proxyServer ? proxyServer.close(r) : r())]).then(() => process.exit(1));
  });
