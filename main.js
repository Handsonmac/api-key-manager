'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, safeStorage, nativeTheme } = require('electron');
const { fetchModels, checkKey } = require('./lib/fetch-models');
const { normalizeKey, migrateProvider, backupNamesToDelete } = require('./lib/model');
const { parseImportText } = require('./lib/import');

const FORMATS = ['openai', 'anthropic', 'gemini'];

if (process.env.AKM_DATA_DIR) app.setPath('userData', process.env.AKM_DATA_DIR);

const MOCK_PORTS = parseMockPorts();

function parseMockPorts() {
  const args = process.argv;
  const idx = args.indexOf('--mock-ports');
  if (idx === -1 || !args[idx + 1]) return null;
  try { return JSON.parse(args[idx + 1]); } catch (_) { return null; }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100, height: 720, minWidth: 900, minHeight: 600,
    title: 'API Key 管理器',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1014' : '#f4f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (MOCK_PORTS) {
    win.webContents.on('did-finish-load', () => {
      win.webContents.executeJavaScript(
        'if (window.api && window.api.setMockPorts) window.api.setMockPorts(' + JSON.stringify(MOCK_PORTS) + ');'
      ).catch(() => {});
    });
  }
}

function dataFile() { return path.join(app.getPath('userData'), 'providers.json'); }

function readRaw() {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

/** 把磁盘上的旧/新结构记录解密成渲染层使用的明文视图（keys[].key） */
function loadProvider(p, canEncrypt) {
  const base = {
    id: String(p.id || ''),
    name: String(p.name || ''),
    baseUrl: String(p.baseUrl || ''),
    format: FORMATS.includes(p.format) ? p.format : 'openai',
    models: Array.isArray(p.models) ? p.models.map(String) : [],
    createdAt: p.createdAt || '',
    updatedAt: p.updatedAt || '',
  };

  const decrypt = (enc) => {
    if (!canEncrypt) return { lost: true, key: '' };
    try { return { lost: false, key: safeStorage.decryptString(Buffer.from(enc, 'base64')) }; }
    catch (_) { return { lost: true, key: '' }; }
  };

  if (Array.isArray(p.keys) && p.keys.length) {
    base.keys = p.keys.map((k) => {
      const norm = normalizeKey(k);
      const out = {
        id: norm.id, label: norm.label, key: '',
        status: norm.status, latencyMs: norm.latencyMs, lastCheckedAt: norm.lastCheckedAt,
        lastError: norm.lastError,
        keyLost: false,
      };
      if (k.apiKeyEnc) {
        const r = decrypt(k.apiKeyEnc);
        out.key = r.key;
        out.keyLost = r.lost;
      } else {
        out.key = norm.key; // 未启用加密时写入的明文
      }
      return out;
    });
    return base;
  }

  // 旧结构：顶层 apiKey / apiKeyEnc → 包装成单个「默认」Key
  const view = { ...p };
  let lost = false;
  if (p.apiKeyEnc) {
    const r = decrypt(p.apiKeyEnc);
    view.apiKey = r.key;
    lost = r.lost;
  }
  const migrated = migrateProvider(view);
  base.keys = migrated.keys.map((k) => ({
    id: k.id, label: k.label, key: k.key,
    status: k.status, latencyMs: k.latencyMs, lastCheckedAt: k.lastCheckedAt,
    lastError: k.lastError,
    keyLost: lost,
  }));
  return base;
}

ipcMain.handle('providers:load', () => {
  const canEncrypt = safeStorage.isEncryptionAvailable();
  return readRaw().map((p) => loadProvider(p, canEncrypt));
});

const BACKUP_KEEP = 10;

function backupBeforeWrite() {
  const file = dataFile();
  if (!fs.existsSync(file)) return;
  const dir = path.join(app.getPath('userData'), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  try { fs.copyFileSync(file, path.join(dir, `providers-${stamp}.json`)); } catch (_) { return; }
  const names = fs.readdirSync(dir).filter((n) => /^providers-.*\.json$/.test(n));
  for (const n of backupNamesToDelete(names, BACKUP_KEEP)) {
    try { fs.unlinkSync(path.join(dir, n)); } catch (_) { /* 忽略单个删除失败 */ }
  }
}

ipcMain.handle('providers:save', (_event, providers) => {
  if (!Array.isArray(providers)) throw new Error('数据格式不正确');
  const canEncrypt = safeStorage.isEncryptionAvailable();
  const out = providers.map((p) => {
    const rec = {
      id: String(p.id || ''),
      name: String(p.name || '').slice(0, 100),
      baseUrl: String(p.baseUrl || '').slice(0, 500),
      format: FORMATS.includes(p.format) ? p.format : 'openai',
      models: Array.isArray(p.models) ? [...new Set(p.models.map(String))].slice(0, 2000) : [],
      createdAt: p.createdAt || new Date().toISOString(),
      updatedAt: p.updatedAt || new Date().toISOString(),
      keys: [],
    };
    rec.keys = (Array.isArray(p.keys) ? p.keys : []).map((k) => {
      const norm = normalizeKey(k);
      const item = {
        id: norm.id, label: norm.label,
        status: norm.status, latencyMs: norm.latencyMs, lastCheckedAt: norm.lastCheckedAt,
        lastError: norm.lastError,
      };
      const key = String(k && k.key || '').trim();
      if (key && canEncrypt) item.apiKeyEnc = safeStorage.encryptString(key).toString('base64');
      else if (key) item.key = key;
      return item;
    });
    // 兼容旧版应用：主 Key（第一个有值的）同时写到顶层
    const primary = rec.keys.find((k) => k.apiKeyEnc || k.key);
    if (primary) {
      if (primary.apiKeyEnc) rec.apiKeyEnc = primary.apiKeyEnc;
      else rec.apiKey = primary.key;
    }
    return rec;
  });
  backupBeforeWrite();
  fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
  fs.writeFileSync(dataFile(), JSON.stringify(out, null, 2), 'utf8');
  return true;
});

ipcMain.handle('keys:check', (_event, payload) => {
  const { format, baseUrl, apiKey } = payload || {};
  return checkKey(format, baseUrl, apiKey);
});

ipcMain.handle('providers:export', async (event, payload) => {
  const { providers, includeKeys } = payload || {};
  if (!Array.isArray(providers)) throw new Error('数据格式不正确');
  const win = BrowserWindow.fromWebContents(event.sender);
  const stamp = new Date().toISOString().slice(0, 10);
  const res = await dialog.showSaveDialog(win, {
    title: '导出供应商',
    defaultPath: `api-key-manager-${stamp}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  const data = providers.map((p) => {
    const rec = {
      name: String(p.name || ''),
      baseUrl: String(p.baseUrl || ''),
      format: p.format,
      models: Array.isArray(p.models) ? p.models : [],
      createdAt: p.createdAt || '',
      updatedAt: p.updatedAt || '',
    };
    if (includeKeys) {
      rec.keys = (Array.isArray(p.keys) ? p.keys : [])
        .map((k) => ({ label: String(k.label || ''), key: String(k.key || '') }))
        .filter((k) => k.key);
    }
    return rec;
  });
  fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2), 'utf8');
  return { canceled: false, filePath: res.filePath, count: data.length, withKeys: !!includeKeys };
});

ipcMain.handle('providers:import', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, {
    title: '导入供应商',
    filters: [
      { name: '支持的文件（JSON / TXT / CSV / ENV）', extensions: ['json', 'txt', 'csv', 'env'] },
      { name: '全部文件', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return { canceled: true };
  const text = fs.readFileSync(res.filePaths[0], 'utf8');
  const parsed = parseImportText(text);
  return { canceled: false, format: parsed.format, providers: parsed.providers, filePath: res.filePaths[0] };
});

ipcMain.handle('providers:fetchModels', (_event, payload) => {
  const { format, baseUrl, apiKey } = payload || {};
  return fetchModels(format, baseUrl, apiKey);
});

ipcMain.handle('app:confirm-unsaved', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return dialog.showMessageBoxSync(win, {
    type: 'warning', message: '有未保存的更改',
    detail: '当前供应商的内容尚未保存，切换前想怎么处理？',
    buttons: ['保存并切换', '放弃更改', '取消'],
    defaultId: 0, cancelId: 2, noLink: true,
  });
});
