#!/usr/bin/env node
/**
 * 完整自测：生成结构真实的合成 MP3（多种 ID3 标签 / CBR / VBR / 不同编码参数），
 * 验证：
 *   A. 参数一致 → 无损拼接 → 逐帧校验：输出文件无垃圾字节、拼接点帧头连续、总时长正确
 *   B. 参数不一致 → 正确检测出多组参数并走 FFmpeg 回退（本机无网，验证其给出清晰指引）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseHeader, id3v2Size, probeFile, signature, mergeLossless } = require('./merge-mp3.js');

const assert = (cond, msg) => { if (!cond) { console.error('✗ FAIL: ' + msg); process.exit(1); } };
const ok = (msg) => console.log('  ✓ ' + msg);

// ---------- 合成工具 ----------
const syncsafe = (n) => Buffer.from([
  (n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f,
]);

/** ID3v2.3 标签（含 TIT2 标题帧） */
function makeId3v23(text) {
  const frameData = Buffer.concat([Buffer.from([0x03]), Buffer.from(text, 'latin1')]);
  const frame = Buffer.concat([
    Buffer.from('TIT2'),
    Buffer.from([frameData.length >> 24, (frameData.length >> 16) & 0xff, (frameData.length >> 8) & 0xff, frameData.length & 0xff]),
    Buffer.from([0, 0]), frameData,
  ]);
  return Buffer.concat([Buffer.from('ID3\x03\x00\x00'), syncsafe(frame.length), frame]);
}

/** 帧头构造：versionBits(3=MPEG1,2=MPEG2,0=MPEG2.5), layerBits(1=III), brIdx, srIdx, ch */
function frameHeader({ vb = 3, lb = 1, brIdx = 9, srIdx = 0, ch = 0, pad = 0 } = {}) {
  const b1 = 0xe0 | ((vb & 3) << 3) | ((lb & 3) << 1) | 1;
  const b2 = ((brIdx & 15) << 4) | ((srIdx & 3) << 2) | ((pad & 1) << 1);
  const b3 = (ch & 3) << 6;
  return Buffer.from([0xff, b1, b2, b3]);
}

const BR_L3 = { '1': [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320], '2': [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160], '2.5': [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160] };
const SR_T = { '1': [44100,48000,32000], '2': [22050,24000,16000], '2.5': [11025,12000,8000] };
const VB_STR = { 3: '1', 2: '2', 0: '2.5' };

function frameLenOf(opts) {
  const v = VB_STR[opts.vb ?? 3], sr = SR_T[v][opts.srIdx ?? 0], br = BR_L3[v][opts.brIdx ?? 9];
  const layer = (opts.lb ?? 1) === 1 ? 'III' : 'II';
  if (layer === 'I') return ((12 * br * 1000 / sr) | 0) * 4 + (opts.pad ? 4 : 0);
  if (v === '1') return ((144 * br * 1000 / sr) | 0) + (opts.pad ? 1 : 0);
  return ((72 * br * 1000 / sr) | 0) + (opts.pad ? 1 : 0);
}

/** 生成一个 MP3 文件。opts: {frames, header, id3, id3v1, apev2, xing} */
function makeMp3(opts) {
  const fl = frameLenOf(opts.header ?? {});
  const parts = [];
  if (opts.id3) parts.push(opts.id3);
  for (let i = 0; i < (opts.frames ?? 10); i++) {
    let frameData = Buffer.alloc(fl - 4, 0x00);
    if (opts.xing && i === 0 && fl >= 124) {
      const xing = Buffer.concat([
        Buffer.from('Xing'),
        Buffer.from([0, 0, 0, 3]), // frames+bytes flags
        syncsafe(opts.frames), Buffer.from([0, 0, 0, 0]), // frames 计数
      ]);
      frameData = Buffer.concat([xing, Buffer.alloc(fl - 4 - xing.length, 0x00)]);
    }
    parts.push(Buffer.concat([frameHeader(opts.header ?? {}), frameData]));
  }
  let body = Buffer.concat(parts);
  if (opts.apev2) {
    const item = Buffer.concat([Buffer.from('KEY'), syncsafe(0), Buffer.from([0, 0]), Buffer.alloc(8, 0)]);
    const items = Buffer.concat([item, Buffer.from('val')]);
    const footer = Buffer.concat([
      Buffer.from('APETAGEX'), Buffer.from([0xd0, 0x07, 0, 0]), // version 2000
      Buffer.from([items.length & 0xff, (items.length >> 8) & 0xff, (items.length >> 16) & 0xff, (items.length >> 24) & 0xff]),
      Buffer.from([1, 0, 0, 0]), Buffer.from([0, 0, 0, 0]), Buffer.alloc(8, 0),
    ]);
    body = Buffer.concat([body, items, footer]);
  }
  if (opts.id3v1) {
    const t = Buffer.alloc(30, 0); t.write(opts.title ?? 'T', 'latin1');
    body = Buffer.concat([body, Buffer.concat([Buffer.from('TAG'), t, Buffer.alloc(95, 0)])]);
  }
  return body;
}

// ---------- 逐帧完整性校验器 ----------
/** 校验整个 MP3 字节流：从音频起点逐帧解析，报告任何无法解析的垃圾区间 */
function validateFrames(buf) {
  let pos = id3v2Size(buf);
  const frames = [];
  const junk = [];
  let junkStart = -1;
  while (pos + 4 <= buf.length) {
    if (pos + 128 <= buf.length && buf.toString('latin1', pos, pos + 3) === 'TAG') break; // ID3v1 尾
    const h = parseHeader(buf, pos);
    if (!h) {
      if (junkStart < 0) junkStart = pos;
      pos++;
      continue;
    }
    if (junkStart >= 0) { junk.push([junkStart, pos]); junkStart = -1; }
    frames.push(h);
    pos += h.frameLen;
  }
  if (junkStart >= 0) junk.push([junkStart, pos]);
  const v = frames.length ? frames[0].version : null;
  const samplesPerFrame = v === '1' ? 1152 : 576;
  const durSec = frames.length * samplesPerFrame / (frames[0]?.sr ?? 1);
  return { frames, junk, durSec, bytesScanned: pos };
}

function expectNoJunk(label, buf) {
  const r = validateFrames(buf);
  assert(r.junk.length === 0, `${label}: 发现 ${r.junk.length} 处垃圾字节区间 ${JSON.stringify(r.junk)}`);
  assert(r.frames.length > 0, `${label}: 没有解析出任何帧`);
  return r;
}

// ---------- 测试 ----------
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp3full-'));
  console.log('自测目录:', dir, '\n');
  try {
    // ===== 场景 A：6 个参数一致的 MP3（不同标签结构），无损拼接后逐帧校验 =====
    console.log('== A. 参数一致 → 无损拼接 → 逐帧完整性校验 ==');
    const same = [
      { name: '01-带ID3v23.mp3', opts: { frames: 100, id3: makeId3v23('Song One'), id3v1: true } },
      { name: '02-带ID3v1.mp3', opts: { frames: 80, id3v1: true, title: 'B' } },
      { name: '03-无标签.mp3', opts: { frames: 60 } },
      { name: '04-带APEv2.mp3', opts: { frames: 90, apev2: true, id3v1: true } },
      { name: '05-VBR带Xing.mp3', opts: { frames: 120, xing: true, header: { brIdx: 9 } } },
      { name: '06-短文件.mp3', opts: { frames: 5, id3v1: true } },
    ];
    const files = same.map(s => path.join(dir, s.name));
    files.forEach((f, i) => fs.writeFileSync(f, makeMp3(same[i].opts)));

    const probes = files.map(f => probeFile(f));
    probes.forEach((p, i) => {
      assert(p, `${same[i].name} 应能解析`);
      const h = p.header;
      ok(`${same[i].name}: MPEG${h.version} L${h.layer} ${h.sr}Hz ${h.br}kbps ch${h.chMode} 音频[${p.dataStart},${p.audioEnd})`);
    });
    assert(new Set(probes.map(signature)).size === 1, '6 个文件签名应一致');

    // 无损拼接
    const merged = path.join(dir, 'merged-A.mp3');
    await mergeLossless(probes, merged);
    const mBuf = fs.readFileSync(merged);
    const mRes = expectNoJunk('合并结果', mBuf);
    ok(`合并: ${mRes.frames.length} 帧 / ${mRes.durSec.toFixed(2)} 秒 / ${mBuf.length} 字节，无垃圾区间`);

    // 期望时长 = 各文件音频帧数之和 × 每帧时长
    const expectFrames = probes.reduce((s, p) => {
      const audio = fs.readFileSync(p.file);
      return s + validateFrames(audio.subarray(p.dataStart, p.audioEnd)).frames.length;
    }, 0);
    assert(mRes.frames.length === expectFrames, `帧数应=${expectFrames}，实际=${mRes.frames.length}`);
    ok(`帧数精确匹配: ${expectFrames} 帧（拼接点前后帧头连续、无缺失无重复）`);

    // 拼接点检查：帧边界处前后帧头解析一致
    let boundaryOk = 0;
    for (let i = 1; i < mRes.frames.length; i++) {
      if (mRes.frames[i].offset - (mRes.frames[i - 1].offset + mRes.frames[i - 1].frameLen) === 0) boundaryOk++;
    }
    assert(boundaryOk === mRes.frames.length - 1, `拼接点应全部无缝衔接，实际 ${boundaryOk}/${mRes.frames.length - 1}`);
    ok(`全部 ${boundaryOk} 个帧边界无缝衔接（含文件拼接处）`);

    // ===== 场景 B：参数不一致 → 检测到多组 → FFmpeg 回退（无网时给出指引） =====
    console.log('\n== B. 参数不一致 → 检测与回退 ==');
    // 用独立子目录，避免场景 A 的合并产物 merged-A.mp3 被重复拼接
    const dirB = path.join(dir, 'mix');
    fs.mkdirSync(dirB);
    const diffFiles = [
      { name: '07-48kHz.mp3', opts: { frames: 50, header: { srIdx: 1 }, id3v1: true } },      // 48000Hz
      { name: '08-单声道22k.mp3', opts: { frames: 40, header: { vb: 2, srIdx: 0, ch: 3 }, id3: makeId3v23('Mono') }, }, // MPEG2 22050Hz mono
    ];
    const allNames = [...same, ...diffFiles];
    // 同参数 6 个从 dir 复制，不同参数 2 个直接生成到 dirB
    same.forEach(s => fs.copyFileSync(path.join(dir, s.name), path.join(dirB, s.name)));
    diffFiles.forEach(s => fs.writeFileSync(path.join(dirB, s.name), makeMp3(s.opts)));

    const allFiles = allNames.map(s => path.join(dirB, s.name));
    const allProbes = allFiles.map(f => probeFile(f));
    const sigs = new Set(allProbes.map(signature));
    assert(sigs.size === 3, `应检测出 3 组参数，实际 ${sigs.size}`);
    ok(`检测出 ${sigs.size} 组不同编码参数（44100 立体声 / 48000 / 22050 单声道）`);

    // CLI 端到端：不一致时应成功走 FFmpeg 重编码拼接（系统有 ffmpeg-static 可用），输出可正常解析
    console.log('\n-- 运行 CLI（不一致场景，应走 FFmpeg 重编码）--');
    const out2 = path.join(dirB, 'merged-B.mp3');
    const cli = spawnSync(process.execPath, [path.join(__dirname, 'merge-mp3.js'), dirB, out2], { encoding: 'utf8', timeout: 180000 });
    const outText = cli.stdout + cli.stderr;
    console.log(outText.split('\n').filter(l => !l.startsWith('  ')).slice(0, 10).join('\n'));
    if (cli.status === 0 && fs.existsSync(out2)) {
      const bBuf = fs.readFileSync(out2);
      const bRes = expectNoJunk('FFmpeg 合并结果', bBuf);
      // FFmpeg 重编码后：时长应与各文件原音频时长之和接近（±5%，重采样/填充有少量误差）
      const expectDur = allProbes.reduce((s, p) => {
        const audio = fs.readFileSync(p.file);
        return s + validateFrames(audio.subarray(p.dataStart, p.audioEnd)).durSec;
      }, 0);
      const ratio = Math.abs(bRes.durSec - expectDur) / expectDur;
      assert(ratio < 0.05, `FFmpeg 输出时长应≈原总时长 ${expectDur.toFixed(2)}s，实际 ${bRes.durSec.toFixed(2)}s（偏差 ${(ratio*100).toFixed(1)}%）`);
      ok(`FFmpeg 拼接成功: ${bRes.frames.length} 帧 / ${bRes.durSec.toFixed(2)} 秒，无垃圾区间，时长偏差 ${(ratio*100).toFixed(1)}%`);
    } else {
      assert(cli.status !== 0, '无可用 FFmpeg 时应非 0 退出');
      assert(/安装失败|winget|--ffmpeg|网络/.test(outText), '应包含安装指引');
      ok('本机无可用 FFmpeg，回退路径给出清晰安装指引（未做端到端验证）');
    }

    console.log('\n全部自测通过 ✓');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(e => { console.error('✗ 自测异常:', e); process.exit(1); });
