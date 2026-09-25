'use strict';

const assert = require('assert');
const { parseImportText, mergeProviders, inferFormatFromUrl } = require('../lib/import');

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

(async () => {
  console.log('parseImportText 三种格式识别：');
  await t('JSON 数组（新版 keys 结构）→ 逐条转 provider', () => {
    const text = JSON.stringify([
      { name: 'A', baseUrl: 'https://a.com', format: 'openai', models: ['m1'],
        keys: [{ label: '主', key: 'sk-1' }, { label: '备', key: 'sk-2' }] },
    ]);
    const r = parseImportText(text);
    assert.strictEqual(r.format, 'json');
    assert.strictEqual(r.providers.length, 1);
    assert.strictEqual(r.providers[0].keys.length, 2);
    assert.strictEqual(r.providers[0].keys[0].key, 'sk-1');
  });

  await t('JSON 数组（旧版 apiKey）→ 包装成默认 Key', () => {
    const text = JSON.stringify([{ name: 'B', baseUrl: 'https://b.com', apiKey: 'sk-old', models: [] }]);
    const r = parseImportText(text);
    assert.strictEqual(r.providers[0].keys[0].key, 'sk-old');
    assert.strictEqual(r.providers[0].keys[0].label, '默认');
  });

  await t('单个 JSON 对象（非数组）→ 当作一条', () => {
    const r = parseImportText(JSON.stringify({ name: 'C', baseUrl: 'https://c.com', apiKey: 'sk-c' }));
    assert.strictEqual(r.providers.length, 1);
    assert.strictEqual(r.providers[0].name, 'C');
  });

  await t('行格式：逗号分隔 名称,URL,Key', () => {
    const r = parseImportText('DeepSeek, https://api.deepseek.com, sk-abc');
    assert.strictEqual(r.format, 'lines');
    assert.strictEqual(r.providers[0].name, 'DeepSeek');
    assert.strictEqual(r.providers[0].baseUrl, 'https://api.deepseek.com');
    assert.strictEqual(r.providers[0].keys[0].key, 'sk-abc');
  });

  await t('行格式：竖线 / 多空格 / Tab 分隔均可', () => {
    for (const line of [
      'DS | https://ds.com | sk-1',
      'DS  https://ds.com  sk-1',
      'DS\thttps://ds.com\tsk-1',
    ]) {
      const r = parseImportText(line);
      assert.strictEqual(r.providers[0].name, 'DS');
      assert.strictEqual(r.providers[0].keys[0].key, 'sk-1');
    }
  });

  await t('行格式：两段 URL+Key → 名称留空', () => {
    const r = parseImportText('https://x.com/v1 sk-yyy');
    assert.strictEqual(r.providers[0].name, '');
    assert.strictEqual(r.providers[0].baseUrl, 'https://x.com/v1');
    assert.strictEqual(r.providers[0].keys[0].key, 'sk-yyy');
  });

  await t('行格式：单行只有一个 key → 仅 Key 无 URL', () => {
    const r = parseImportText('sk-xxxxxxxxxxxxxxxx');
    assert.strictEqual(r.providers[0].baseUrl, '');
    assert.strictEqual(r.providers[0].keys[0].key, 'sk-xxxxxxxxxxxxxxxx');
  });

  await t('行格式：多行逐条解析', () => {
    const r = parseImportText('A, https://a.com, sk-1\nB, https://b.com, sk-2');
    assert.strictEqual(r.providers.length, 2);
  });

  await t('行格式：URL 推断 API 格式（anthropic / gemini / openai）', () => {
    const r = parseImportText('A, https://api.anthropic.com, sk-1\nB, https://generativelanguage.googleapis.com, y\nC, https://x.com, sk-3');
    assert.strictEqual(r.providers[0].format, 'anthropic');
    assert.strictEqual(r.providers[1].format, 'gemini');
    assert.strictEqual(r.providers[2].format, 'openai');
  });

  await t('.env：*_API_KEY 与 *_BASE_URL 按 前缀配对', () => {
    const text = [
      '# comment',
      'DEEPSEEK_API_KEY=sk-1',
      'DEEPSEEK_BASE_URL=https://api.deepseek.com',
      '',
      'ARK_API_KEY=ark-123',
    ].join('\n');
    const r = parseImportText(text);
    assert.strictEqual(r.format, 'env');
    assert.strictEqual(r.providers.length, 2);
    const ds = r.providers.find((p) => p.name === 'DEEPSEEK');
    assert.strictEqual(ds.baseUrl, 'https://api.deepseek.com');
    assert.strictEqual(ds.keys[0].key, 'sk-1');
    const ark = r.providers.find((p) => p.name === 'ARK');
    assert.strictEqual(ark.baseUrl, '');
    assert.strictEqual(ark.keys[0].key, 'ark-123');
  });

  await t('空文本 → empty 格式零条', () => {
    const r = parseImportText('   \n  ');
    assert.strictEqual(r.format, 'empty');
    assert.deepStrictEqual(r.providers, []);
  });

  await t('完全无法识别 → 报错', () => {
    assert.throws(() => parseImportText('!!!!!!!!'), /无法识别/);
  });

  console.log('inferFormatFromUrl：');
  await t('常见域名推断', () => {
    assert.strictEqual(inferFormatFromUrl('https://api.anthropic.com'), 'anthropic');
    assert.strictEqual(inferFormatFromUrl('https://generativelanguage.googleapis.com'), 'gemini');
    assert.strictEqual(inferFormatFromUrl('https://api.deepseek.com/v1'), 'openai');
    assert.strictEqual(inferFormatFromUrl(''), 'openai');
  });

  console.log('mergeProviders 合并去重：');
  const baseExisting = () => [
    {
      id: 'p1', name: 'DS', baseUrl: 'https://api.deepseek.com', format: 'openai', models: ['m1'],
      keys: [{ id: 'k1', label: '默认', key: 'sk-1', status: 'unknown', latencyMs: null, lastCheckedAt: '' }],
    },
  ];

  await t('全新供应商 → added', () => {
    const incoming = [{ name: 'New', baseUrl: 'https://n.com', format: 'openai', models: [], keys: [{ label: '', key: 'sk-n' }] }];
    const r = mergeProviders(baseExisting(), incoming);
    assert.strictEqual(r.added, 1);
    assert.strictEqual(r.providers.length, 2);
    assert.ok(r.providers[1].id, '新供应商补 id');
  });

  await t('同 baseUrl + 同名 → Key 合并进已有供应商', () => {
    const incoming = [{ name: 'DS', baseUrl: 'https://api.deepseek.com/', format: 'openai', models: [], keys: [{ label: '备用', key: 'sk-2' }] }];
    const r = mergeProviders(baseExisting(), incoming);
    assert.strictEqual(r.merged, 1);
    assert.strictEqual(r.added, 0);
    assert.strictEqual(r.providers[0].keys.length, 2);
    assert.strictEqual(r.providers[0].keys[1].key, 'sk-2');
  });

  await t('完全相同的 Key → 跳过不重复', () => {
    const incoming = [{ name: 'DS', baseUrl: 'https://api.deepseek.com', format: 'openai', models: [], keys: [{ label: 'x', key: 'sk-1' }] }];
    const r = mergeProviders(baseExisting(), incoming);
    assert.strictEqual(r.skippedKeys, 1);
    assert.strictEqual(r.providers[0].keys.length, 1);
  });

  await t('models 取并集', () => {
    const incoming = [{ name: 'DS', baseUrl: 'https://api.deepseek.com', format: 'openai', models: ['m2', 'm1'], keys: [] }];
    const r = mergeProviders(baseExisting(), incoming);
    assert.deepStrictEqual(r.providers[0].models, ['m1', 'm2']);
  });

  await t('同名但 baseUrl 不同 → 视为新供应商', () => {
    const incoming = [{ name: 'DS', baseUrl: 'https://other.com', format: 'openai', models: [], keys: [{ label: '', key: 'sk-9' }] }];
    const r = mergeProviders(baseExisting(), incoming);
    assert.strictEqual(r.added, 1);
  });

  console.log(`\n结果：${passed} 项全部通过`);
})();
