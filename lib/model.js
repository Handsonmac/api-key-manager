'use strict';

/**
 * 供应商数据模型的纯函数集合：多 Key 规范化、旧数据迁移、备份轮换。
 * 保持零依赖，主进程与测试直接 require，不涉及 Electron API。
 */

const KEY_STATUSES = ['ok', 'invalid', 'unknown'];

function uid() {
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 补全单个 Key 条目的全部字段，纠正非法值 */
function normalizeKey(k) {
  const src = k && typeof k === 'object' ? k : {};
  return {
    id: String(src.id || '') || uid(),
    label: String(src.label || '').slice(0, 60),
    key: String(src.key || ''),
    apiKeyEnc: src.apiKeyEnc ? String(src.apiKeyEnc) : '',
    status: KEY_STATUSES.includes(src.status) ? src.status : 'unknown',
    latencyMs: Number.isFinite(src.latencyMs) ? src.latencyMs : null,
    lastCheckedAt: String(src.lastCheckedAt || ''),
    lastError: String(src.lastError || '').slice(0, 300),
  };
}

/**
 * 旧结构（顶层 apiKey / apiKeyEnc）→ 新结构（keys[]）。
 * 已是新结构的数据原样规范化；不修改入参。
 */
function migrateProvider(p) {
  const src = p && typeof p === 'object' ? p : {};
  const out = { ...src };
  delete out.apiKey;
  delete out.apiKeyEnc;

  if (Array.isArray(src.keys) && src.keys.length) {
    out.keys = src.keys.map(normalizeKey);
  } else if (src.apiKey || src.apiKeyEnc) {
    out.keys = [normalizeKey({ label: '默认', key: String(src.apiKey || ''), apiKeyEnc: src.apiKeyEnc || '' })];
  } else {
    out.keys = [];
  }
  return out;
}

/** 文件名按字典序即时间序；返回超出保留数量的最旧备份名 */
function backupNamesToDelete(names, keep = 10) {
  const sorted = [...names].sort();
  return sorted.slice(0, Math.max(0, sorted.length - keep));
}

module.exports = { normalizeKey, migrateProvider, backupNamesToDelete, KEY_STATUSES };
