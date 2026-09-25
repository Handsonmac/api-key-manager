'use strict';

/* global document, window, navigator, crypto */

window.__api = window.api || {};

const FORMATS = [
  { value: 'openai', label: 'OpenAI 兼容', placeholder: 'https://api.openai.com/v1' },
  { value: 'anthropic', label: 'Anthropic', placeholder: 'https://api.anthropic.com' },
  { value: 'gemini', label: 'Google Gemini', placeholder: 'https://generativelanguage.googleapis.com' },
];
const FORMAT_LABEL = Object.fromEntries(FORMATS.map((f) => [f.value, f.label]));

const IMPORT = window.AKMImport || {};

const ICONS = {
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
};

const $ = (sel) => document.querySelector(sel);

const SAVE_KBD = /Mac|iPhone|iPad/.test(navigator.platform || "") ? "⌘S" : "Ctrl+S";


let providers = []; // 已保存的供应商
let draft = null;   // 正在编辑的工作副本
let query = '';

/* ---------------- 小工具 ---------------- */

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clone(p) {
  return JSON.parse(JSON.stringify(p));
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return url || '';
  }
}

function pick(p) {
  return JSON.stringify([
    p.name.trim(), p.format, p.baseUrl.trim(), p.models,
    (p.keys || []).map((k) => [k.id, k.label, k.key]),
  ]);
}

function isDirty() {
  if (!draft) return false;
  const saved = providers.find((p) => p.id === draft.id);
  return !saved || pick(saved) !== pick(draft);
}

let toastTimer = null;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, type === 'error' ? 6000 : 2500);
}

async function copyText(text, label) {
  if (!text) return toast(`${label}为空`, 'error');
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label}已复制`, 'success');
  } catch (_) {
    toast('复制失败', 'error');
  }
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function timeAgo(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const diff = Date.now() - t;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  return new Date(t).toLocaleString();
}

function iconBtn(svg, title) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon-btn';
  b.innerHTML = svg;
  b.title = title;
  return b;
}

function newKeyRecord(extra = {}) {
  return {
    id: uid(), label: '', key: '',
    status: 'unknown', latencyMs: null, lastCheckedAt: '', lastError: '',
    keyLost: false, ...extra,
  };
}

/* ---------------- 弹层 ---------------- */

function openModal(html) {
  $('#modal-box').innerHTML = html;
  $('#modal-root').hidden = false;
}

function closeModal() {
  $('#modal-root').hidden = true;
  $('#modal-box').textContent = '';
}

/* ---------------- 侧栏 ---------------- */

function dotsHTML(p) {
  const keys = Array.isArray(p.keys) ? p.keys : [];
  if (!keys.length) return '';
  const labelFor = (k) => (k.keyLost ? '无法解密' : k.status === 'ok' ? '有效' : k.status === 'invalid' ? '失效' : '未检测');
  const clsFor = (k) => (k.keyLost ? 'lost' : k.status || 'unknown');
  const shown = keys.slice(0, 6)
    .map((k) => `<i class="dot ${clsFor(k)}" title="${labelFor(k)}"></i>`)
    .join('');
  const more = keys.length > 6 ? `<i class="dot-more">+${keys.length - 6}</i>` : '';
  return `<span class="dots">${shown}${more}</span>`;
}

function renderSidebar() {
  const list = $('#provider-list');
  list.textContent = '';

  const q = query.trim().toLowerCase();
  const match = (p) =>
    !q ||
    p.name.toLowerCase().includes(q) ||
    p.baseUrl.toLowerCase().includes(q) ||
    p.models.some((m) => m.toLowerCase().includes(q));

  const items = providers.filter(match);
  if (draft && !providers.some((p) => p.id === draft.id)) {
    items.unshift(draft); // 尚未保存的新供应商
  }

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'list-empty';
    empty.textContent = q ? '没有匹配的供应商' : '还没有供应商，点击上方添加';
    list.appendChild(empty);
  }

  for (const p of items) {
    const el = document.createElement('div');
    el.className = 'provider-item' + (draft && p.id === draft.id ? ' active' : '');

    const row1 = document.createElement('div');
    row1.className = 'row1';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.name.trim() || '（未命名）';
    row1.append(name);
    row1.insertAdjacentHTML('beforeend', dotsHTML(p));
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `${p.models.length} 模型`;
    row1.append(count);

    const row2 = document.createElement('div');
    row2.className = 'row2';
    const host = document.createElement('span');
    host.className = 'host';
    host.textContent = hostOf(p.baseUrl) || '—';
    const fmt = document.createElement('span');
    fmt.className = 'fmt';
    fmt.textContent = FORMAT_LABEL[p.format] || p.format;
    row2.append(host, fmt);

    el.append(row1, row2);
    el.addEventListener('click', () => selectProvider(p.id));
    list.appendChild(el);
  }

  $('#sidebar-foot-text').textContent = `共 ${providers.length} 个供应商 · 数据加密存储于本机`;
}

/* ---------------- 主区域 ---------------- */

function emptyStateHTML() {
  return `
    <div class="empty-state">
      <div class="big">🔑</div>
      <h2>添加你的第一个模型供应商</h2>
      <p>记录供应商名称、Base URL、API Key 与模型列表。支持一个供应商挂多个 Key、健康检测、导入导出。填好 URL 和 Key 后可以一键自动获取模型。</p>
      <button class="btn primary" id="btn-empty-add">＋ 添加供应商</button>
    </div>`;
}

function editorHTML() {
  const options = FORMATS.map(
    (f) => `<option value="${f.value}">${f.label}</option>`
  ).join('');
  const refreshIcon = ICONS.refresh.replace('<svg', '<svg width="13" height="13" style="vertical-align:-2px;margin-right:4px"');
  return `
    <div class="editor">
      <header class="editor-head">
        <div class="editor-title">
          <h1 id="editor-name"></h1>
          <span class="format-tag" id="editor-tag"></span>
        </div>
        <div class="editor-actions">
          <span class="dirty-dot" id="dirty-dot" hidden>● 未保存</span>
          <button class="btn ghost danger" id="btn-delete">删除</button>
          <button class="btn primary" id="btn-save">保存<kbd>${SAVE_KBD}</kbd></button>
        </div>
      </header>
      <div class="editor-body">
        <div class="grid2">
          <label class="field">
            <span class="field-label">供应商名称</span>
            <input id="f-name" type="text" placeholder="例如：OpenAI / DeepSeek / 智谱" maxlength="60" spellcheck="false">
          </label>
          <label class="field">
            <span class="field-label">API 格式</span>
            <select id="f-format">${options}</select>
          </label>
        </div>
        <label class="field">
          <span class="field-label">Base URL</span>
          <div class="input-group">
            <input id="f-url" type="url" spellcheck="false" autocapitalize="off">
            <button class="icon-btn" id="btn-copy-url" title="复制 URL">${ICONS.copy}</button>
          </div>
        </label>
        <section class="models-section keys-section">
          <div class="models-head">
            <span class="field-label">API Keys<span class="count" id="key-count">0</span></span>
            <div class="models-actions">
              <button class="btn" id="btn-check-keys">${refreshIcon}检测全部</button>
              <button class="btn" id="btn-add-key">＋ 添加 Key</button>
            </div>
          </div>
          <div class="key-rows" id="key-rows"></div>
          <p class="hint">★ 为主 Key：自动获取模型默认使用它。「检测」会请求列模型接口验证可用性并记录延迟。</p>
        </section>
        <section class="models-section">
          <div class="models-head">
            <span class="field-label">模型列表<span class="count" id="model-count">0</span></span>
            <div class="models-actions">
              <button class="btn" id="btn-fetch">${refreshIcon}自动获取模型</button>
              <button class="btn" id="btn-copy-all">复制全部</button>
            </div>
          </div>
          <div class="chips" id="chips"></div>
          <div class="models-add">
            <input id="f-model" type="text" placeholder="手动添加模型 ID，回车确认" spellcheck="false">
            <button class="btn" id="btn-add-model">添加</button>
          </div>
          <p class="hint">填好 Base URL（和主 Key）后点「自动获取模型」，获取后可勾选要保留的模型。本地服务（如 Ollama）可不填 Key。点击模型名即可复制。</p>
        </section>
      </div>
    </div>`;
}

function renderMain() {
  const main = $('#main');
  if (!draft) {
    main.innerHTML = emptyStateHTML();
    $('#btn-empty-add').addEventListener('click', newProvider);
    return;
  }
  main.innerHTML = editorHTML();

  $('#f-name').value = draft.name;
  $('#f-format').value = draft.format;
  $('#f-url').value = draft.baseUrl;
  $('#editor-name').textContent = draft.name.trim() || '新供应商';
  $('#editor-tag').textContent = FORMAT_LABEL[draft.format] || draft.format;

  renderKeys();
  renderModels();
  updateDirty();
  updateUrlPlaceholder();
  bindEditorEvents();
}

function updateUrlPlaceholder() {
  const fmt = FORMATS.find((f) => f.value === draft.format);
  $('#f-url').placeholder = fmt ? fmt.placeholder : '';
}

function updateDirty() {
  if (!draft) return;
  const dirty = isDirty();
  const dot = $('#dirty-dot');
  if (dot) dot.hidden = !dirty;
  const nameEl = $('#editor-name');
  if (nameEl) nameEl.textContent = draft.name.trim() || '新供应商';
  const tag = $('#editor-tag');
  if (tag) tag.textContent = FORMAT_LABEL[draft.format] || draft.format;
}

/* ---------------- Key 列表 ---------------- */

function renderModels() {
  const wrap = $('#chips');
  if (!wrap) return;
  wrap.textContent = '';
  $('#model-count').textContent = draft.models.length;

  if (draft.models.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'chips-empty';
    empty.textContent = '暂无模型，点击右上角「自动获取模型」或手动添加';
    wrap.appendChild(empty);
    return;
  }
  draft.models.forEach((m, idx) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = m;
    name.title = '点击复制';
    name.addEventListener('click', () => copyText(m, `模型 ${m}`));
    const x = document.createElement('button');
    x.className = 'chip-x';
    x.textContent = '×';
    x.title = '移除';
    x.addEventListener('click', () => {
      draft.models.splice(idx, 1);
      renderModels();
      updateDirty();
      renderSidebar();
    });
    chip.append(name, x);
    wrap.appendChild(chip);
  });
}

function renderKeyMeta(k, el) {
  el.className = 'key-meta';
  el.textContent = '';
  if (k.keyLost && !k.key) {
    el.classList.add('warn');
    el.textContent = '⚠ 之前保存的 Key 无法解密（系统钥匙串可能变化），请重新填写并保存。';
    return;
  }
  const ago = k.lastCheckedAt ? ` · ${timeAgo(k.lastCheckedAt)}检测` : '';
  if (k.status === 'ok') {
    el.innerHTML = `<span class="st ok">✓ 有效</span>${k.latencyMs != null ? ` · ${k.latencyMs}ms` : ''}${escapeHtml(ago)}`;
  } else if (k.status === 'invalid') {
    el.innerHTML = `<span class="st bad">✗ 失效</span>${k.lastError ? ` · ${escapeHtml(k.lastError)}` : ''}${escapeHtml(ago)}`;
  } else {
    el.textContent = '未检测';
  }
}

function renderKeys() {
  const wrap = $('#key-rows');
  if (!wrap) return;
  wrap.textContent = '';
  $('#key-count').textContent = draft.keys.length;

  if (draft.keys.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'keys-empty';
    empty.textContent = '还没有 Key，点击右上角「＋ 添加 Key」';
    wrap.appendChild(empty);
  }

  draft.keys.forEach((k, idx) => {
    const row = document.createElement('div');
    row.className = 'key-row';

    const main = document.createElement('div');
    main.className = 'key-row-main';

    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'star' + (idx === 0 ? ' active' : '');
    star.textContent = idx === 0 ? '★' : '☆';
    star.title = idx === 0 ? '主 Key' : '设为主 Key';
    star.addEventListener('click', () => {
      if (idx === 0) return;
      const [moved] = draft.keys.splice(idx, 1);
      draft.keys.unshift(moved);
      renderKeys();
      updateDirty();
    });

    const label = document.createElement('input');
    label.type = 'text';
    label.className = 'key-label';
    label.placeholder = '标签（如 主力）';
    label.maxLength = 60;
    label.spellcheck = false;
    label.value = k.label;
    label.addEventListener('input', () => {
      k.label = label.value;
      updateDirty();
    });

    const val = document.createElement('input');
    val.type = 'password';
    val.className = 'key-val';
    val.placeholder = 'sk-…';
    val.spellcheck = false;
    val.autocomplete = 'off';
    val.value = k.key;
    val.addEventListener('input', () => {
      k.key = val.value;
      if (k.keyLost && val.value) k.keyLost = false;
      renderKeyMeta(k, metaEl);
      updateDirty();
    });

    const eye = iconBtn(ICONS.eye, '显示 / 隐藏');
    eye.addEventListener('click', () => {
      const show = val.type === 'password';
      val.type = show ? 'text' : 'password';
      eye.innerHTML = show ? ICONS.eyeOff : ICONS.eye;
    });

    const copy = iconBtn(ICONS.copy, '复制 Key');
    copy.addEventListener('click', () => copyText(k.key, `Key${k.label ? `（${k.label}）` : ''}`));

    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'btn key-check';
    check.textContent = '检测';
    check.addEventListener('click', () => checkKeyRow(k, check));

    const del = iconBtn('×', '删除此 Key');
    del.style.fontSize = '15px';
    del.addEventListener('click', () => {
      draft.keys.splice(idx, 1);
      renderKeys();
      updateDirty();
      renderSidebar();
    });

    main.append(star, label, val, eye, copy, check, del);

    const metaEl = document.createElement('div');
    renderKeyMeta(k, metaEl);

    row.append(main, metaEl);
    wrap.appendChild(row);
  });
}

/** 把检测结果同步进已保存记录并落盘（status 字段不计入脏标记） */
async function persistKeyStatus(providerId, keyId, fields) {
  const saved = providers.find((p) => p.id === providerId);
  if (!saved) return;
  const sk = (saved.keys || []).find((x) => x.id === keyId);
  if (!sk) return;
  Object.assign(sk, fields);
  try { await api.saveProviders(providers); } catch (_) { /* 状态落盘失败不阻塞 */ }
}

async function checkKeyRow(k, btn) {
  const baseUrl = $('#f-url').value.trim();
  const format = $('#f-format').value;
  if (!baseUrl) {
    toast('请先填写 Base URL', 'error');
    $('#f-url').focus();
    return;
  }
  if (!k.key) {
    toast('该 Key 为空，先填写再检测', 'error');
    return;
  }
  btn.disabled = true;
  btn.textContent = '检测中…';
  try {
    const r = await api.checkKey({ format, baseUrl, apiKey: k.key });
    k.status = r.ok ? 'ok' : 'invalid';
    k.latencyMs = r.latencyMs;
    k.lastCheckedAt = new Date().toISOString();
    k.lastError = r.ok ? '' : String(r.error || '');
    renderKeys();
    renderSidebar();
    persistKeyStatus(draft.id, k.id, {
      status: k.status, latencyMs: k.latencyMs, lastCheckedAt: k.lastCheckedAt, lastError: k.lastError,
    });
    toast(r.ok ? `Key 有效 · ${r.latencyMs}ms` : `Key 失效：${r.error}`, r.ok ? 'success' : 'error');
  } catch (err) {
    toast(String((err && err.message) || err), 'error');
  } finally {
    if (btn.isConnected) {
      btn.disabled = false;
      btn.textContent = '检测';
    }
  }
}

async function checkAllKeysInDraft() {
  const baseUrl = $('#f-url').value.trim();
  if (!baseUrl) {
    toast('请先填写 Base URL', 'error');
    $('#f-url').focus();
    return;
  }
  const targets = draft.keys.filter((k) => k.key);
  if (!targets.length) {
    toast('没有可检测的 Key', 'error');
    return;
  }
  const btn = $('#btn-check-keys');
  btn.disabled = true;
  const oldHtml = btn.innerHTML;
  let okCount = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      const k = targets[i];
      btn.textContent = `检测中 ${i + 1}/${targets.length}…`;
      const r = await api.checkKey({ format: $('#f-format').value, baseUrl, apiKey: k.key });
      k.status = r.ok ? 'ok' : 'invalid';
      k.latencyMs = r.latencyMs;
      k.lastCheckedAt = new Date().toISOString();
      k.lastError = r.ok ? '' : String(r.error || '');
      if (r.ok) okCount += 1;
      persistKeyStatus(draft.id, k.id, {
        status: k.status, latencyMs: k.latencyMs, lastCheckedAt: k.lastCheckedAt, lastError: k.lastError,
      });
      renderKeys();
      renderSidebar();
    }
    toast(`检测完成：${okCount} 有效 / ${targets.length - okCount} 失效`, okCount === targets.length ? 'success' : '');
  } catch (err) {
    toast(String((err && err.message) || err), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = oldHtml;
  }
}

let globalChecking = false;

/** 侧栏「检测全部」：遍历所有供应商的所有已填 Key，逐个检测并实时更新状态点 */
async function checkEverything() {
  if (globalChecking) return;
  const tasks = [];
  for (const p of providers) {
    for (const k of p.keys || []) {
      if (k.key) tasks.push({ p, k });
    }
  }
  if (!tasks.length) {
    toast('没有可检测的 Key（Key 为空的会跳过）', 'error');
    return;
  }
  globalChecking = true;
  const btn = $('#btn-check-all');
  btn.disabled = true;
  const oldText = btn.textContent;
  let okCount = 0;
  try {
    for (let i = 0; i < tasks.length; i++) {
      const { p, k } = tasks[i];
      btn.textContent = `检测中 ${i + 1}/${tasks.length}`;
      let r;
      try {
        r = await api.checkKey({ format: p.format, baseUrl: p.baseUrl, apiKey: k.key });
      } catch (err) {
        r = { ok: false, latencyMs: 0, error: String((err && err.message) || err) };
      }
      k.status = r.ok ? 'ok' : 'invalid';
      k.latencyMs = r.latencyMs;
      k.lastCheckedAt = new Date().toISOString();
      k.lastError = r.ok ? '' : String(r.error || '');
      if (r.ok) okCount += 1;
      if (draft && draft.id === p.id) {
        const dk = (draft.keys || []).find((x) => x.id === k.id);
        if (dk) {
          Object.assign(dk, {
            status: k.status, latencyMs: k.latencyMs, lastCheckedAt: k.lastCheckedAt, lastError: k.lastError,
          });
          if ($('#key-rows')) renderKeys();
        }
      }
      renderSidebar();
    }
    try { await api.saveProviders(providers); } catch (_) { /* 落盘失败不阻塞提示 */ }
    const bad = tasks.length - okCount;
    toast(`全部检测完成：${okCount} 有效${bad ? `，${bad} 失效` : ''}`, bad ? '' : 'success');
  } finally {
    globalChecking = false;
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

/* ---------------- 编辑器事件 ---------------- */

let sidebarRefreshTimer = null;

function bindEditorEvents() {
  $('#f-name').addEventListener('input', (e) => {
    draft.name = e.target.value;
    scheduleLightRefresh();
  });
  $('#f-url').addEventListener('input', (e) => {
    draft.baseUrl = e.target.value.trim();
    scheduleLightRefresh();
  });
  $('#f-format').addEventListener('change', (e) => {
    draft.format = e.target.value;
    const fmt = FORMATS.find((f) => f.value === draft.format);
    if (!draft.baseUrl && fmt) {
      draft.baseUrl = fmt.placeholder; // 切格式且 URL 为空时给默认值
      $('#f-url').value = draft.baseUrl;
    }
    updateUrlPlaceholder();
    updateDirty();
    renderSidebar();
  });

  $('#btn-copy-url').addEventListener('click', () => copyText(draft.baseUrl, 'Base URL'));

  $('#btn-add-key').addEventListener('click', () => {
    draft.keys.push(newKeyRecord());
    renderKeys();
    updateDirty();
    renderSidebar();
    const rows = document.querySelectorAll('#key-rows .key-val');
    if (rows.length) rows[rows.length - 1].focus();
  });
  $('#btn-check-keys').addEventListener('click', checkAllKeysInDraft);

  $('#btn-fetch').addEventListener('click', fetchModelsAction);
  $('#btn-copy-all').addEventListener('click', () => copyText(draft.models.join('\n'), '全部模型'));
  $('#btn-add-model').addEventListener('click', addModelFromInput);
  $('#f-model').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addModelFromInput();
    }
  });

  $('#btn-save').addEventListener('click', save);
  $('#btn-delete').addEventListener('click', removeProvider);
}

/** 输入时只刷新脏标记与侧栏预览，避免整页重绘导致输入焦点丢失 */
function scheduleLightRefresh() {
  updateDirty();
  clearTimeout(sidebarRefreshTimer);
  sidebarRefreshTimer = setTimeout(renderSidebar, 250);
}

function addModelFromInput() {
  const input = $('#f-model');
  const name = input.value.trim();
  if (!name) return;
  if (draft.models.includes(name)) {
    toast('该模型已存在', 'error');
    return;
  }
  draft.models.push(name);
  draft.models.sort((a, b) => a.localeCompare(b));
  input.value = '';
  renderModels();
  updateDirty();
  renderSidebar();
  input.focus();
}

/* ---------------- 自动获取模型 → 勾选保留 ---------------- */

async function fetchModelsAction() {
  const baseUrl = $('#f-url').value.trim();
  const format = $('#f-format').value;
  if (!baseUrl) {
    toast('请先填写 Base URL', 'error');
    $('#f-url').focus();
    return;
  }
  const primary = draft.keys[0];
  const apiKey = primary ? primary.key.trim() : '';
  const btn = $('#btn-fetch');
  btn.disabled = true;
  const oldHtml = btn.innerHTML;
  btn.textContent = '获取中…';
  try {
    const res = await api.fetchModels({ format, baseUrl, apiKey });
    draft.baseUrl = baseUrl;
    draft.format = format;
    renderModels();
    updateDirty();
    renderSidebar();
    toast(`已获取 ${res.models.length} 个模型（${hostOf(res.endpoint)}），请勾选要保留的`, 'success');
    openModelPicker(res.models);
  } catch (err) {
    toast(String((err && err.message) || err), 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = oldHtml;
  }
}

function openModelPicker(fetched) {
  const existing = new Set(draft.models);
  const state = new Map(fetched.map((m) => [m, true])); // 默认全选
  openModal(`
    <div class="modal-title">选择要保留的模型 <span class="count">${fetched.length}</span></div>
    <div class="picker-tools">
      <input id="picker-search" type="search" placeholder="搜索模型…" spellcheck="false">
      <button class="btn" id="picker-all">全选</button>
      <button class="btn" id="picker-none">全不选</button>
    </div>
    <div class="picker-list" id="picker-list"></div>
    <div class="modal-foot">
      <span class="hint" id="picker-hint"></span>
      <div class="modal-foot-btns">
        <button class="btn" id="picker-append">追加勾选</button>
        <button class="btn primary" id="picker-replace">用勾选替换</button>
        <button class="btn" id="picker-cancel">取消</button>
      </div>
    </div>`);

  const list = $('#picker-list');
  const search = $('#picker-search');

  const checkedCount = () => {
    let n = 0;
    state.forEach((v) => { if (v) n += 1; });
    return n;
  };
  const updateHint = () => {
    $('#picker-hint').textContent = `已勾选 ${checkedCount()} / ${fetched.length}`;
  };
  const renderList = () => {
    const q = search.value.trim().toLowerCase();
    list.textContent = '';
    const items = fetched.filter((m) => !q || m.toLowerCase().includes(q));
    if (!items.length) {
      const e = document.createElement('div');
      e.className = 'picker-empty';
      e.textContent = '没有匹配的模型';
      list.appendChild(e);
    }
    for (const m of items) {
      const row = document.createElement('label');
      row.className = 'picker-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.get(m);
      cb.addEventListener('change', () => {
        state.set(m, cb.checked);
        updateHint();
      });
      const name = document.createElement('span');
      name.className = 'picker-name';
      name.textContent = m;
      name.title = m;
      row.append(cb, name);
      if (existing.has(m)) {
        const tag = document.createElement('span');
        tag.className = 'picker-tag';
        tag.textContent = '已有';
        row.appendChild(tag);
      }
      list.appendChild(row);
    }
  };

  renderList();
  updateHint();
  search.addEventListener('input', renderList);
  $('#picker-all').addEventListener('click', () => {
    fetched.forEach((m) => state.set(m, true));
    renderList();
    updateHint();
  });
  $('#picker-none').addEventListener('click', () => {
    fetched.forEach((m) => state.set(m, false));
    renderList();
    updateHint();
  });
  $('#picker-cancel').addEventListener('click', closeModal);
  $('#picker-append').addEventListener('click', () => applyPicker(state, 'append'));
  $('#picker-replace').addEventListener('click', () => applyPicker(state, 'replace'));
  search.focus();
}

function applyPicker(state, mode) {
  const picked = [];
  state.forEach((v, k) => { if (v) picked.push(k); });
  picked.sort((a, b) => a.localeCompare(b));
  draft.models = mode === 'replace'
    ? picked
    : [...new Set([...draft.models, ...picked])].sort((a, b) => a.localeCompare(b));
  closeModal();
  renderModels();
  updateDirty();
  renderSidebar();
  toast(mode === 'replace'
    ? `已替换为 ${picked.length} 个模型`
    : `已追加，现共 ${draft.models.length} 个模型`, 'success');
}

/* ---------------- 导入 / 导出 ---------------- */

function openExportDialog() {
  if (!providers.length) {
    toast('还没有可导出的供应商', 'error');
    return;
  }
  openModal(`
    <div class="modal-title">导出供应商（共 ${providers.length} 个）</div>
    <label class="modal-check"><input type="checkbox" id="exp-keys"> 包含 API Key（<b>明文</b>，请妥善保管导出文件）</label>
    <div class="modal-foot">
      <span class="hint">不包含 Key 时仅导出名称 / URL / 模型列表。</span>
      <div class="modal-foot-btns">
        <button class="btn" id="exp-cancel">取消</button>
        <button class="btn primary" id="exp-go">导出 JSON</button>
      </div>
    </div>`);
  $('#exp-cancel').addEventListener('click', closeModal);
  $('#exp-go').addEventListener('click', async () => {
    const includeKeys = $('#exp-keys').checked;
    try {
      const r = await api.exportProviders({ providers, includeKeys });
      if (r.canceled) return;
      closeModal();
      toast(`已导出 ${r.count} 个供应商${r.withKeys ? '（含 Key）' : ''}\n${r.filePath}`, 'success');
    } catch (err) {
      toast(String((err && err.message) || err), 'error');
    }
  });
}

async function importAction() {
  try {
    const r = await api.importProviders();
    if (r.canceled) return;
    if (!r.providers || !r.providers.length) {
      toast('文件里没有可导入的内容', 'error');
      return;
    }
    const result = IMPORT.mergeProviders(providers, r.providers);
    providers = result.providers;
    await api.saveProviders(providers);
    renderSidebar();
    const parts = [`新增 ${result.added} 个`];
    if (result.merged) parts.push(`合并 ${result.merged} 个`);
    if (result.addedKeys) parts.push(`新增 Key ${result.addedKeys} 个`);
    if (result.skippedKeys) parts.push(`跳过重复 Key ${result.skippedKeys} 个`);
    toast(`导入完成（识别为 ${r.format} 格式）：${parts.join('，')}`, 'success');
  } catch (err) {
    toast(String((err && err.message) || err), 'error');
  }
}

/* ---------------- 保存 / 删除 / 切换 ---------------- */

async function save() {
  if (!draft) return;
  draft.updatedAt = new Date().toISOString();
  if (!draft.createdAt) draft.createdAt = draft.updatedAt;

  const exists = providers.find((p) => p.id === draft.id);
  const record = {
    id: draft.id,
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    format: draft.format,
    keys: draft.keys.map((k) => ({
      id: k.id,
      label: String(k.label || '').trim(),
      key: String(k.key || '').trim(),
      status: k.status || 'unknown',
      latencyMs: k.latencyMs,
      lastCheckedAt: k.lastCheckedAt || '',
      lastError: k.lastError || '',
      keyLost: !!k.keyLost && !String(k.key || '').trim(),
    })),
    models: [...new Set(draft.models.map((m) => m.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
  if (exists) Object.assign(exists, record);
  else providers.unshift(record);

  providers.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  draft = clone(record);

  await api.saveProviders(providers);
  renderSidebar();
  updateDirty();
  toast('已保存', 'success');
}

async function removeProvider() {
  if (!draft) return;
  const saved = providers.find((p) => p.id === draft.id);
  if (!saved) {
    // 新供应商未保存，直接清空
    draft = null;
    renderMain();
    renderSidebar();
    return;
  }
  if (!window.confirm(`确定删除供应商「${saved.name || '未命名'}」？此操作不可撤销。`)) return;
  providers = providers.filter((p) => p.id !== draft.id);
  await api.saveProviders(providers);
  draft = providers[0] ? clone(providers[0]) : null;
  renderMain();
  renderSidebar();
  toast('已删除', 'success');
}

/** 处理未保存更改后切换；choice: 0 保存 / 1 放弃 / 2 取消 */
async function handleUnsaved() {
  if (!isDirty()) return true;
  const choice = await api.confirmUnsaved();
  if (choice === 2) return false;
  if (choice === 0) await save();
  return true;
}

async function selectProvider(id) {
  if (draft && draft.id === id) return;
  if (!(await handleUnsaved())) return;
  const found = providers.find((p) => p.id === id);
  draft = found ? clone(found) : null;
  renderMain();
  renderSidebar();
}

async function newProvider() {
  if (!(await handleUnsaved())) return;
  const now = new Date().toISOString();
  draft = {
    id: uid(),
    name: '',
    baseUrl: '',
    format: 'openai',
    keys: [],
    models: [],
    createdAt: now,
    updatedAt: now,
  };
  renderMain();
  renderSidebar();
  $('#f-name').focus();
}

/* ---------------- 启动 ---------------- */

async function init() {
  try {
    providers = await api.loadProviders();
  } catch (err) {
    providers = [];
    toast('读取本地数据失败：' + err.message, 'error');
  }
  providers.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  draft = providers[0] ? clone(providers[0]) : null;

  renderSidebar();
  renderMain();

  $('#btn-add').addEventListener('click', newProvider);
  $('#search').addEventListener('input', (e) => {
    query = e.target.value;
    renderSidebar();
  });
  $('#btn-check-all').addEventListener('click', checkEverything);
  $('#btn-export').addEventListener('click', openExportDialog);
  $('#btn-import').addEventListener('click', importAction);

  $('#modal-root').addEventListener('mousedown', (e) => {
    if (e.target.id === 'modal-root') closeModal();
  });

  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape' && !$('#modal-root').hidden) {
      closeModal();
    }
  });

  // 有未保存更改时拦截窗口关闭，防止误关丢 Key
  window.addEventListener('beforeunload', (e) => {
    if (isDirty() && !window.confirm('有未保存的更改，确定要关闭吗？')) {
      e.preventDefault();
      e.returnValue = false;
    }
  });
}

init();
