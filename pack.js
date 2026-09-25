'use strict';

/**
 * 平台感知打包脚本：自动按宿主/目标平台选择 Electron 发行包与图标。
 *   node pack.js          打当前平台的包
 *   node pack.js --win    交叉打包 Windows（在 mac/linux 上运行）
 *   node pack.js --linux  交叉打包 Linux
 *   node pack.js --arm64  指定 arm64（默认取 process.arch）
 *
 * 注意：交叉打包 win32 必须安装 Wine（electron-packager 无条件写入 exe 元数据）；
 * 没有 Wine 时会快速失败并提示。正式发布建议在目标系统上原生 `npm run pack`。
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const platform = args.includes('--win') ? 'win32'
  : args.includes('--linux') ? 'linux'
    : process.platform;
const arch = args.includes('--arm64') ? 'arm64' : process.arch;
const cross = platform !== process.platform;

const VERSION = require('./package.json').version;

const ICONS = {
  darwin: 'build/icon.icns',
  win32: 'build/icon.ico',
  linux: 'build/icon.png',
};

// electron-packager 总会把 package.json 版本号写进 exe 元数据（rcedit），
// 因此在非 Windows 宿主上交叉打包 win32 必须安装 Wine，无法跳过。
const hasWine = (() => {
  if (process.platform === 'win32') return true;
  try { execFileSync('which', ['wine'], { stdio: 'pipe' }); return true; }
  catch (_) { return false; }
})();
if (platform === 'win32' && !hasWine) {
  console.error('✗ 交叉打包 win32 需要 Wine（electron-packager 会无条件写入 exe 元数据）。');
  console.error('  方案一：在 Windows 机器上原生打包 —— git clone 本仓库 → npm install → npm run pack');
  console.error('  方案二：本机安装 Wine 后重试（brew install --cask wine-stable）');
  process.exit(1);
}
let icon = ICONS[platform];
if (icon && !fs.existsSync(path.join(__dirname, icon))) {
  console.log(`※ 未找到 ${icon}，跳过图标。`);
  icon = null;
}

const ignores = [
  'test',
  'dist',
  'graphflow-out',
  '.graphflow-cache',
  '.git',
  '.github',
];

const argv = [
  '.',
  'API Key Manager',
  '--overwrite',
  `--platform=${platform}`,
  `--arch=${arch}`,
  ...(icon ? [`--icon=${icon}`] : []),
  `--app-version=${VERSION}`,
  '--out=dist',
  '--prune=true',
  ...ignores.map((i) => `--ignore=${i}`),
];

console.log(`打包: platform=${platform} arch=${arch} version=${VERSION} icon=${icon || '无'}`);
try {
  execFileSync(path.join(__dirname, 'node_modules', '.bin', 'electron-packager'), argv, { stdio: 'inherit' });
} catch (err) {
  console.error(`打包失败：${err.message}`);
  console.error('提示：交叉打包需要先下载对应平台的 Electron 发行包（约 100MB），网络失败时请重试或在目标平台上原生打包。');
  process.exit(1);
}
