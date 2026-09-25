'use strict';

/**
 * 导入解析与合并的纯函数集合。
 * 渲染层以 <script> 方式加载（浏览器环境），因此保持零 require；
 * 用 IIFE 包裹避免与 app.js 的顶层 const 冲突，并通过 window.AKMImport 暴露。
 */

(function () {
  const FORMATS = ['openai', 'anthropic', 'gemini'];

  function uid() {
    return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function inferFormatFromUrl(url) {
    const u = String(url || '');
    if (/anthropic/i.test(u)) return 'anthropic';
    if (/generativelanguage\.googleapis|gemini/i.test(u)) return 'gemini';
    return 'openai';
  }

  /** key 形态：sk-/ark-/AIza 等前缀，或 20 位以上无空格串 */
  function isKeyish(s) {
    return /^(sk|ark|AIza)[-_A-Za-z0-9]*$/.test(s) || /^[A-Za-z0-9_-]{20,}$/.test(s);
  }

  function normalizeKey(k) {
    const src = k && typeof k === 'object' ? k : {};
    return {
      id: String(src.id || '') || uid(),
      label: String(src.label || '').slice(0, 60),
      key: String(src.key || ''),
      status: 'unknown',
      latencyMs: null,
      lastCheckedAt: '',
      lastError: '',
    };
  }

  /** 导出文件 / 旧数据文件的一条记录 → 统一的待导入结构 */
  function recordToImported(rec) {
    const src = rec && typeof rec === 'object' ? rec : {};
    let keys = [];
    if (Array.isArray(src.keys) && src.keys.length) {
      keys = src.keys.map((k) => normalizeKey({ label: k && k.label, key: k && (k.key || k.apiKey) }));
    } else if (src.apiKey) {
      keys = [normalizeKey({ label: '默认', key: src.apiKey })];
    }
    return {
      name: String(src.name || ''),
      baseUrl: String(src.baseUrl || ''),
      format: FORMATS.includes(src.format) ? src.format : inferFormatFromUrl(src.baseUrl),
      models: Array.isArray(src.models) ? src.models.map(String) : [],
      keys,
      createdAt: src.createdAt || '',
      updatedAt: src.updatedAt || '',
    };
  }

  /**
   * 行格式解析：每行一条，逗号 / 竖线 / Tab / 空格均可作分隔。
   * 行内按形态识别字段：http(s) 开头是 Base URL，key 形态是 Key，其余第一个是名称。
   * 没有任何 URL 或 Key 的行视为无效直接跳过。
   */
  function parseLine(line) {
    const fields = String(line).split(/[,|\t]|\s+/).map((s) => s.trim()).filter(Boolean);
    let url = '';
    let key = '';
    let name = '';
    const rest = [];
    for (const f of fields) {
      if (!url && /^https?:\/\//i.test(f)) { url = f; continue; }
      rest.push(f);
    }
    for (const f of rest) {
      if (!key && isKeyish(f)) { key = f; continue; }
      if (!name) name = f;
    }
    if (!url && !key) return null;
    return {
      name,
      baseUrl: url,
      format: inferFormatFromUrl(url),
      models: [],
      keys: key ? [normalizeKey({ key })] : [],
    };
  }

  /** .env 内容：*_API_KEY 与 *_BASE_URL 按共同前缀配对成供应商 */
  function parseEnv(raw) {
    const vars = new Map();
    for (const line of String(raw).split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      vars.set(m[1], val);
    }

    const prefixes = new Set();
    for (const name of vars.keys()) {
      if (/_(API_KEY|KEY)$/.test(name)) prefixes.add(name.replace(/_(API_KEY|KEY)$/, ''));
      if (/_(BASE_URL|BASEURL)$/.test(name)) prefixes.add(name.replace(/_(BASE_URL|BASEURL)$/, ''));
    }

    const providers = [];
    for (const prefix of prefixes) {
      if (!prefix) continue;
      const key = vars.get(`${prefix}_API_KEY`) || vars.get(`${prefix}_KEY`) || '';
      const baseUrl = vars.get(`${prefix}_BASE_URL`) || vars.get(`${prefix}_BASEURL`) || '';
      if (!key && !baseUrl) continue;
      providers.push({
        name: prefix,
        baseUrl,
        format: inferFormatFromUrl(baseUrl),
        models: [],
        keys: key ? [normalizeKey({ key })] : [],
      });
    }
    return providers;
  }

  function looksLikeEnv(raw) {
    return /^[A-Za-z0-9_]+\s*=\s*\S/m.test(raw);
  }

  /**
   * 识别并解析导入文本。
   * @returns {{format:'json'|'lines'|'env'|'empty', providers:Array}}
   * @throws 无法识别时抛错
   */
  function parseImportText(text) {
    const raw = String(text || '').trim();
    if (!raw) return { format: 'empty', providers: [] };

    if (raw[0] === '[' || raw[0] === '{') {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        throw new Error('JSON 解析失败，请检查文件内容是否完整');
      }
      const records = Array.isArray(parsed) ? parsed : [parsed];
      return { format: 'json', providers: records.map(recordToImported) };
    }

    if (looksLikeEnv(raw)) {
      return { format: 'env', providers: parseEnv(raw) };
    }

    const providers = String(raw)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map(parseLine)
      .filter(Boolean);
    if (providers.length === 0) {
      throw new Error('无法识别的导入格式：请使用本应用导出的 JSON、每行一条的文本，或 .env 内容');
    }
    return { format: 'lines', providers };
  }

  function normBase(u) {
    return String(u || '').trim().replace(/\/+$/, '');
  }

  /**
   * 把待导入供应商合并进现有列表：同 Base URL + 同名 → 合并 Key 与模型；
   * 完全相同的 Key 跳过；否则作为新供应商追加。
   * @returns {{providers, added, merged, addedKeys, skippedKeys}}
   */
  function mergeProviders(existing, incoming) {
    const providers = existing.map((p) => ({
      ...p,
      models: [...(p.models || [])],
      keys: (p.keys || []).map((k) => ({ ...k })),
    }));
    let added = 0;
    let merged = 0;
    let addedKeys = 0;
    let skippedKeys = 0;

    for (const inc of incoming || []) {
      const incKeys = (inc.keys || []).filter((k) => k.key);
      const incName = String(inc.name || '').trim();
      const target = incName
        ? providers.find(
            (p) => p.name.trim() === incName && normBase(p.baseUrl) === normBase(inc.baseUrl)
          )
        : null;

      if (!target) {
        const now = new Date().toISOString();
        providers.push({
          id: uid(),
          name: inc.name || '',
          baseUrl: inc.baseUrl || '',
          format: FORMATS.includes(inc.format) ? inc.format : 'openai',
          models: [...new Set((inc.models || []).map(String))],
          keys: incKeys.map((k) => normalizeKey({ label: k.label, key: k.key })),
          createdAt: inc.createdAt || now,
          updatedAt: inc.updatedAt || now,
        });
        added += 1;
        continue;
      }

      merged += 1;
      for (const k of incKeys) {
        if (target.keys.some((e) => e.key && e.key === k.key)) {
          skippedKeys += 1;
          continue;
        }
        target.keys.push(normalizeKey({ label: k.label, key: k.key }));
        addedKeys += 1;
      }
      target.models = [...new Set([...target.models, ...(inc.models || []).map(String)])]
        .sort((a, b) => a.localeCompare(b));
    }

    return { providers, added, merged, addedKeys, skippedKeys };
  }

  if (typeof window !== 'undefined') {
    window.AKMImport = { parseImportText, mergeProviders, inferFormatFromUrl };
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parseImportText, mergeProviders, inferFormatFromUrl };
  }
})();
