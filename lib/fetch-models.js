'use strict';

const TIMEOUT_MS = 20000;

function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * 依据 API 格式与用户填写的 Base URL，推导出可能的「列出模型」端点。
 * 兼容用户填写带 /v1、不带 /v1、甚至直接粘贴完整端点的情况。
 */
function candidateUrls(format, rawBase) {
  const base = normalizeBase(rawBase);
  if (!base) throw new Error('请先填写 Base URL');
  if (!/^https?:\/\//i.test(base)) throw new Error('Base URL 需以 http:// 或 https:// 开头');

  let list;
  if (/\/models$/i.test(base)) {
    list = [base];
  } else if (format === 'anthropic') {
    list = [`${base}/v1/models`, `${base}/models`];
  } else if (format === 'gemini') {
    list = [`${base}/v1beta/models`, `${base}/v1/models`];
  } else {
    // OpenAI 兼容：多数供应商是 {base}/v1/models；DeepSeek 等是 {base}/models
    list = /\/v\d+(?:beta)?$/i.test(base)
      ? [`${base}/models`]
      : [`${base}/v1/models`, `${base}/models`];
  }
  return [...new Set(list)];
}

function headersFor(format, key) {
  if (format === 'anthropic') {
    const h = { 'anthropic-version': '2023-06-01' };
    if (key) h['x-api-key'] = key;
    return h;
  }
  if (format === 'gemini') return key ? { 'x-goog-api-key': key } : {};
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function parseModels(format, body) {
  let arr;
  if (format === 'gemini') arr = body && body.models;
  else arr = body && (body.data || body.models);
  if (!Array.isArray(arr)) arr = Array.isArray(body) ? body : null;
  if (!arr) return null;

  const ids = arr
    .map((m) => (typeof m === 'string' ? m : m && (m.id || m.name || m.model) || ''))
    .filter(Boolean)
    .map((s) => String(s).replace(/^models\//, ''));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

function httpErrorMessage(status) {
  if (status === 401 || status === 403) return `认证失败（HTTP ${status}），请检查 API Key`;
  if (status === 404) return '接口不存在（HTTP 404），请检查 Base URL';
  if (status === 429) return '请求过于频繁（HTTP 429），请稍后再试';
  return `服务返回 HTTP ${status}`;
}

async function tryEndpoint(url, format, key) {
  let res;
  try {
    res = await fetch(url, {
      headers: headersFor(format, key),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error('请求超时');
    }
    const code = (err && err.cause && err.cause.code) || '';
    throw new Error(code ? `网络错误（${code}），请检查 URL 与网络` : '网络错误，请检查 URL 与网络');
  }

  let body = null;
  try {
    body = JSON.parse(await res.text());
  } catch (_) {
    /* 非 JSON 响应 */
  }

  if (!res.ok) {
    const detail = body && body.error && body.error.message ? `：${body.error.message}` : '';
    throw new Error(httpErrorMessage(res.status) + detail);
  }
  const models = parseModels(format, body);
  if (!models) throw new Error('接口响应格式无法解析，请确认 API 格式选择正确');
  return models;
}

/**
 * 拉取模型列表。逐个尝试候选端点，全部失败时抛出汇总错误。
 * @returns {{ok:true, models:string[], endpoint:string}}
 */
async function fetchModels(format, baseUrl, apiKey = '') {
  const candidates = candidateUrls(format, baseUrl);
  const errors = [];
  for (const url of candidates) {
    try {
      const models = await tryEndpoint(url, format, String(apiKey || '').trim());
      return { ok: true, models, endpoint: url };
    } catch (err) {
      errors.push(`${url} → ${err.message}`);
    }
  }
  throw new Error(`获取模型失败：\n${errors.join('\n')}`);
}

/**
 * 健康检测：按格式请求「列出模型」接口，只判定可用性与延迟。
 * 任何情况都不抛异常，统一返回结果对象。
 * @returns {{ok:boolean, latencyMs:number, endpoint?:string, modelCount?:number, error?:string}}
 */
async function checkKey(format, baseUrl, apiKey = '') {
  const startedAt = Date.now();
  let candidates;
  try {
    candidates = candidateUrls(format, baseUrl);
  } catch (err) {
    return { ok: false, latencyMs: 0, error: err.message };
  }
  const errors = [];
  for (const url of candidates) {
    try {
      const models = await tryEndpoint(url, format, String(apiKey || '').trim());
      return { ok: true, latencyMs: Date.now() - startedAt, endpoint: url, modelCount: models.length };
    } catch (err) {
      errors.push(err.message);
    }
  }
  // 多个候选端点都失败时，认证错误优先展示（比回退端点的 404 更有诊断价值）
  const authError = errors.find((e) => /认证失败/.test(e));
  return {
    ok: false,
    latencyMs: Date.now() - startedAt,
    error: authError || errors[errors.length - 1] || '未知错误',
  };
}

module.exports = { fetchModels, candidateUrls, parseModels, headersFor, checkKey };
