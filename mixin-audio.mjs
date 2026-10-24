import { sanitizeForTts } from './tts-text.mjs';
// 预合成音频。mxop 是 16kHz 单声道 Opus 帧，体积比 WAV 小。
// 浏览器不直接解这个文件；服务端解开后按 PCM 推给页面。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildMixinDetect } from './mixin-link.mjs';
import { scriptedBody, scriptedDetect } from './mixin-prompts.mjs';
import OpusScript from 'opusscript';

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 320;

export function wavFromPcm(pcm, sampleRate = SAMPLE_RATE) {
  const data = Buffer.from(pcm);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function pcmFromWav(wav) {
  const buffer = Buffer.from(wav);
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('不是 WAV');
  let offset = 12;
  let sampleRate = SAMPLE_RATE;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > buffer.length) break;
    if (id === 'fmt ' && size >= 16) sampleRate = buffer.readUInt32LE(start + 4);
    if (id === 'data') {
      data = buffer.subarray(start, start + size);
      break;
    }
    offset = start + size + (size % 2);
  }
  if (!data) throw new Error('WAV 缺少 data');
  return { pcm: Buffer.from(data), sampleRate };
}

export function revealSfxWav() {
  const sampleRate = SAMPLE_RATE;
  const total = Math.round(sampleRate * 0.36);
  const pcm = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    const env = Math.min(1, i / 80) * Math.min(1, (total - i) / 500);
    const sample = Math.sin(2 * Math.PI * 880 * t) * 0.18 * env + Math.sin(2 * Math.PI * 1320 * t) * 0.08 * env;
    pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(sample * 32767))), i * 2);
  }
  return wavFromPcm(pcm, sampleRate);
}

export function encodeMxop(pcm, { sampleRate = SAMPLE_RATE, frameSamples = FRAME_SAMPLES } = {}) {
  const input = Buffer.from(pcm);
  const width = frameSamples * 2;
  const codec = new OpusScript(sampleRate, 1, OpusScript.Application.AUDIO);
  const frames = [];
  try {
    for (let offset = 0; offset + width <= input.length; offset += width) {
      frames.push(Buffer.from(codec.encode(input.subarray(offset, offset + width), frameSamples)));
    }
  } finally {
    codec.delete();
  }
  return packMxop({ sampleRate, frameSamples, frames });
}

export function packMxop({ sampleRate, frameSamples, frames }) {
  if (frames.length > 65535) throw new Error('音频太长');
  const header = Buffer.alloc(16);
  header.write('MXOP', 0);
  header.writeUInt8(1, 4);
  header.writeUInt8(1, 5);
  header.writeUInt16LE(0, 6);
  header.writeUInt32LE(sampleRate, 8);
  header.writeUInt16LE(frameSamples, 12);
  header.writeUInt16LE(frames.length, 14);
  const parts = [header];
  for (const frame of frames) {
    if (frame.length > 65535) throw new Error('Opus 帧太长');
    const size = Buffer.alloc(2);
    size.writeUInt16LE(frame.length);
    parts.push(size, Buffer.from(frame));
  }
  return Buffer.concat(parts);
}

export function decodeMxop(buffer) {
  const input = Buffer.from(buffer);
  if (input.length < 16 || input.toString('ascii', 0, 4) !== 'MXOP' || input.readUInt8(4) !== 1) throw new Error('不是 mxop');
  const sampleRate = input.readUInt32LE(8);
  const frameSamples = input.readUInt16LE(12);
  const count = input.readUInt16LE(14);
  const frames = [];
  let offset = 16;
  for (let index = 0; index < count; index += 1) {
    if (offset + 2 > input.length) throw new Error('mxop 帧不完整');
    const size = input.readUInt16LE(offset);
    offset += 2;
    if (offset + size > input.length) throw new Error('mxop 帧不完整');
    frames.push(input.subarray(offset, offset + size));
    offset += size;
  }
  const codec = new OpusScript(sampleRate, 1, OpusScript.Application.AUDIO);
  const parts = [];
  try {
    for (const frame of frames) parts.push(Buffer.from(codec.decode(frame)));
  } finally {
    codec.delete();
  }
  return { pcm: parts.length ? Buffer.concat(parts) : Buffer.alloc(0), sampleRate, frameSamples };
}

export function pcmFromAudioFile(bytes, filename) {
  if (filename.endsWith('.wav')) return pcmFromWav(bytes).pcm;
  if (filename.endsWith('.mxop')) return decodeMxop(bytes).pcm;
  throw new Error('不认识的音频文件');
}

export function ttsKey(text, voiceId) {
  const detect = buildMixinDetect({ text: scriptedDetect('群主·零号', text, '预合成。'), voiceId });
  const speak = scriptedBody(detect.text);
  return createHash('sha256').update(JSON.stringify([speak, detect.agent_params.voice.id])).digest('hex').slice(0, 16);
}

export function ttsManifestEntry(item, voiceId) {
  return {
    id: item.id,
    roleId: item.roleId,
    voiceId,
    text: item.text,
    spokenText: sanitizeForTts(item.text),
    ttsHash: ttsKey(item.text, voiceId),
    file: `${item.id}.mxop`,
    kind: 'tts',
  };
}

export function sfxManifestEntry() {
  return { id: 'reveal-sfx', roleId: null, voiceId: null, text: '', file: 'reveal-sfx.wav', kind: 'sfx' };
}

export function matchAsset(manifest, { voiceId, text }) {
  const ttsHash = ttsKey(text, voiceId);
  return (manifest?.lines ?? []).find(line => line.kind !== 'sfx' && line.text === text && line.voiceId === voiceId && line.ttsHash === ttsHash && line.file) ?? null;
}

export function createFileAssets(dir, manifest, read = readFile) {
  return {
    async find({ voiceId, text }) {
      const hit = matchAsset(manifest, { voiceId, text });
      if (!hit) return null;
      try { return pcmFromAudioFile(await read(path.join(dir, hit.file)), hit.file); }
      catch { return null; }
    },
    async sfx(id = 'reveal-sfx') {
      const hit = (manifest?.lines ?? []).find(line => line.id === id && line.kind === 'sfx');
      if (!hit) return null;
      try { return pcmFromAudioFile(await read(path.join(dir, hit.file)), hit.file); }
      catch { return null; }
    },
  };
}
