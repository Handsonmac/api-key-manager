'use strict';

/**
 * 简单的 HTTP 服务器，用于在 E2E 测试中提供 renderer 文件。
 * Electron 加载 http://localhost:PORT 而非 file:// 可以绕过 CSP 对 file:// 的限制。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

function getContentType(ext) {
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
  return types[ext] || 'application/octet-stream';
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let filePath = path.join(RENDERER_DIR, req.url === '/' ? 'index.html' : req.url);
      const ext = path.extname(filePath);
      res.setHeader('Content-Type', getContentType(ext));
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
        } else {
          res.writeHead(200);
          res.end(data);
        }
      });
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

module.exports = { startServer };
