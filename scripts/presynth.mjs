// 用本机凭据把群主固定台词合成成 mxop。
// 凭据：LINX_DEVICE_JSON（JSON 或文件路径）、LINX_API_KEY，或 .linx-device.json。
// 也可以用 LINX_WS_URL / LINX_WS_TOKEN / LINX_DEVICE_ID / LINX_CLIENT_ID 跳过 OTA。
// 不把凭据写进日志、manifest 或仓库。
//
//   npm run presynth
// 输出：public/mixin/audio/<稳定文件名>.mxop 和 manifest.json

import { mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodeMxop, revealSfxWav, sfxManifestEntry, ttsManifestEntry } from '../mixin-audio.mjs';
import { loadSpeakCredentials, resolveWebsocket } from '../linx-credentials.mjs';
import { createMixinLink } from '../mixin-link.mjs';
import { presynthCatalog, scriptedDetect } from '../mixin-prompts.mjs';
import { roleById, voiceOf } from '../mixin-roles.mjs';

const DEFAULT_TIMEOUT_MS = 100_000;
const MAX_FILE_BYTES = 256 * 1024;

function ranAsScript() {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

export async function runPresynth({
  dir = path.resolve('public/mixin/audio'),
  env = process.env,
  readFile,
  log = console.log,
  resolve = resolveWebsocket,
  createLink = loaded => createMixinLink({ config: loaded.config, credentials: loaded.credentials }),
  timeoutMs = Number(env.PRESYNTH_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
  catalog = presynthCatalog(),
} = {}) {
  const loaded = await resolve(await loadSpeakCredentials({ env, readFile }));
  const voiceId = voiceOf(roleById('host')).voiceId;
  if (!voiceId) throw new Error('群主没有音色');
  log(`凭据来源：${loaded.source}`);
  const link = createLink(loaded);
  const lines = [];
  try {
    await link.connect();
    log(`单连接已建立（第 ${link.connectCount} 次连接）`);
    for (const item of catalog) {
      const result = await withTimeout(
        link.detect({ text: scriptedDetect('群主·零号', item.text, '预合成。'), voiceId }),
        timeoutMs,
        `${item.id}这一句`,
      );
      if (!result.pcm?.length) throw new Error(`这一句没有收到音频：${item.id}`);
      const bytes = encodeMxop(result.pcm);
      if (bytes.length > MAX_FILE_BYTES) throw new Error(`音频过大：${item.id} ${bytes.length} 字节`);
      const entry = ttsManifestEntry(item, voiceId);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, entry.file), bytes);
      lines.push(entry);
      log(`${entry.file}  bytes=${bytes.length}  pcm=${result.pcm.length}`);
    }
  } finally {
    link.close();
  }
  const sfx = revealSfxWav();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'reveal-sfx.wav'), sfx);
  const manifest = { version: 1, lines: [sfxManifestEntry(), ...lines] };
  await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  log(`presynth 完成：${lines.length} 句`);
  log('目录：public/mixin/audio');
  log('manifest：public/mixin/audio/manifest.json');
  log(`音效：reveal-sfx.wav（${sfx.length} 字节，本地生成，不走语音接口）`);
  log('请把 public/mixin/audio/ 整目录提交。mxop 是 16kHz 单声道 Opus，单句应小于 256KB。');
  return { lines, manifest, connectCount: link.connectCount };
}

export async function main(options = {}) {
  try {
    await runPresynth(options);
    return 0;
  } catch (error) {
    const log = options.error ?? console.error;
    log(typeof error?.message === 'string' && error.message ? error.message : '预合成失败');
    return 1;
  }
}

if (ranAsScript()) {
  const code = await main();
  process.exitCode = code;
}
