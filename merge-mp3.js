#!/usr/bin/env node
/**
 * merge-mp3.js — 把同一文件夹里的所有 MP3 首尾相连，生成一个新 MP3。
 *
 * 用法:
 *   node merge-mp3.js <歌曲文件夹路径> [输出文件.mp3]
 *
 * 逻辑:
 *   1. 扫描文件夹内所有 *.mp3，按文件名排序。
 *   2. 逐文件解析 MPEG 帧头，得到 版本/层/采样率/声道/比特率。
 *   3. 若所有文件参数一致 -> 无损直拼（剥掉 ID3v2 头、ID3v1/APEv2 尾，音频帧原样相连）。
 *      参数不一致 -> 自动回退到 FFmpeg 重编码拼接（需 ffmpeg-static，自动下载约 70MB）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');

// ---------- MPEG 音频帧头解析 ----------
const VERSION_BITS = ['2.5', 'reserved', '2', '1']; // (b1>>3)&3 -> MPEG 版本
const LAYER_BITS = ['reserved', 'III', 'II', 'I']; // (b1>>1)&3
const SR_TABLE = {
  '1': [44100, 48000, 32000],
  '2': [22050, 24000, 16000],
  '2.5': [11025, 12000, 8000],
};
const BR_TABLE_L3 = {
  '1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1],
  '2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1],
  '2.5': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1],
};
const CH_NAMES = ['立体声', '联合立体声', '双声道', '单声道'];

/** 解析 i 处的 4 字节帧头；非法返回 null */
function parseHeader(buf, i) {
  if (i + 4 > buf.length) return null;
  const b0 = buf[i], b1 = buf[i + 1], b2 = buf[i + 2], b3 = buf[i + 3];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = VERSION_BITS[(b1 >> 3) & 3];
  const layer = LAYER_BITS[(b1 >> 1) & 3];
  if (version === 'reserved' || layer === 'reserved') return null;
  const srIdx = (b2 >> 2) & 3;
  const sr = SR_TABLE[version][srIdx];
  const brIdx = (b2 >> 4) & 15;
  const br = BR_TABLE_L3[version][brIdx];
  if (!sr || br <= 0 || brIdx === 15) return null; // 0=free 格式不处理
  const chMode = (b3 >> 6) & 3;
  const padding = (b2 >> 1) & 1;
  let frameLen;
  if (layer === 'I') frameLen = (12 * br * 1000 / sr | 0) * 4 + padding * 4;
  else if (version === '1') frameLen = (144 * br * 1000 / sr | 0) + padding;
  else frameLen = (72 * br * 1000 / sr | 0) + padding;
  return { version, layer, sr, br, chMode, frameLen, offset: i };
}

/** 从 from 开始找第一个合法音频帧（跳过 ID3v2 标签） */
function findFirstFrame(buf, from) {
  const max = Math.min(buf.length - 4, from + 2 * 1024 * 1024);
  for (let i = from; i <= max; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const h = parseHeader(buf, i);
    if (!h) continue;
    const next = i + h.frameLen;
    // 下一帧必须也是合法帧同步（双重校验，避免在标签数据里误判）；仅当已到 buffer 末尾才接受单帧
    if (next + 4 <= buf.length) {
      if (parseHeader(buf, next)) return { header: h, dataStart: i };
    } else if (next <= buf.length) {
      return { header: h, dataStart: i };
    }
  }
  return null;
}

/** ID3v2 标签总长度（含头/可选 footer），无则 0 */
function id3v2Size(buf) {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0;
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  const footer = buf[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

/** 精确读取文件 [start, start+len) 区间（readFileSync 的 start/end 在部分平台不可靠） */
function readRange(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = fs.readSync(fd, buf, off, len - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    fs.closeSync(fd);
  }
}

/** 探测单个文件：返回音频数据区间 [dataStart, audioEnd) 及帧头参数 */
function probeFile(file) {
  const stat = fs.statSync(file);
  const headSize = Math.min(stat.size, 2 * 1024 * 1024);
  const head = readRange(file, 0, headSize);
  const tagSize = id3v2Size(head);
  const found = findFirstFrame(head, tagSize);
  if (!found) return null;

  let audioEnd = stat.size;
  // 剥 ID3v1（末尾 128 字节以 TAG 开头）
  if (audioEnd >= 128) {
    const tail = readRange(file, stat.size - 128, 128);
    if (tail.length === 128 && tail.toString('latin1', 0, 3) === 'TAG') audioEnd -= 128;
  }
  // 剥 APEv2（末尾 footer 以 APETAGEX 开头）
  if (audioEnd >= 32) {
    const tail = readRange(file, audioEnd - 32, 32);
    if (tail.toString('latin1', 0, 8) === 'APETAGEX') {
      const tagSize = tail.readUInt32LE(12);
      audioEnd -= 32 + tagSize;
    }
  }
  if (audioEnd < found.dataStart + 4) audioEnd = stat.size; // 保守：剥离失败则保留到文件尾

  return {
    file,
    size: stat.size,
    dataStart: found.dataStart,
    audioEnd,
    header: found.header,
  };
}

/** 一致性签名：版本/层/采样率/声道必须全同；比特率允许不同（CBR/VBR 混拼帧头自带信息） */
function signature(p) {
  return [p.header.version, p.header.layer, p.header.sr, p.header.chMode].join('|');
}

// ---------- 无损拼接 ----------
async function mergeLossless(probes, out) {
  const ws = fs.createWriteStream(out);
  ws.setMaxListeners(probes.length * 4 + 16); // 每个 pipeline 会加 error/close listener
  for (const p of probes) {
    await pipeline(
      fs.createReadStream(p.file, { start: p.dataStart, end: p.audioEnd - 1 }),
      ws,
      { end: false }
    );
  }
  ws.end();
  await new Promise((res, rej) => { ws.on('finish', res); ws.on('error', rej); });
}

// ---------- FFmpeg 回退 ----------
function findSystemFfmpeg() {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'pipe' });
    if (r.status === 0) return 'ffmpeg';
  } catch { /* 不在 PATH */ }
  return null;
}

function ensureFfmpeg(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const sys = findSystemFfmpeg();
  if (sys) return sys;
  try { return require('ffmpeg-static'); } catch { /* 未安装 */ }
  console.log('[info] 未检测到系统 ffmpeg 或 ffmpeg-static。尝试安装 ffmpeg-static（从 GitHub 下载约 70MB，国内网络可能超时）…');
  const r = spawnSync('npm', ['install', 'ffmpeg-static', '--no-save'], { cwd: __dirname, stdio: 'inherit', timeout: 120000 });
  if (r.status !== 0) {
    throw new Error(
      'ffmpeg-static 安装失败（可能是网络问题）。请任选其一：\n' +
      '  1) 安装系统 FFmpeg 后重试，例如:  winget install Gyan.FFmpeg\n' +
      '  2) 手动下载 FFmpeg，然后用参数指定:  node merge-mp3.js <文件夹> <输出.mp3> --ffmpeg C:\\path\\to\\ffmpeg.exe'
    );
  }
  return require('ffmpeg-static');
}

function mergeWithFfmpeg(probes, out, explicitFfmpeg) {
  const ff = ensureFfmpeg(explicitFfmpeg);
  const ref = probes[0].header;
  const sr = ref.sr;
  const ch = ref.chMode === 3 ? 'mono' : 'stereo';
  const inputs = probes.flatMap(p => ['-i', p.file]);
  const chain = probes.map((p, i) =>
    `[${i}:a]aresample=${sr},aformat=sample_fmts=fltp:channel_layouts=${ch}[a${i}]`
  ).join(';');
  const concatIn = probes.map((_, i) => `[a${i}]`).join('');
  const filter = `${chain};${concatIn}concat=n=${probes.length}:v=0:a=1[aout]`;
  const args = [...inputs, '-filter_complex', filter, '-map', '[aout]',
    '-c:a', 'libmp3lame', '-b:a', '192k', '-y', out];
  const r = spawnSync(ff, args, { encoding: 'utf8', timeout: 600000 });
  if (r.status !== 0) {
    const tail = String(r.stderr || r.stdout || '').split('\n').filter(l => l.trim()).slice(-6).join('\n');
    throw new Error(`FFmpeg 拼接失败\n${tail}`);
  }
}

/**
 * 顺序淡出淡入（不重叠）：每首歌开头淡入、结尾淡出，
 * 前一首淡出到结束后，后一首再淡入。总时长 = 各首歌时长之和。
 * 参数一致与否都走 FFmpeg 重编码。
 */
function calcDurationSec(p) {
  // 逐帧统计音频时长（VBR 也准确）
  const buf = fs.readFileSync(p.file);
  let pos = p.dataStart, end = p.audioEnd;
  let frames = 0, first = null;
  while (pos + 4 <= end) {
    const h = parseHeader(buf, pos);
    if (!h) break;
    if (!first) first = h;
    frames++;
    pos += h.frameLen;
  }
  if (!first || frames === 0) return 0;
  const spp = first.version === '1' ? 1152 : 576;
  return (frames * spp) / first.sr;
}

function mergeWithFadeOutIn(probes, out, fadeSec, explicitFfmpeg) {
  const ff = ensureFfmpeg(explicitFfmpeg);
  const ref = probes[0].header;
  const sr = ref.sr;
  const ch = ref.chMode === 3 ? 'mono' : 'stereo';
  const inputs = probes.flatMap(p => ['-i', p.file]);
  // 1) 各输入统一参数
  const chain = probes.map((p, i) =>
    `[${i}:a]aresample=${sr},aformat=sample_fmts=fltp:channel_layouts=${ch}[a${i}]`
  );
  const parts = [];
  const labels = [];
  for (let i = 0; i < probes.length; i++) {
    let cur = `[a${i}]`;
    if (probes.length > 1) {
      // 开头淡入（第 1 首除外）；hsin=半正弦平滑曲线，起止平缓不突兀
      if (i > 0) {
        parts.push(`${cur}afade=t=in:d=${fadeSec}:curve=hsin[b${i}]`);
        cur = `[b${i}]`;
      }
      // 结尾淡出（最后一首除外）；hsin 半正弦：音量先缓慢下降、后平滑收尾
      if (i < probes.length - 1) {
        const dur = calcDurationSec(probes[i]);
        const st = Math.max(0, dur - fadeSec);
        parts.push(`${cur}afade=t=out:st=${st.toFixed(3)}:d=${fadeSec}:curve=hsin[c${i}]`);
        cur = `[c${i}]`;
      }
    }
    labels.push(cur);
  }
  // 2) 顺序拼接
  const concatIn = labels.join('');
  parts.push(`${concatIn}concat=n=${probes.length}:v=0:a=1[aout]`);
  const filter = [...chain, ...parts].join(';');
  const args = [...inputs, '-filter_complex', filter, '-map', '[aout]',
    '-c:a', 'libmp3lame', '-b:a', '192k', '-y', out];
  const r = spawnSync(ff, args, { encoding: 'utf8', timeout: 600000 });
  if (r.status !== 0) {
    const tail = String(r.stderr || r.stdout || '').split('\n').filter(l => l.trim()).slice(-6).join('\n');
    throw new Error(`FFmpeg 淡出淡入失败（可能某首歌太短，淡入淡出时长需小于歌曲长度）\n${tail}`);
  }
}

// ---------- 主流程 ----------
function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log('用法: node merge-mp3.js <歌曲文件夹路径> [输出文件.mp3] [--ffmpeg <ffmpeg.exe路径>]');
    process.exit(1);
  }
  const dir = path.resolve(args[0]);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`错误: 文件夹不存在: ${dir}`);
    process.exit(1);
  }
  let out = args[1] ? path.resolve(args[1]) : path.join(dir, 'merged.mp3');
  let ffmpegPath = null;
  const ffIdx = args.indexOf('--ffmpeg');
  if (ffIdx !== -1 && args[ffIdx + 1]) ffmpegPath = path.resolve(args[ffIdx + 1]);
  if (out === '--ffmpeg') out = path.join(dir, 'merged.mp3'); // 兼容未传输出文件时

  const files = fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.mp3') && path.resolve(dir, f) !== out)
    .sort((a, b) => a.localeCompare(b, 'zh'))
    .map(f => path.join(dir, f));
  if (files.length === 0) {
    console.error(`错误: 文件夹里没有 MP3 文件: ${dir}`);
    process.exit(1);
  }

  console.log(`共发现 ${files.length} 个 MP3，正在检测编码参数…\n`);
  const probes = [];
  for (const f of files) {
    const p = probeFile(f);
    if (!p) { console.error(`跳过（无法解析为 MP3）: ${f}`); continue; }
    const h = p.header;
    console.log(
      `  ${path.basename(f)}\n` +
      `    MPEG${h.version} Layer ${h.layer} | ${h.sr} Hz | ${h.br} kbps | ${CH_NAMES[h.chMode]}`
    );
    probes.push(p);
  }
  if (probes.length === 0) { console.error('错误: 没有可用的 MP3'); process.exit(1); }
  if (probes.length !== files.length) {
    console.error(`\n注意: ${files.length - probes.length} 个文件无法解析，已跳过。`);
  }

  const sigs = new Set(probes.map(signature));
  console.log('');
  if (sigs.size === 1) {
    console.log('✓ 所有文件参数一致，采用无损直接拼接…');
    mergeLossless(probes, out).catch(e => { console.error('拼接失败:', e.message); process.exit(1); })
      .then(() => {
        const total = probes.reduce((s, p) => s + (p.audioEnd - p.dataStart), 0);
        console.log(`✓ 完成: ${out}（${(total / 1024 / 1024).toFixed(1)} MB 音频数据）`);
      });
  } else {
    console.log(`⚠ 检测到 ${sigs.size} 组不同的编码参数，回退到 FFmpeg 重编码拼接…`);
    try {
      mergeWithFfmpeg(probes, out, ffmpegPath);
      console.log(`✓ 完成: ${out}`);
    } catch (e) {
      console.error('FFmpeg 拼接失败:', e.message);
      process.exit(1);
    }
  }
}

if (require.main === module) main();

module.exports = { parseHeader, findFirstFrame, id3v2Size, probeFile, signature, mergeLossless, mergeWithFfmpeg, mergeWithFadeOutIn };
