'use strict';

const assert = require('assert');
const { migrateProvider, normalizeKey } = require('../lib/model');

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
  console.log('migrateProvider 旧数据 → 多 Key 迁移：');
  await t('仅 apiKey → 包装成一个「默认」Key，顶层明文移除', () => {
    const p = migrateProvider({ id: 'a', name: 'X', format: 'openai', apiKey: 'sk-1', models: ['m1'] });
    assert.strictEqual(p.keys.length, 1);
    assert.strictEqual(p.keys[0].key, 'sk-1');
    assert.strictEqual(p.keys[0].label, '默认');
    assert.strictEqual(p.keys[0].status, 'unknown');
    assert.strictEqual(p.keys[0].latencyMs, null);
    assert.strictEqual(p.apiKey, undefined, '顶层 apiKey 应被移除');
    assert.strictEqual(p.models.length, 1, '其余字段保留');
  });

  await t('仅 apiKeyEnc（未解密场景）→ enc 保留进 key 条目', () => {
    const p = migrateProvider({ id: 'a', name: 'X', apiKeyEnc: 'ENC==' });
    assert.strictEqual(p.keys.length, 1);
    assert.strictEqual(p.keys[0].apiKeyEnc, 'ENC==');
    assert.strictEqual(p.keys[0].key, '');
    assert.strictEqual(p.apiKeyEnc, undefined, '顶层 apiKeyEnc 应被移除');
  });

  await t('无任何 Key → keys 为空数组', () => {
    const p = migrateProvider({ id: 'a', name: 'X' });
    assert.deepStrictEqual(p.keys, []);
  });

  await t('已是多 Key 结构 → 原样保留并规范化', () => {
    const p = migrateProvider({
      id: 'a',
      keys: [
        { id: 'k1', label: '主', key: 'sk-1', status: 'weird', latencyMs: 'x' },
        { label: 'b', key: 'sk-2', status: 'ok', latencyMs: 123, lastCheckedAt: '2026-01-01' },
      ],
    });
    assert.strictEqual(p.keys.length, 2);
    assert.strictEqual(p.keys[0].id, 'k1');
    assert.strictEqual(p.keys[0].status, 'unknown', '非法 status 纠正为 unknown');
    assert.strictEqual(p.keys[0].latencyMs, null, '非法 latencyMs 纠正为 null');
    assert.ok(p.keys[1].id, '缺 id 自动补');
    assert.strictEqual(p.keys[1].status, 'ok');
  });

  await t('顶层 apiKey 与 keys 并存（异常数据）→ 以 keys 为准不重复', () => {
    const p = migrateProvider({ id: 'a', apiKey: 'sk-old', keys: [{ label: '主', key: 'sk-1' }] });
    assert.strictEqual(p.keys.length, 1);
    assert.strictEqual(p.keys[0].key, 'sk-1');
  });

  await t('不修改入参（纯函数）', () => {
    const input = { id: 'a', apiKey: 'sk-1' };
    migrateProvider(input);
    assert.strictEqual(input.apiKey, 'sk-1');
  });

  console.log('normalizeKey：');
  await t('缺 id / label / status 时给合理默认', () => {
    const k = normalizeKey({});
    assert.ok(k.id);
    assert.strictEqual(k.label, '');
    assert.strictEqual(k.key, '');
    assert.strictEqual(k.status, 'unknown');
    assert.strictEqual(k.latencyMs, null);
    assert.strictEqual(k.lastCheckedAt, '');
  });
  await t('status 只接受 ok / invalid / unknown', () => {
    assert.strictEqual(normalizeKey({ status: 'ok' }).status, 'ok');
    assert.strictEqual(normalizeKey({ status: 'invalid' }).status, 'invalid');
    assert.strictEqual(normalizeKey({ status: 'nope' }).status, 'unknown');
  });
  await t('lastError 默认空串、超长截断到 300', () => {
    assert.strictEqual(normalizeKey({}).lastError, '');
    assert.strictEqual(normalizeKey({ lastError: '认证失败' }).lastError, '认证失败');
    assert.strictEqual(normalizeKey({ lastError: 'x'.repeat(400) }).lastError.length, 300);
  });

  console.log('backupNamesToDelete 备份轮换：');
  const { backupNamesToDelete } = require('../lib/model');
  await t('保留最新 keep 份，返回应删除的旧文件', () => {
    const files = ['p-2026-01-01.json', 'p-2026-01-03.json', 'p-2026-01-02.json'];
    assert.deepStrictEqual(backupNamesToDelete(files, 2).sort(), ['p-2026-01-01.json']);
  });
  await t('不足 keep 份 → 不删除', () => {
    assert.deepStrictEqual(backupNamesToDelete(['a.json'], 10), []);
  });

  console.log(`\n结果：${passed} 项全部通过`);
})();
