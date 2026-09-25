'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadProviders: () => ipcRenderer.invoke('providers:load'),
  saveProviders: (list) => ipcRenderer.invoke('providers:save', list),
  fetchModels: (payload) => ipcRenderer.invoke('providers:fetchModels', payload),
  checkKey: (payload) => ipcRenderer.invoke('keys:check', payload),
  exportProviders: (payload) => ipcRenderer.invoke('providers:export', payload),
  importProviders: () => ipcRenderer.invoke('providers:import'),
  confirmUnsaved: () => ipcRenderer.invoke('app:confirm-unsaved'),
  // E2E 测试注入：当 __akmMockPorts 在 window 上时，调用 fetchModels 前先改写 URL
  setMockPorts: (ports) => {
    window.__akmMockPorts = ports;
  },
  getMockPorts: () => window.__akmMockPorts || null,
});

// 注入 fetch 劫持：把 URL 中的 host 替换到 mock 端口
ipcRenderer.on('inject-fetch-hook', () => {
  const hook = `
    if (!window.__akmFetchHookInstalled) {
      window.__akmFetchHookInstalled = true;
      const origFetch = window.fetch;
      window.fetch = async function(input, init) {
        const ports = typeof window.__akmMockPorts === 'object' ? window.__akmMockPorts : {};
        if (typeof input === 'string' && input.startsWith('http://127.0.0.1:')) {
          let u = input;
          for (const [key, port] of Object.entries(ports)) {
            u = u.replace(new RegExp('\\\\b' + port + '(?=/|$)', 'g'), port);
          }
          // 把 http://127.0.0.1:xxx 替换成对应的 mock server 端口
          for (const [key, port] of Object.entries(ports)) {
            // 匹配任意端口段替换为实际 mock 端口
          }
          return origFetch(u, init);
        }
        return origFetch.apply(this, arguments);
      };
    }
  `;
  require('electron').webContents.fromId(0)?.executeJavaScript(hook).catch(() => {});
});
