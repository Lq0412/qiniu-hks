// 一局一条灵矽 WebSocket。建连时不读取、不锁定 stage。
// custom_replace_prompt 只出现在 hello。listen.detect 只带 agent_params.voice。

import WebSocket from 'ws';
import OpusScript from 'opusscript';
import { isStageEcho, normalizeEcho } from './mixin-game.mjs';
import { HELLO_BRIEF, scriptedBody } from './mixin-prompts.mjs';
import { scrub } from './linx-credentials.mjs';
import { sanitizeForTts } from './tts-text.mjs';

const AUDIO = {
  format: 'pcm',
  sample_rate: 16000,
  channels: 1,
  bit_depth: 16,
  endianness: 'little',
  frame_duration: 20,
  frame_size: 320,
  sample_format: 'signed_int16',
};

export function buildMixinHello(brief = HELLO_BRIEF) {
  return {
    type: 'hello',
    version: 1,
    features: { mcp: false },
    transport: 'websocket',
    audio_params: { ...AUDIO },
    agent_params: { custom_replace_prompt: { counter_brief: brief } },
  };
}

export function buildMixinDetect({ text, voiceId, mode = 'manual' } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('缺少文本');
  const id = String(voiceId ?? '').trim();
  if (!id || id.length > 128 || /[\r\n]/.test(id)) throw new Error('音色 ID 无效');
  return {
    type: 'listen',
    state: 'detect',
    mode,
    text: sanitizeForTts(text),
    agent_params: { voice: { id } },
  };
}

export function isInjectedEcho(text, injected) {
  const source = typeof text === 'string' ? text.trim() : '';
  if (!source || !Array.isArray(injected) || !injected.length) return false;
  const folded = normalizeEcho(source);
  for (const sample of injected) {
    if (typeof sample !== 'string') continue;
    if (sample.trim() === source) return true;
    const body = scriptedBody(sample);
    if (body && (body === source || normalizeEcho(body) === folded)) return true;
    if (normalizeEcho(sample) === folded) return true;
  }
  return isStageEcho(source, injected.map(sample => normalizeEcho(sample)), null, null);
}

function socketUrl(raw) {
  const url = new URL(raw);
  if (url.hostname !== 'xrobo-io.qiniuapi.com') throw new Error('Linx返回了未支持的语音地址。');
  url.protocol = 'wss:';
  return url;
}

export function createMixinLink({
  config,
  credentials,
  createSocket = (url, options) => new WebSocket(url, options),
  helloBrief = HELLO_BRIEF,
  handshakeMs = 20000,
  settleMs = 3000,
} = {}) {
  if (!config?.deviceId || !config?.clientId || !credentials?.url || !credentials?.token) throw new Error('缺少灵矽连接参数。');
  const secrets = [credentials.token, config.deviceId, config.clientId];
  const url = socketUrl(credentials.url);
  const hello = buildMixinHello(helloBrief);
  let socket = null;
  let sessionId = null;
  let ready = false;
  let connectCount = 0;
  let reconnects = 0;
  let decoder = null;
  let format = 'pcm';
  let turn = null;
  let seq = 0;
  let draining = null;
  const queued = [];
  let opening = null;
  let epoch = 0;
  const injected = [];
  const listeners = new Set();

  const emit = event => { for (const listener of [...listeners]) listener(event); };
  const clearDrain = () => {
    if (draining) clearTimeout(draining.timer);
    draining = null;
  };
  const failTurn = error => {
    clearDrain();
    for (const pending of queued.splice(0)) pending.reject(error);
    const current = turn;
    turn = null;
    current?.reject(error);
  };
  const sendJson = message => {
    if (!socket || socket.readyState !== WebSocket.OPEN) throw Object.assign(new Error('连接已关闭'), { code: 'CLOSED' });
    const body = { ...message };
    if (sessionId && body.type !== 'hello') body.session_id = sessionId;
    socket.send(JSON.stringify(body));
  };

  function startQueued() {
    if (draining || turn || !queued.length) return;
    turn = queued.shift();
    injected.push(turn.text);
    try { turn.onSent?.(); sendJson(turn.message); }
    catch (error) { failTurn(error); }
  }

  function finishDrain() {
    clearDrain();
    startQueued();
  }

  function onMessage(data, binary) {
    if (binary) {
      if (draining) return;
      const frame = Buffer.from(data);
      let pcm = format === 'pcm' ? frame : null;
      if (format === 'opus' && decoder) {
        try { pcm = Buffer.from(decoder.decode(frame)); }
        catch { pcm = null; }
      }
      if (turn) {
        turn.frames.push(frame);
        if (pcm) turn.pcm.push(pcm);
      }
      if (pcm) emit({ type: 'audio', pcm, format });
      return;
    }
    let message;
    try { message = JSON.parse(data.toString()); }
    catch { emit({ type: 'error', message: '无效消息' }); return; }
    if (!ready && message.type === 'hello') {
      ready = true;
      sessionId = message.session_id ?? null;
      const params = message.audio_params ?? {};
      format = params.format === 'opus' ? 'opus' : 'pcm';
      if (format === 'opus') decoder = new OpusScript(params.sample_rate || 16000, 1, OpusScript.Application.AUDIO);
      opening?.resolve();
      opening = null;
      return;
    }
    if (draining) {
      // stop 没有回合 ID，排空期的第一个 stop 只能归给已取消的旧轮。
      if (message.type === 'tts' && message.state === 'stop') finishDrain();
      return;
    }
    if (message.type === 'stt') {
      const text = typeof message.text === 'string' ? message.text : '';
      emit({ type: 'stt', text, echo: isInjectedEcho(text, injected) });
      return;
    }
    if (message.type === 'tts') {
      emit({ type: 'tts', message });
      if (turn && message.state === 'sentence_start' && message.text) turn.spoken.push(message.text);
      if (turn && message.state === 'stop') {
        const current = turn;
        turn = null;
        current.resolve({
          aborted: current.aborted || message.is_aborted === true,
          spoken: current.spoken.join(''),
          pcm: current.pcm.length ? Buffer.concat(current.pcm) : Buffer.alloc(0),
          frames: current.frames,
          format,
        });
        startQueued();
      }
      return;
    }
    emit({ type: 'json', message });
  }

  function attach(next) {
    const mine = ++epoch;
    const current = () => mine === epoch;
    next.on('message', (data, binary) => { if (current()) onMessage(data, binary); });
    next.on('error', error => {
      if (!current()) return;
      const wrapped = Object.assign(new Error(scrub(error?.message || '灵矽连接失败', secrets)), { code: 'SOCKET' });
      if (!ready) opening?.reject(wrapped);
      else {
        emit({ type: 'error', message: wrapped.message });
        failTurn(wrapped);
      }
    });
    next.on('close', () => {
      if (!current()) return;
      ready = false;
      const closed = Object.assign(new Error('连接已关闭'), { code: 'CLOSED' });
      if (opening) opening.reject(closed);
      failTurn(closed);
      emit({ type: 'close' });
    });
  }

  async function open() {
    if (ready && socket?.readyState === WebSocket.OPEN) return;
    if (opening) throw new Error('连接正在建立。');
    connectCount += 1;
    const pending = new Promise((resolve, reject) => { opening = { resolve, reject }; });
    const timer = setTimeout(() => {
      opening?.reject(new Error('灵矽握手超时'));
      try { socket?.close(); } catch { /* 已经在关 */ }
    }, handshakeMs);
    try {
      socket = createSocket(url, {
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Protocol-Version': '1',
          'Device-Id': config.deviceId,
          'Client-Id': config.clientId,
        },
        handshakeTimeout: Math.min(handshakeMs, 15000),
        maxPayload: 1024 * 1024,
      });
    } catch (error) {
      clearTimeout(timer);
      opening = null;
      throw new Error(scrub(error?.message || '灵矽连接失败', secrets));
    }
    attach(socket);
    const sendHello = () => { try { socket.send(JSON.stringify(hello)); } catch (error) { opening?.reject(new Error(scrub(error?.message || '灵矽连接失败', secrets))); } };
    if (socket.readyState === WebSocket.OPEN) sendHello();
    else socket.once?.('open', sendHello);
    try { await pending; }
    finally { clearTimeout(timer); }
  }

  return {
    hello,
    get connectCount() { return connectCount; },
    get reconnects() { return reconnects; },
    get injected() { return injected; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    connect: open,
    async reconnect() {
      if (reconnects >= 1) throw Object.assign(new Error('已经重连过一次'), { code: 'RECONNECT' });
      reconnects += 1;
      failTurn(Object.assign(new Error('连接已关闭'), { code: 'CLOSED' }));
      const old = socket;
      socket = null;
      ready = false;
      sessionId = null;
      epoch += 1;
      decoder?.delete?.();
      decoder = null;
      try { old?.close(); } catch { /* 旧连接已经断了 */ }
      await open();
    },
    detect({ text, voiceId, onSent }) {
      if (turn) throw new Error('上一段还没说完');
      const message = buildMixinDetect({ text, voiceId });
      if (Object.hasOwn(message, 'agent_params') && message.agent_params.custom_replace_prompt) throw new Error('listen 不能携带 custom_replace_prompt');
      const id = ++seq;
      const promise = new Promise((resolve, reject) => {
        queued.push({ seq: id, text: message.text, message, onSent, spoken: [], pcm: [], frames: [], aborted: false, resolve, reject });
        startQueued();
      });
      promise.seq = id;
      return promise;
    },
    cancelTurn(id) {
      const cancelled = Object.assign(new Error('这一句已取消'), { code: 'CANCELLED' });
      if (id !== undefined && turn?.seq !== id) {
        const index = queued.findIndex(item => item.seq === id);
        if (index >= 0) queued.splice(index, 1)[0].reject(cancelled);
        return;
      }
      const current = turn;
      if (!current) return;
      turn = null;
      current.reject(cancelled);
      clearDrain();
      draining = { seq: current.seq, timer: setTimeout(finishDrain, settleMs) };
      try { sendJson({ type: 'abort', reason: 'wake_word_detected' }); }
      catch { /* 断线时发不出去 */ }
    },
    abort() {
      const current = turn;
      if (!current) return;
      // 打断立即归还调用者，旧轮帧继续排空，不能交给下一句。
      turn = null;
      current.resolve({ aborted: true, spoken: '', pcm: Buffer.alloc(0), frames: [], format });
      clearDrain();
      draining = { seq: current.seq, timer: setTimeout(finishDrain, settleMs) };
      try { sendJson({ type: 'abort', reason: 'wake_word_detected' }); }
      catch { /* 断线时由 close 清理排空 */ }
    },
    listen(state) { sendJson({ type: 'listen', state, mode: 'manual' }); },
    sendAudio(chunk) {
      if (!socket || socket.readyState !== WebSocket.OPEN) throw Object.assign(new Error('连接已关闭'), { code: 'CLOSED' });
      socket.send(chunk, { binary: true });
    },
    close() {
      failTurn(Object.assign(new Error('连接已关闭'), { code: 'CLOSED' }));
      try { socket?.close(); } catch { /* 已经关闭 */ }
      decoder?.delete?.();
      decoder = null;
    },
  };
}
