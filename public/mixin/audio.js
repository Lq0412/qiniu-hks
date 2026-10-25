// 角色音频播放与按住录音。录音复用 16kHz PCM worklet，松开后释放麦克风。
import { VoiceAudio } from '../audio.js';
//
// play(url, options) → Promise<void>
//   url：同源音频地址。空字符串直接 resolve。
//   options.seat：0 群主，1–4 是 AI，5 是玩家。
//   options.roleId：host / claudia / astra / shensi / baobao / xiaosi / player。
//   options.voiceId：音色 id，按字符串使用，纯数字也不要转成 number。
//   options.onEnded：自然播放结束时调用。stop() 打断时不调用。
//   Promise 在播放结束或 stop() 时 resolve。
//
// stop() → void
//   停掉 play() 的对白，不停思考音。
//
// playThinking() → void
//   座位切换时的循环「思考中」音效。重复调用只保留一层。
//
// stopThinking() → void
//   只停思考音。
//
// startHoldToTalk(handlers) → Promise<void>
//   handlers.onStart()
//   handlers.onProgress({ pcm, durationMs })：每两秒提供当前完整录音的预览快照。
//   handlers.onStop({ pcm, durationMs })，pcm 为 16kHz 单声道 16bit PCM 的 base64。
//   尚未授权或主动取消时 onStop(null)。
//   handlers.onError(error)
//   handlers.onLevel(level)  level 为 0 到 1，可选。
//   按下时调用。失败走 onError，不要抛出未捕获异常。
//
// stopHoldToTalk() → void
//   松开时调用。语音模式结束录音并触发一次 onStop。

// 地址带 reveal=1，或是 webaudio:reveal 时，先用 WebAudio 合成约 0.36 秒的揭晓短音，再播对白。
// voiceId 保持字符串，不转成数字。

let generation = 0;
let current = null;
let finishCurrent = null;
let thinking = null;
let playbackPaused = false;
let playAttempt = 0;

function startCurrentAudio() {
  if (playbackPaused || !current) return;
  const audio = current;
  const attempt = ++playAttempt;
  try {
    const pending = audio.play();
    pending?.catch?.(() => {
      if (current === audio && playAttempt === attempt) finishCurrent?.(false);
    });
  } catch { if (current === audio) finishCurrent?.(false); }
}

export function pausePlayback() {
  playbackPaused = true;
  playAttempt += 1;
  current?.pause();
}

export function resumePlayback() {
  playbackPaused = false;
  startCurrentAudio();
}

function chime(cancelled) {
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AudioCtx !== 'function') return Promise.resolve();
  let ctx;
  try { ctx = new AudioCtx(); }
  catch { return Promise.resolve(); }
  const osc = ctx.createOscillator();
  const overtone = ctx.createOscillator();
  const gain = ctx.createGain();
  const at = ctx.currentTime;
  osc.frequency.value = 880;
  overtone.frequency.value = 1320;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.36);
  osc.connect(gain);
  overtone.connect(gain);
  gain.connect(ctx.destination);
  osc.start(at);
  overtone.start(at);
  osc.stop(at + 0.36);
  overtone.stop(at + 0.36);
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      ctx.close?.().catch?.(() => {});
      resolve();
    };
    osc.onended = finish;
    setTimeout(() => { if (cancelled()) resolve(); else finish(); }, 420);
  });
}

export async function play(url, options = {}) {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) return;
  stop();
  const token = generation;
  if (raw.includes('reveal=1') || raw.startsWith('webaudio:reveal')) {
    await chime(() => token !== generation);
    if (token !== generation) return;
  }
  if (raw.startsWith('webaudio:')) {
    if (token === generation) options.onEnded?.();
    return;
  }
  if (typeof Audio === 'undefined') return;
  await new Promise(resolve => {
    if (token !== generation) {
      resolve();
      return;
    }
    const audio = new Audio(raw);
    let settled = false;
    const finish = ended => {
      if (settled) return;
      settled = true;
      if (current === audio) current = null;
      if (finishCurrent === finish) finishCurrent = null;
      if (ended && token === generation) options.onEnded?.();
      resolve();
    };
    current = audio;
    finishCurrent = finish;
    audio.onended = () => finish(true);
    audio.onerror = () => finish(false);
    startCurrentAudio();
  });
}

export function stop() {
  generation += 1;
  const audio = current;
  const finish = finishCurrent;
  current = null;
  finishCurrent = null;
  if (audio) {
    audio.onended = null;
    audio.onerror = null;
    try { audio.pause(); } catch { /* 还没开始播 */ }
    try { audio.removeAttribute('src'); audio.load(); } catch { /* 没有可停的元素 */ }
  }
  finish?.(false);
}

export function playThinking() {
  if (thinking) return;
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (typeof AudioCtx !== 'function') return;
  try {
    const ctx = new AudioCtx();
    const gain = ctx.createGain();
    const osc = ctx.createOscillator();
    gain.gain.value = 0.0001;
    osc.type = 'sine';
    osc.frequency.value = 220;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    const pulse = () => {
      const at = ctx.currentTime;
      gain.gain.cancelScheduledValues(at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.05, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    };
    pulse();
    thinking = { ctx, osc, timer: setInterval(pulse, 700) };
  } catch {
    thinking = null;
  }
}

export function stopThinking() {
  if (!thinking) return;
  clearInterval(thinking.timer);
  try { thinking.osc.stop(); } catch { /* 振荡器已经停了 */ }
  thinking.ctx.close?.().catch?.(() => {});
  thinking = null;
}

let recording = null;

function recordingSnapshot(capture) {
  let binary = '';
  for (const packet of capture.packets) binary += String.fromCharCode(...packet);
  return { pcm: btoa(binary), durationMs: capture.bytes / 32 };
}

export async function startHoldToTalk(handlers = {}) {
  if (recording) return;
  const capture = { audio: new VoiceAudio(), packets: [], bytes: 0, previewBytes: 0, started: false, handlers, timer: null };
  recording = capture;
  try {
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持录音，请使用 Chrome 或 Edge 打开本地页面。');
    await capture.audio.init(packet => {
      if (recording !== capture || !capture.started) return;
      capture.packets.push(new Uint8Array(packet));
      capture.bytes += packet.byteLength;
      if (capture.bytes >= 960000) stopHoldToTalk();
      else if (handlers.onProgress && capture.bytes - capture.previewBytes >= 64000) {
        capture.previewBytes = capture.bytes;
        handlers.onProgress(recordingSnapshot(capture));
      }
    });
    if (recording !== capture) return;
    capture.started = true;
    capture.audio.record(true);
    capture.timer = setTimeout(() => stopHoldToTalk(), 30000);
    handlers.onStart?.();
  } catch (error) {
    capture.audio.close();
    if (recording !== capture) return;
    recording = null;
    const message = error.name === 'NotAllowedError' ? '麦克风权限被拒绝，请在浏览器中允许麦克风后重试。'
      : error.name === 'NotFoundError' ? '没有找到麦克风，请连接设备后重试。'
      : error.name === 'NotReadableError' ? '麦克风无法使用，可能被其他程序占用。'
      : error.message || '录音没有开始，请重试。';
    handlers.onError?.(new Error(message));
  }
}

export function stopHoldToTalk({ cancel = false } = {}) {
  const capture = recording;
  if (!capture) return;
  recording = null;
  clearTimeout(capture.timer);
  capture.audio.close();
  if (cancel || !capture.started) { capture.handlers.onStop?.(null); return; }
  capture.handlers.onStop?.(recordingSnapshot(capture));
}
