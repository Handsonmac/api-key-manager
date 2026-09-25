'use strict';

/**
 * 本地 Mock 服务器，模拟四种真实供应商的「列出模型」接口，用于测试与界面联调。
 *   A (随机): OpenAI 风格 /v1/models（校验 Bearer）、Gemini 风格 /v1beta/models（校验 x-goog-api-key）、DeepSeek 风格 /models
 *   B (随机): Anthropic 风格 /v1/models（校验 x-api-key + anthropic-version）
 *   C (随机): 仅 /models（测试 /v1/models 404 后的回退）
 *   D (随机): 恒定 401（测试错误提示）
 */
const http = require('http');

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const A = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/v1/models') {
    if ((req.headers.authorization || '') !== 'Bearer sk-test') {
      return json(res, 401, { error: { message: 'Incorrect API key provided' } });
    }
    return json(res, 200, { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] });
  }
  if (u === '/v1beta/models') {
    if (req.headers['x-goog-api-key'] !== 'sk-test') {
      return json(res, 403, { error: { message: 'API key not valid' } });
    }
    return json(res, 200, {
      models: [{ name: 'models/gemini-2.0-flash' }, { name: 'models/gemini-2.0-flash-lite' }],
    });
  }
  if (u === '/models') {
    return json(res, 200, { data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] });
  }
  json(res, 404, { error: { message: 'not found' } });
});

const B = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/v1/models') {
    if (req.headers['x-api-key'] !== 'sk-test' || !req.headers['anthropic-version']) {
      return json(res, 401, { type: 'error', error: { message: 'invalid x-api-key' } });
    }
    return json(res, 200, {
      data: [{ id: 'claude-sonnet-4' }, { id: 'claude-haiku-4' }],
    });
  }
  json(res, 404, {});
});

const C = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/models') return json(res, 200, { data: [{ id: 'deepseek-chat' }] });
  json(res, 404, { error: { message: 'not found' } });
});

const D = http.createServer((req, res) => {
  json(res, 401, { error: { message: 'Incorrect API key' } });
});

const servers = [
  [A, 0],
  [B, 0],
  [C, 0],
  [D, 0],
];

async function start() {
  const ports = await Promise.all(
    servers.map(async ([s]) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port))))
  );
  return { A: ports[0], B: ports[1], C: ports[2], D: ports[3] };
}

async function stop() {
  return Promise.all(servers.map(([s]) => new Promise((r) => s.close(() => r()))));
}

module.exports = { start, stop };

if (require.main === module) {
  start().then((ports) => console.log('mock servers running:', ports));
}
