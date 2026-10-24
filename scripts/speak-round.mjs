// 真机最小语音调度：一条 WSS，六个角色轮流用自己的音色念【台词】，并过滤回声。
//
// 凭据（都不会打进日志）：
//   LINX_DEVICE_JSON   设备 JSON 正文，或该文件的路径
//   LINX_API_KEY       可选。没有写进设备 JSON 时从这里读
//   .linx-device.json  上面都没有时的本机备选（不要提交）
// 也可以跳过 OTA，同时设置 LINX_WS_URL、LINX_WS_TOKEN、LINX_DEVICE_ID、LINX_CLIENT_ID。
//
//   npm run speak:round

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadSpeakCredentials, resolveWebsocket } from '../linx-credentials.mjs';
import { createMixinLink } from '../mixin-link.mjs';
import { scriptedDetect } from '../mixin-prompts.mjs';
import { roleById, voiceOf } from '../mixin-roles.mjs';

export const SPEAK_ROUND = [
  { roleId: 'host', name: '群主·零号', line: '下一位，请加载。' },
  { roleId: 'claudia', name: 'Claude', line: '需要说明的是，这只是试听。' },
  { roleId: 'astra', name: 'GPT', line: '1️⃣ 分析 2️⃣ 行动 😊，轮到我了。' },
  { roleId: 'shensi', name: 'DeepSeek', line: '让我再核对一下约束。' },
  { roleId: 'baobao', name: 'Gemini', line: '我帮你搜一下。' },
  { roleId: 'xiaosi', name: 'Cursor', line: '代码收到，先调试。' },
];

const DEFAULT_TIMEOUT_MS = 100_000;

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

export async function runSpeakRound({ link, log = console.log, timeoutMs = DEFAULT_TIMEOUT_MS, cues = SPEAK_ROUND } = {}) {
  const echoes = [];
  const stray = [];
  const stop = link.subscribe(event => {
    if (event.type !== 'stt') return;
    if (event.echo) echoes.push(event.text);
    else if (typeof event.text === 'string' && event.text.trim()) stray.push(event.text.trim());
  });
  const turns = [];
  try {
    await link.connect();
    log(`单连接已建立（第 ${link.connectCount} 次连接）`);
    for (const [index, cue] of cues.entries()) {
      const voice = voiceOf(roleById(cue.roleId));
      if (!voice.voiceId) throw new Error(`${cue.name}没有音色`);
      const text = scriptedDetect(cue.name, cue.line, '真机试听。身份和票型由系统固定。');
      const before = echoes.length;
      const result = await withTimeout(link.detect({ text, voiceId: voice.voiceId }), timeoutMs, `${cue.name}这一句`);
      if (!result.pcm?.length) throw new Error(`${cue.name}没有收到音频`);
      const row = {
        index: index + 1,
        name: cue.name,
        roleId: cue.roleId,
        voiceId: voice.voiceId,
        voiceLabel: voice.label,
        line: cue.line,
        spoken: result.spoken,
        pcmBytes: result.pcm.length,
        echoCount: echoes.length - before,
      };
      turns.push(row);
      const spoken = row.spoken ? `口播「${row.spoken}」` : '口播（无字幕）';
      log(`[${row.index}/${cues.length}] ${row.name}｜${row.voiceLabel}｜${row.voiceId}｜台词「${row.line}」｜${spoken}｜pcm=${row.pcmBytes}｜本句回声=${row.echoCount}`);
    }
  } finally {
    stop();
    link.close();
  }
  log(`回声已过滤：${echoes.length} 条（没有当成玩家发言）`);
  log(`非回声转写：${stray.length} 条${stray.length ? `｜${stray.join(' / ')}` : ''}`);
  log(`连接次数：${link.connectCount}`);
  log('speak-round 完成');
  return { turns, echoes, stray, connectCount: link.connectCount };
}

export async function main({
  env = process.env,
  readFile,
  log = console.log,
  error = console.error,
  resolve = resolveWebsocket,
  createLink = loaded => createMixinLink({ config: loaded.config, credentials: loaded.credentials }),
  timeoutMs = Number(env.SPEAK_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
} = {}) {
  try {
    const loaded = await resolve(await loadSpeakCredentials({ env, readFile }));
    log(`凭据来源：${loaded.source}`);
    const link = createLink(loaded);
    const report = await runSpeakRound({ link, log, timeoutMs });
    return { code: 0, report };
  } catch (err) {
    error(typeof err?.message === 'string' && err.message ? err.message : '语音试听失败');
    return { code: 1 };
  }
}

if (ranAsScript()) {
  const result = await main();
  process.exitCode = result.code;
}
