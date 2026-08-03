'use strict';
/**
 * 双击本文件打开 MP3 合成器界面（隐藏控制台窗口）。
 * 需要: 同目录下的 merge-gui.js 和 merge-mp3.js
 */
const { spawn } = require('child_process');
const path = require('path');

// 定位 node（便携版优先：内置 runtime\node.exe -> 同目录 node.exe -> 系统 node）
function findNode() {
  const fs = require('fs');
  const cands = [
    path.join(__dirname, 'runtime', 'node.exe'),  // 内置运行时（随文件夹一起拷贝）
    path.join(__dirname, 'node.exe'),             // 同目录
    process.execPath,                             // 当前 node
    'C:\\Program Files\\nodejs\\node.exe',
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return 'node';
}

const node = findNode();
const script = path.join(__dirname, 'merge-gui.js');

// 杀掉上次启动残留的服务进程（双击多次只保留最新一个实例）
const fs = require('fs');
const pidFile = path.join(__dirname, '服务.pid');
try {
  if (fs.existsSync(pidFile)) {
    const old = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
    if (old && old !== process.pid) {
      spawn('taskkill', ['/F', '/PID', String(old)], { stdio: 'ignore' });
    }
  }
} catch { /* 忽略 */ }

const child = spawn(node, [script], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  detached: false,
});

let buf = '';
child.stdout.on('data', (d) => { buf += d; });
child.stderr.on('data', (d) => { buf += d; });

child.on('error', (e) => {
  require('fs').writeFileSync(path.join(__dirname, '启动日志.txt'),
    '启动失败: ' + e.message + '\n请确认 node 已安装。', 'utf8');
});

// 若 5 秒内没打印出 URL 也没退出，说明服务端异常，写日志
const t = setTimeout(() => {
  if (!buf.includes('已启动')) {
    require('fs').writeFileSync(path.join(__dirname, '启动日志.txt'),
      '服务启动异常:\n' + buf, 'utf8');
  }
}, 5000);
child.on('exit', () => clearTimeout(t));
