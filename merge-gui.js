#!/usr/bin/env node
/**
 * merge-gui.js — MP3 合成器可视化界面（本地服务）
 *
 * 双击「启动合成器.vbs」或「启动合成器.bat」即可打开浏览器界面。
 * 复用 merge-mp3.js 的探测/无损拼接/FFmpeg 回退引擎。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { probeFile, signature, mergeLossless, mergeWithFfmpeg, mergeWithFadeOutIn, parseHeader, id3v2Size } = require('./merge-mp3.js');

// ---------- 工具 ----------
const fmt = (n) => {
  if (n == null) return '-';
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
};

/** 统计一个 MP3 文件的帧数/时长（逐帧解析） */
function countFrames(file) {
  const buf = fs.readFileSync(file);
  let pos = id3v2Size(buf);
  let frames = 0;
  let first = null;
  while (pos + 4 <= buf.length) {
    if (pos + 128 <= buf.length && buf.toString('latin1', pos, pos + 3) === 'TAG') break;
    const h = parseHeader(buf, pos);
    if (!h) break;
    if (!first) first = h;
    frames++;
    pos += h.frameLen;
  }
  if (!first || frames === 0) return null;
  const spp = first.version === '1' ? 1152 : 576;
  return { frames, durSec: (frames * spp) / first.sr, sr: first.sr };
}

/** 列出目录：文件夹 + mp3（mp3 附解析信息） */
function browse(dir) {
  const abs = path.resolve(dir);
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const folders = [];
  const songs = [];
  for (const e of entries) {
    const p = path.join(abs, e.name);
    try {
      if (e.isDirectory()) {
        folders.push({ name: e.name, path: p });
      } else if (e.name.toLowerCase().endsWith('.mp3')) {
        const st = fs.statSync(p);
        const pr = probeFile(p);
        let info = null;
        if (pr) {
          const h = pr.header;
          info = { sr: h.sr, br: h.br, ch: h.chMode, ver: h.version, layer: h.layer };
        }
        songs.push({ name: e.name, path: p, size: st.size, info });
      }
    } catch { /* 跳过无法访问的条目 */ }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  songs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const parent = path.dirname(abs) === abs ? null : path.dirname(abs);
  return { dir: abs, parent, folders, songs };
}

/** 执行合成（复用 merge-mp3.js 引擎） */
/** 输出文件自动去重：同名已存在则追加序号，如 merged.mp3 → merged (1).mp3 */
function uniquePath(out) {
  const dir = path.dirname(out);
  const ext = path.extname(out);
  const base = path.basename(out, ext);
  let candidate = out;
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
    i++;
  }
  return candidate;
}

async function doMerge(files, out, fadeSec) {
  // 校验输出路径：父目录必须存在且可写（避免 EPERM/EACCES 等权限错误）
  const outDir = path.dirname(path.resolve(out));
  if (!fs.existsSync(outDir)) {
    return { ok: false, error: `输出目录不存在: ${outDir}` };
  }
  try {
    const probe = path.join(outDir, '.mp3merge-write-test');
    const fd = fs.openSync(probe, 'w');
    fs.closeSync(fd);
    fs.unlinkSync(probe);
  } catch (e) {
    const hint = e.code === 'EPERM' || e.code === 'EACCES'
      ? '该目录没有写入权限（例如 C 盘根目录需要管理员权限）。请把输出文件改到可写的文件夹，如 桌面/文档/音乐。'
      : `写入测试失败（${e.code}）`;
    return { ok: false, error: `无法写入输出目录: ${outDir}\n${hint}` };
  }

  // 输出文件自动去重：同名已存在则追加序号（不覆盖旧文件）
  out = uniquePath(out);

  const probes = [];
  const skipped = [];
  for (const f of files) {
    const p = probeFile(f);
    if (p) probes.push(p);
    else skipped.push(path.basename(f));
  }
  if (probes.length === 0) return { ok: false, error: '没有可用的 MP3 文件' };

  const sigs = new Set(probes.map(signature));
  fadeSec = Number(fadeSec) > 0 ? Number(fadeSec) : 0;
  // 交叉淡化要求每首歌比淡入淡出时长更长（保险起见留 1 秒余量）
  if (fadeSec > 0) {
    for (const p of probes) {
      const st = countFrames(p.file);
      const dur = st ? st.durSec : 0;
      if (dur <= fadeSec + 1) {
        return { ok: false, error: `「${path.basename(p.file)}」时长仅 ${dur.toFixed(1)} 秒，小于淡入淡出时长 ${fadeSec} 秒，请减小淡入淡出或去掉该歌` };
      }
    }
  }
  const mode = fadeSec > 0 ? 'fadeoutin' : (sigs.size === 1 ? 'lossless' : 'ffmpeg');

  const start = Date.now();
  try {
    if (mode === 'lossless') {
      await mergeLossless(probes, out);
    } else if (mode === 'fadeoutin') {
      mergeWithFadeOutIn(probes, out, fadeSec, null);
    } else {
      mergeWithFfmpeg(probes, out, null);
    }
  } catch (e) {
    const hint = e.code === 'EPERM' || e.code === 'EACCES'
      ? '没有写入权限（C 盘根目录等位置需要管理员权限）。请把输出文件改到可写的文件夹。'
      : (e.message || String(e));
    return { ok: false, error: `合成失败: ${hint}` };
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const stats = countFrames(out);
  const bytes = fs.statSync(out).size;
  return {
    ok: true,
    mode,
    out,
    bytes,
    frames: stats ? stats.frames : null,
    durSec: stats ? stats.durSec : null,
    elapsed,
    skipped,
    groups: sigs.size,
    fadeSec,
  };
}

// ---------- HTTP 服务 ----------
function send(res, code, obj, contentType) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const ct = contentType || (typeof obj === 'string'
    ? 'text/html; charset=utf-8'
    : 'application/json; charset=utf-8');
  res.writeHead(code, { 'Content-Type': ct });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/' ) return send(res, 200, loadPage());
    if (u.pathname === '/api/browse') {
      const dir = u.searchParams.get('dir') || os.homedir();
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return send(res, 400, { ok: false, error: '目录不存在' });
      return send(res, 200, { ok: true, home: os.homedir(), ...browse(dir) });
    }
    if (u.pathname === '/api/homedir') {
      return send(res, 200, { ok: true, home: os.homedir() });
    }
    if (u.pathname === '/api/drives') {
      // 列出所有可用盘符（A-Z）
      const drives = [];
      for (let i = 65; i <= 90; i++) {
        const d = String.fromCharCode(i) + ':\\';
        try { fs.accessSync(d); drives.push(String.fromCharCode(i) + ':'); } catch {}
      }
      return send(res, 200, { ok: true, drives });
    }
    if (u.pathname === '/api/mkdir') {
      // 创建输出文件夹（支持多级，如 E:/串烧）
      const dir = u.searchParams.get('dir');
      if (!dir) return send(res, 400, { ok: false, error: '缺少目录参数' });
      try {
        fs.mkdirSync(path.resolve(dir), { recursive: true });
        return send(res, 200, { ok: true, dir: path.resolve(dir) });
      } catch (e) {
        return send(res, 500, { ok: false, error: `创建目录失败: ${e.message}` });
      }
    }
    if (u.pathname === '/api/merge') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { files, out, fade } = JSON.parse(body || '{}');
      if (!Array.isArray(files) || files.length === 0 || !out) {
        return send(res, 400, { ok: false, error: '参数错误：需要 files 数组和 out 路径' });
      }
      const r = await doMerge(files, out, fade);
      return send(res, r.ok ? 200 : 500, r);
    }
    return send(res, 404, { ok: false, error: 'Not Found' });
  } catch (e) {
    send(res, 500, { ok: false, error: e.message });
  }
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  console.log(`MP3 合成器已启动: ${url}`);
  console.log('按 Ctrl+C 退出');
  // 记录 PID，供下次双击启动时清理旧实例
  try { fs.writeFileSync(path.join(__dirname, '服务.pid'), String(process.pid), 'utf8'); } catch {}
  // 延迟打开默认浏览器
  setTimeout(() => {
    try { spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref(); }
    catch { console.log('请手动打开浏览器访问: ' + url); }
  }, 600);
});

// ---------- 内置网页 ----------

// ---------- 页面 ----------
function loadPage() {
  try { return fs.readFileSync(path.join(__dirname, 'gui.html'), 'utf8'); }
  catch { return '<h1>gui.html 不存在</h1>'; }
}

