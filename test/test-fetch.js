'use strict';

const assert = require('assert');
const { fetchModels, candidateUrls, checkKey } = require('../lib/fetch-models');
const mock = require('./mock-server');

async function main() {
  const ports = await mock.start();
  let passed = 0;

  async function t(name, fn) {
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.error(`  ✗ ${name}\n    ${err.message}`);
      process.exitCode = 1;
    }
  }

  console.log(`mock 端口: A=${ports.A} B=${ports.B} C=${ports.C} D=${ports.D}`);

  console.log('candidateUrls 推导：');
  await t('OpenAI 带 /v1 → 仅 /models', () => {
    assert.deepStrictEqual(candidateUrls('openai', 'https://api.openai.com/v1/'), [
      'https://api.openai.com/v1/models',
    ]);
  });
  await t('OpenAI 不带 /v1 → 先试 /v1/models 再 /models', () => {
    assert.deepStrictEqual(candidateUrls('openai', 'https://api.deepseek.com'), [
      'https://api.deepseek.com/v1/models',
      'https://api.deepseek.com/models',
    ]);
  });
  await t('粘贴完整端点 → 直接使用', () => {
    assert.deepStrictEqual(candidateUrls('openai', 'https://x.com/v1/models'), ['https://x.com/v1/models']);
  });
  await t('空 URL 报错', () => {
    assert.throws(() => candidateUrls('openai', '  '), /请先填写/);
  });
  await t('非 http(s) 报错', () => {
    assert.throws(() => candidateUrls('openai', 'ftp://x.com'), /http/);
  });

  console.log('fetchModels 各格式：');
  await t('OpenAI 兼容（base 带 /v1，去重 + 排序）', async () => {
    const r = await fetchModels('openai', `http://127.0.0.1:${ports.A}/v1`, 'sk-test');
    assert.deepStrictEqual(r.models, ['gpt-4o', 'gpt-4o-mini']);
    assert.strictEqual(r.endpoint, `http://127.0.0.1:${ports.A}/v1/models`);
  });
  await t('OpenAI 兼容（base 不带 /v1，自动尝试 /v1/models）', async () => {
    const r = await fetchModels('openai', `http://127.0.0.1:${ports.A}`, 'sk-test');
    assert.deepStrictEqual(r.models, ['gpt-4o', 'gpt-4o-mini']);
  });
  await t('DeepSeek 风格（/v1/models 404 后回退 /models）', async () => {
    const r = await fetchModels('openai', `http://127.0.0.1:${ports.C}`, '');
    assert.deepStrictEqual(r.models, ['deepseek-chat']);
    assert.strictEqual(r.endpoint, `http://127.0.0.1:${ports.C}/models`);
  });
  await t('Anthropic（x-api-key + version 头）', async () => {
    const r = await fetchModels('anthropic', `http://127.0.0.1:${ports.B}`, 'sk-test');
    assert.deepStrictEqual(r.models, ['claude-haiku-4', 'claude-sonnet-4']);
  });
  await t('Gemini（v1beta，models/ 前缀剥离）', async () => {
    const r = await fetchModels('gemini', `http://127.0.0.1:${ports.A}`, 'sk-test');
    assert.deepStrictEqual(r.models, ['gemini-2.0-flash', 'gemini-2.0-flash-lite']);
    assert.strictEqual(r.endpoint, `http://127.0.0.1:${ports.A}/v1beta/models`);
  });
  await t('Key 错误 → 报认证失败', async () => {
    await assert.rejects(
      () => fetchModels('openai', `http://127.0.0.1:${ports.D}/v1`, 'sk-bad'),
      /认证失败/
    );
  });
  await t('无法连接 → 报网络错误', async () => {
    await assert.rejects(
      () => fetchModels('openai', 'http://127.0.0.1:19999', ''),
      /网络错误|获取模型失败/
    );
  });

  console.log('checkKey 健康检测：');
  await t('有效 Key → ok + 延迟 + 模型数', async () => {
    const r = await checkKey('openai', `http://127.0.0.1:${ports.A}/v1`, 'sk-test');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(typeof r.latencyMs, 'number');
    assert.ok(r.latencyMs >= 0);
    assert.strictEqual(r.modelCount, 2);
  });
  await t('Key 无效（401）→ ok=false，错误含「认证失败」，不抛异常', async () => {
    const r = await checkKey('openai', `http://127.0.0.1:${ports.D}/v1`, 'sk-bad');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /认证失败/);
    assert.strictEqual(typeof r.latencyMs, 'number');
  });
  await t('网络不通 → ok=false，错误含「网络错误」', async () => {
    const r = await checkKey('openai', 'http://127.0.0.1:19999', '');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /网络错误|URL/);
  });
  await t('非法 URL → ok=false，不抛异常', async () => {
    const r = await checkKey('openai', 'ftp://x.com', '');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /http/);
  });
  await t('Anthropic 格式同样可检测', async () => {
    const r = await checkKey('anthropic', `http://127.0.0.1:${ports.B}`, 'sk-test');
    assert.strictEqual(r.ok, true);
  });

  await mock.stop();
  console.log(`\n结果：${passed} 项全部通过`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
