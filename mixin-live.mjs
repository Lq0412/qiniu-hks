// 浏览器这一局的语音。一条连接从预合成交接到对局，按 /api/mixin 的 step 出 WAV。
// 没有预合成文件时走实时合成；还是没有音频就只留字幕。文字局不走这里。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  confirmPlayer,
  createMixinGame,
  disconnectMixin,
  fulfillCue,
  interruptMixin,
  reconnectMixin,
  restartMixin,
  revealHint,
  castVote,
  startMixin,
  submitPlayerText,
  tickMixin,
  viewMixin,
} from './mixin-game.mjs';
import { createFileAssets, wavFromPcm } from './mixin-audio.mjs';
import { isInjectedEcho } from './mixin-link.mjs';
import { HOST_REVEAL_BRIDGE, scriptedDetect, warmupDetect } from './mixin-prompts.mjs';
import { roleById, voiceOf } from './mixin-roles.mjs';

const DEFAULT_TIMEOUT_MS = 20_000;

function withTimeout(promise, ms, label, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { onTimeout?.(); }
      catch { /* 取消失败也要结束等待 */ }
      finish(reject, new Error(`${label}超时（${ms}ms）`));
    }, ms);
    promise.then(value => finish(resolve, value), error => finish(reject, error));
  });
}

async function loadAssets(dir) {
  try {
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    return createFileAssets(dir, manifest);
  } catch {
    return { async find() { return null; }, async sfx() { return null; } };
  }
}

function spokenLine(cue, live) {
  const scripted = cue.kind === 'reveal' || String(cue.instruction ?? '').includes('【台词】');
  if (scripted) return cue.line || cue.fallbackText;
  const spoken = typeof live?.spoken === 'string' ? live.spoken.trim() : '';
  if (!spoken || spoken.includes('【台词】') || spoken.includes('舞台指令') || isInjectedEcho(spoken, [cue.instruction])) {
    return cue.fallbackText;
  }
  const cap = Number.isInteger(cue.maxChars) ? cue.maxChars : spoken.length;
  return spoken.slice(0, cap);
}

export function createVoiceSession({ options = {}, lane, audioDir, timeoutMs = DEFAULT_TIMEOUT_MS, revealTimeoutMs = timeoutMs } = {}) {
  if (!lane) throw new Error('缺少语音通道');
  const game = createMixinGame(options);
  const hostVoiceId = voiceOf(roleById('host')).voiceId;
  let now = Number.isInteger(options.now) ? options.now : 0;
  let link = null;
  let prefetch = null;
  let released = false;
  const clips = new Map();

  async function detectRetry(request, limitMs = timeoutMs, valid = () => true) {
    const detect = () => {
      if (!valid()) throw new Error('这一句已过期');
      return withTimeout(link.detect(request), limitMs, '这一句', () => link.cancelTurn());
    };
    try {
      return await detect();
    } catch (error) {
      if (!valid() || error?.code !== 'CLOSED' || link.reconnects >= 1) throw error;
      if (game.phase !== 'error') disconnectMixin(game, { generation: game.generation, now, reason: '连接断开' });
      try {
        await link.reconnect();
      } finally {
        if (game.phase === 'error') reconnectMixin(game, { generation: game.generation, now });
      }
      return detect();
    }
  }

  async function speakLive({ text, voiceId, line, allowAsset, limitMs = timeoutMs, valid, cue }) {
    if (allowAsset && audioDir) {
      const assets = await loadAssets(audioDir);
      let pcm = await assets.find({ voiceId, text: line });
      // 只拆完整出题句；被 90 字截断的台词保持实时合成。
      if (!pcm?.length && cue?.kind === 'host_card') {
        const parts = /^(第[12]题：.*)(请.+先来。)$/.exec(line);
        if (parts && line === `${parts[1]}请${cue.nextName}先来。` && parts[1].endsWith(cue.card)) {
          const first = await assets.find({ voiceId, text: parts[1] });
          const next = await assets.find({ voiceId, text: parts[2] });
          if (first?.length && next?.length) pcm = Buffer.concat([first, Buffer.alloc(4800), next]);
        }
      }
      if (pcm?.length) return { pcm, spoken: line, voiceId, via: 'presynth', aborted: false };
    }
    try {
      const result = await detectRetry({ text, voiceId }, limitMs, valid);
      const aborted = result?.aborted === true;
      const pcm = !aborted && result?.pcm?.length ? result.pcm : null;
      return {
        pcm,
        spoken: aborted ? '' : (result?.spoken || '').trim(),
        voiceId: pcm ? voiceId : null,
        via: pcm ? 'live' : 'subtitle',
        aborted,
      };
    } catch {
      return { pcm: null, spoken: '', voiceId: null, via: 'subtitle', aborted: false };
    }
  }

  async function speakCue(cue, valid = () => true) {
    const voiceId = cue.voice?.voiceId;
    if (cue.kind === 'reveal') {
      const bridge = await speakLive({
        text: scriptedDetect('群主·零号', HOST_REVEAL_BRIDGE, cue.situation),
        voiceId,
        line: HOST_REVEAL_BRIDGE,
        allowAsset: true,
        valid,
      });
      if (!valid() || game.cue?.cueId !== cue.cueId) return { aborted: true, pcm: null, text: cue.line, reveal: true };
      // 两次 speakLive 各自启动计时；过渡超时后仍独立尝试结局，失败则保留过渡音频。
      const ending = await speakLive({
        text: cue.instruction,
        voiceId,
        line: cue.line,
        allowAsset: false,
        limitMs: revealTimeoutMs,
        valid,
      });
      const parts = [bridge.pcm, ending.pcm].filter(part => part?.length);
      return {
        aborted: !valid() || game.cue?.cueId !== cue.cueId,
        pcm: parts.length ? Buffer.concat(parts) : null,
        text: cue.line || cue.fallbackText,
        voiceId: parts.length ? voiceId : null,
        reveal: true,
      };
    }
    const scripted = String(cue.instruction ?? '').includes('【台词】');
    const live = await speakLive({
      text: cue.instruction,
      voiceId,
      line: scripted ? (cue.line || cue.fallbackText) : cue.fallbackText,
      allowAsset: scripted,
      cue,
      valid,
    });
    if (!valid() || game.cue?.cueId !== cue.cueId) return { aborted: true, pcm: null, text: cue.line || cue.fallbackText, reveal: false };
    return {
      aborted: false,
      pcm: live.pcm,
      text: spokenLine(cue, live),
      voiceId: live.voiceId,
      reveal: false,
    };
  }

  function discardPrefetch() {
    const pending = prefetch;
    prefetch = null;
    if (!pending) return;
    pending.cancelled = true;
    if (!pending.settled) {
      try { link?.cancelTurn(); } catch { /* 连接已关闭 */ }
    }
  }

  function releaseIfEnded() {
    if (game.phase !== 'result' || released) return;
    discardPrefetch();
    released = true;
    lane.releaseGame();
  }

  function prefetchNext() {
    const cue = game.cue;
    if (game.phase === 'result' || !cue) return;
    // fulfillCue 内的 shiftCue 已更新即兴句的 spoken 和 instruction，所有 step cue 此时均已定稿。
    const pending = { cueId: cue.cueId, cancelled: false, settled: false };
    prefetch = pending;
    pending.promise = speakCue(cue, () => !pending.cancelled).catch(() => ({
      aborted: false, pcm: null, text: cue.line || cue.fallbackText, voiceId: null, reveal: cue.kind === 'reveal',
    })).finally(() => { pending.settled = true; });
  }

  function finish(cue, spoken) {
    if (game.cue?.cueId !== cue.cueId) return { fulfilled: false, view: viewMixin(game) };
    fulfillCue(game, {
      generation: game.generation,
      cueId: cue.cueId,
      text: spoken.text,
      now,
      voiceUsed: spoken.voiceId,
      via: 'speech',
    });
    releaseIfEnded();
    prefetchNext();
    const clipWav = spoken.pcm?.length ? wavFromPcm(spoken.pcm) : null;
    return { fulfilled: true, view: viewMixin(game), clipWav, reveal: spoken.reveal === true };
  }

  return {
    game,
    clips,
    now: () => now,
    setNow(value) { now = value; },
    view() { return viewMixin(game); },
    async start() {
      if (!link || released) link = await lane.acquireForGame();
      released = false;
      try { await detectRetry({ text: warmupDetect(), voiceId: hostVoiceId }); }
      catch { /* 预热失败不挡住开局 */ }
      if (game.phase === 'error') {
        try { reconnectMixin(game, { generation: game.generation, now }); } catch { /* 开始时再报 */ }
      }
      return startMixin(game, { mode: 'live', helloOk: true, now, generation: game.generation });
    },
    async step() {
      const cue = game.cue;
      if (prefetch && prefetch.cueId !== cue?.cueId) discardPrefetch();
      if (!cue) return { fulfilled: false, view: viewMixin(game) };
      const pending = prefetch;
      const spoken = await (pending ? pending.promise : speakCue(cue));
      if (prefetch === pending) prefetch = null;
      if (spoken.aborted || game.cue?.cueId !== cue.cueId) return { fulfilled: false, view: viewMixin(game) };
      return finish(cue, spoken);
    },
    say(text, extra = {}) {
      return submitPlayerText(game, {
        generation: game.generation,
        text,
        typed: extra.typed !== false,
        durationMs: extra.durationMs ?? null,
        silenceMs: extra.silenceMs ?? null,
        now,
      });
    },
    confirm(revision = game.pending?.revision) {
      return confirmPlayer(game, { generation: game.generation, revision, now });
    },
    vote(seat) { return castVote(game, { generation: game.generation, seat, now }); },
    interrupt(text) {
      discardPrefetch();
      try { link?.abort(); } catch { /* 这一句已经说完 */ }
      return interruptMixin(game, { generation: game.generation, text, now });
    },
    hint() { return revealHint(game, { generation: game.generation }); },
    restart() {
      discardPrefetch();
      return restartMixin(game, { now });
    },
    tick(ms = 0) {
      now += ms;
      const result = tickMixin(game, now);
      if (prefetch && prefetch.cueId !== game.cue?.cueId) discardPrefetch();
      releaseIfEnded();
      return result;
    },
    tickTo(value) {
      now = value;
      const result = tickMixin(game, now);
      if (prefetch && prefetch.cueId !== game.cue?.cueId) discardPrefetch();
      releaseIfEnded();
      return result;
    },
  };
}
