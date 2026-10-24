// 灵矽语音能力探针。测量逻辑在 probe-metrics.mjs，这里负责会话、超时和报告。
// 凭据只从 .linx-device.json 或环境变量进入内存，不写进日志和结果文件。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { deviceConfig, ota } from '../linx-config.mjs';
import {
  CAST, DEFAULT_BRIEF, LATENCY_OPTIMIZATIONS, LONG_STORY_PROMPT, NEW_INPUT_PROMPT, OPENING_TEXT,
  SITUATION_QUESTION, SITUATIONS, TURN_TARGET_MS, VOICE_UNCERTAINTIES,
  assessPlanB, buildAbort, buildDetect, buildHello, buildListen, castPrompt, createInterruptState,
  createTurnState, describeAsrShape, emptyStats, finalizeInterrupt, finalizeTurn, formatProbeReport, judgeContextRecall,
  judgeMarker, judgeOpeningEcho, judgePromptUpdate, judgeRoleTurn, judgeTarget, loadPcmFrames,
  mcpInstruction, probeMcpReply, recallPrompt, redactSecrets, reduceInterrupt, reduceTurn,
  safeErrorMessage, situationBrief, summarizeLatencies, turnPrompt,
} from './probe-metrics.mjs';

export const DEFAULT_TIMEOUT_MS = 100_000;
export const HANDSHAKE_MS = 20_000;
const REQUIRED = ['firstAudio', 'turnLatency', 'voiceSwitch', 'situation', 'interrupt'];
const OPTIONAL = ['connectTiming', 'openingSttEcho', 'asrShape', 'concurrentSocket'];
const ALL_SECTIONS = [...REQUIRED, ...OPTIONAL];

export function credentialsFromEnv(env = process.env) {
  const token = env.LINX_WS_TOKEN?.trim();
  const url = env.LINX_WS_URL?.trim();
  const deviceId = env.LINX_DEVICE_ID?.trim();
  const clientId = env.LINX_CLIENT_ID?.trim();
  if (!token && !url && !deviceId && !clientId) return null;
  if (!token || !url || !deviceId || !clientId) {
    throw new Error('环境变量凭据不完整：LINX_WS_URL、LINX_WS_TOKEN、LINX_DEVICE_ID、LINX_CLIENT_ID 需要同时设置，或全部留空改走 OTA');
  }
  return { config: { deviceId, clientId }, credentials: { url, token }, source: 'env' };
}

export function resolveVoiceIds({ argvIds = [], env = process.env, config = null } = {}) {
  if (argvIds.length) return argvIds;
  if (env.LINX_VOICE_IDS?.trim()) return env.LINX_VOICE_IDS.split(',').map(item => item.trim()).filter(Boolean);
  if (Array.isArray(config?.voiceIds)) return config.voiceIds.map(item => String(item).trim()).filter(Boolean);
  return [];
}

export async function loadProbeCredentials({ env = process.env, devicePath, fetcher, now = () => Date.now() } = {}) {
  const fromEnv = credentialsFromEnv(env);
  if (fromEnv) return { ...fromEnv, otaMs: null };
  const config = await deviceConfig(devicePath);
  const started = now();
  let data;
  try { data = await ota(config, fetcher); }
  catch (error) { throw new Error(safeErrorMessage(error, [config.deviceId, config.clientId])); }
  const otaMs = now() - started;
  if (!data?.websocket?.token || !data?.websocket?.url) throw new Error('设备未绑定或 OTA 未返回语音地址');
  return { config, credentials: { url: data.websocket.url, token: data.websocket.token }, source: 'ota', otaMs };
}

export function normalizeWsUrl(raw) {
  const url = new URL(raw);
  if (url.hostname !== 'xrobo-io.qiniuapi.com') throw new Error('Linx返回了未支持的语音地址。');
  url.protocol = 'wss:';
  return url;
}

export function collectUntil(session, { timeoutMs, onEvent, done }) {
  let settled = false;
  let off = () => {};
  let timer;
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  const finish = (kind, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    off();
    if (kind === 'resolve') resolve(value);
    else reject(value);
  };
  timer = setTimeout(() => finish('reject', Object.assign(new Error('超时'), { code: 'TIMEOUT' })), timeoutMs);
  const control = { complete: () => finish('resolve', undefined) };
  off = session.subscribe(event => {
    if (settled) return;
    try {
      onEvent(event, control);
      if (done()) finish('resolve', undefined);
    } catch (error) { finish('reject', error); }
  });
  return { done: promise, cancel: () => finish('resolve', undefined) };
}

function stallMcp() {
  return { instruction: '直接回答，不要描述工具。', marker: null, calls: 0, names: [], tools: [] };
}

export function attachMcp(session, mcpState) {
  if (!mcpState || session.mcpAttached) return;
  session.mcpAttached = true;
  session.subscribe(event => {
    if (event.type !== 'json' || event.message?.type !== 'mcp') return;
    const reply = probeMcpReply(event.message.payload, mcpState);
    if (reply) session.send({ type: 'mcp', payload: reply });
  });
}

export function openLinxProbeSession({
  config, credentials, hello, mcpState = null, createSocket = (url, options) => new WebSocket(url, options),
  timeoutMs = HANDSHAKE_MS, now = () => Date.now(),
} = {}) {
  const secrets = [credentials?.token, config?.deviceId, config?.clientId];
  const url = normalizeWsUrl(credentials.url);
  const startedAt = now();
  return new Promise((resolve, reject) => {
    let settled = false;
    let ready = false;
    let sessionId = null;
    let socket;
    const listeners = new Set();
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const emit = event => {
      const stamped = { ...event, at: now() };
      for (const listener of [...listeners]) listener(stamped);
    };
    const session = {
      mcpAttached: true,
      closed: false,
      sessionId: null,
      timing: { startedAt, openAt: null, helloAt: null, helloMs: null },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      send(message) {
        if (session.closed || socket.readyState !== WebSocket.OPEN) throw new Error('连接已关闭');
        const body = { ...message };
        if (sessionId && body.session_id == null && body.type !== 'hello') body.session_id = sessionId;
        socket.send(JSON.stringify(body));
      },
      sendBinary(chunk) {
        if (session.closed || socket.readyState !== WebSocket.OPEN) throw new Error('连接已关闭');
        socket.send(chunk, { binary: true });
      },
      close() {
        session.closed = true;
        clearTimeout(timer);
        try { socket.close(); } catch { /* already closing */ }
      },
    };
    const timer = setTimeout(() => {
      try { socket?.close(); } catch { /* ignore */ }
      fail(new Error('灵矽握手超时'));
    }, timeoutMs);
    try {
      socket = createSocket(url, {
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'Protocol-Version': '1',
          'Device-Id': config.deviceId,
          'Client-Id': config.clientId,
        },
        handshakeTimeout: Math.min(timeoutMs, 15_000),
        maxPayload: 1024 * 1024,
      });
    } catch (error) {
      fail(new Error(`灵矽连接失败：${safeErrorMessage(error, secrets)}`));
      return;
    }
    const sendHello = () => {
      session.timing.openAt = now();
      try { socket.send(JSON.stringify(hello)); }
      catch (error) { fail(new Error(`灵矽连接失败：${safeErrorMessage(error, secrets)}`)); }
    };
    if (socket.readyState === WebSocket.OPEN) sendHello();
    else socket.once?.('open', sendHello);
    socket.on?.('message', (data, binary) => {
      if (session.closed) return;
      if (binary) {
        if (ready) emit({ type: 'audio', bytes: data?.length ?? 0 });
        return;
      }
      let message;
      try { message = JSON.parse(data.toString()); }
      catch { if (ready) emit({ type: 'error', message: '无效消息' }); return; }
      if (message.type === 'mcp') {
        const reply = probeMcpReply(message.payload, mcpState ?? stallMcp());
        if (reply) {
          try { socket.send(JSON.stringify({ type: 'mcp', session_id: sessionId, payload: reply })); }
          catch { /* 写失败会跟着 close */ }
        }
      }
      if (!ready && message.type === 'hello') {
        ready = true;
        sessionId = message.session_id ?? null;
        session.sessionId = sessionId;
        session.timing.helloAt = now();
        session.timing.helloMs = session.timing.helloAt - startedAt;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(session);
        }
        return;
      }
      if (ready) emit({ type: 'json', message });
    });
    socket.on?.('error', error => {
      const wrapped = new Error(`灵矽连接失败：${safeErrorMessage(error, secrets)}`);
      if (!ready) fail(wrapped);
      else emit({ type: 'error', message: wrapped.message });
    });
    socket.on?.('close', () => {
      session.closed = true;
      if (!ready) fail(new Error('灵矽连接已关闭'));
      else emit({ type: 'close' });
    });
  });
}

async function measureSpokenTurn(session, { text, mode = 'manual', voice = null, promptReplace = null, timeoutMs, now }) {
  const state = createTurnState(now());
  const pending = collectUntil(session, {
    timeoutMs,
    onEvent(event) {
      if (event.type === 'close') throw Object.assign(new Error('连接已关闭'), { code: 'CLOSED' });
      if (event.type === 'error') throw Object.assign(new Error(event.message || '连接错误'), { code: 'SOCKET' });
      reduceTurn(state, event);
    },
    done: () => state.firstAudioAt != null && state.stopAt != null,
  });
  try {
    session.send(buildDetect({ text, mode, voice, promptReplace }));
    await pending.done;
  } catch (error) {
    pending.cancel();
    const result = finalizeTurn(state);
    if (state.firstAudioAt == null) result.error = safeErrorMessage(error);
    else if (state.stopAt == null) result.drainError = safeErrorMessage(error);
    return result;
  }
  return finalizeTurn(state);
}

function packFirstAudio(turns) {
  const samples = turns.map((turn, index) => ({
    index,
    ok: turn.firstAudioMs != null,
    latencyMs: turn.firstAudioMs,
    completeMs: turn.endToEndMs,
    texts: turn.texts,
    error: turn.firstAudioMs == null ? (turn.error || '未收到 TTS 音频帧') : null,
  }));
  const stats = summarizeLatencies(samples.filter(sample => sample.ok).map(sample => sample.latencyMs));
  const target = judgeTarget(stats);
  return {
    ok: samples.length > 0 && samples.every(sample => sample.ok),
    error: samples.find(sample => !sample.ok)?.error ?? null,
    method: '同一会话内连续 listen.detect 文字注入。时钟从 send 前到第一帧 TTS 二进制，不含麦克风 ASR。',
    input: 'text',
    targetMs: TURN_TARGET_MS,
    meetsTarget: target.meetsTarget,
    targetBasis: 'p90 of firstAudioMs',
    samples,
    stats,
    optimizations: LATENCY_OPTIMIZATIONS,
  };
}

function packTurnLatency(turns) {
  const samples = turns.map((turn, index) => ({
    index,
    ok: turn.firstAudioMs != null,
    latencyMs: turn.firstAudioMs,
    completeMs: turn.endToEndMs,
    completeOk: turn.endToEndMs != null,
    texts: turn.texts,
    error: turn.firstAudioMs == null ? (turn.error || '未收到 TTS 音频帧') : turn.drainError,
  }));
  const stats = summarizeLatencies(samples.filter(sample => sample.ok).map(sample => sample.latencyMs));
  const completeStats = summarizeLatencies(samples.filter(sample => sample.completeOk).map(sample => sample.completeMs));
  return {
    ok: samples.length > 0 && samples.every(sample => sample.ok),
    error: samples.find(sample => !sample.ok)?.error ?? null,
    definition: '单个 AI 回合的开口延迟：发出本回合 listen.detect 到该回合第一帧 TTS。1.5 秒目标对照这个 p90。completeMs 记到 tts.stop，包含短句语音本身，不参与 meetsTarget。',
    input: 'text',
    targetMs: TURN_TARGET_MS,
    meetsTarget: judgeTarget(stats).meetsTarget,
    completeMeetsTarget: judgeTarget(completeStats).meetsTarget,
    samples,
    stats,
    completeStats,
    optimizations: LATENCY_OPTIMIZATIONS,
  };
}

async function runTurnBundle({ openSession, samples, timeoutMs, now, mcpState }) {
  const turns = [];
  let session = null;
  const close = () => { session?.close(); session = null; };
  try {
    for (let index = 0; index < samples; index += 1) {
      try {
        if (!session || session.closed) {
          session = await openSession({ purpose: 'turns', hello: buildHello({ promptText: DEFAULT_BRIEF }), mcpState });
          attachMcp(session, mcpState);
        }
        const turn = await measureSpokenTurn(session, { text: turnPrompt(index), timeoutMs, now });
        turns.push(turn);
        if (turn.drainError || session.closed) close();
      } catch (error) {
        turns.push({ ...finalizeTurn(createTurnState(now())), error: safeErrorMessage(error) });
        close();
      }
    }
  } finally { close(); }
  return { firstAudio: packFirstAudio(turns), turnLatency: packTurnLatency(turns) };
}

function assignCast(voiceIds) {
  if (voiceIds.length < CAST.length) {
    return { error: `需要 ${CAST.length} 个音色 ID（${CAST.map(member => member.name).join('、')}），当前 ${voiceIds.length} 个。用 LINX_VOICE_IDS 或 .linx-device.json 的 voiceIds 提供，不要写进仓库。` };
  }
  return { cast: CAST.map((member, index) => ({ ...member, voiceId: voiceIds[index] })) };
}

async function runVoiceSection({ openSession, voiceIds, timeoutMs, now, mcpState }) {
  const assigned = assignCast(voiceIds);
  if (assigned.error) {
    return { ok: false, error: assigned.error, turns: [], recall: null, contextKept: null, roleFidelity: null, turnsOk: null, stats: emptyStats(), samples: [] };
  }
  const session = await openSession({ purpose: 'voiceSwitch', hello: buildHello({ promptText: '语音探针换音色。请严格只扮演用户指定的那一个角色。' }), mcpState });
  attachMcp(session, mcpState);
  const turns = [];
  try {
    for (const member of assigned.cast) {
      const others = assigned.cast.filter(item => item.marker !== member.marker).map(item => item.marker);
      const turn = await measureSpokenTurn(session, {
        text: castPrompt(member), timeoutMs, now,
        voice: { id: member.voiceId, speed: member.speed, pitch: member.pitch, emotion: member.emotion },
      });
      const role = judgeRoleTurn({ texts: turn.texts, ownMarker: member.marker, otherMarkers: others });
      const previous = turns.at(-1);
      turns.push({
        role: member.role, name: member.name, voiceId: member.voiceId,
        voiceParams: { id: member.voiceId, speed: member.speed, pitch: member.pitch, emotion: member.emotion },
        ok: turn.firstAudioMs != null && role.roleFidelity,
        latencyMs: turn.firstAudioMs,
        deltaFromPreviousMs: previous?.latencyMs == null || turn.firstAudioMs == null ? null : turn.firstAudioMs - previous.latencyMs,
        texts: turn.texts,
        ...role,
        error: turn.firstAudioMs == null ? (turn.error || '未收到 TTS 音频帧') : role.roleFidelity ? null : '没有只说本角色的口令',
      });
      if (session.closed) break;
    }
    const recallTurn = session.closed ? null : await measureSpokenTurn(session, {
      text: recallPrompt(), timeoutMs, now,
      voice: { id: assigned.cast.at(-1).voiceId, speed: 1, pitch: 1, emotion: 'neutral' },
    });
    const markers = assigned.cast.filter(member => member.role !== 'host').map(member => member.marker);
    const recallJudge = recallTurn ? judgeContextRecall({ texts: recallTurn.texts, markers }) : { contextKept: null, hit: [], missing: markers };
    const recall = recallTurn ? { ...recallJudge, latencyMs: recallTurn.firstAudioMs, texts: recallTurn.texts, error: recallTurn.error } : { contextKept: null, hit: [], missing: markers, latencyMs: null, texts: [], error: '会话已断开' };
    const roleFidelity = turns.length === assigned.cast.length ? turns.every(turn => turn.roleFidelity) : null;
    const turnsOk = turns.length === assigned.cast.length && turns.every(turn => turn.latencyMs != null);
    const contextKept = recall.contextKept;
    const ok = Boolean(turnsOk && roleFidelity && contextKept);
    let error = null;
    if (!turnsOk) error = turns.find(turn => !turn.ok)?.error || '五个音色没有全部开口';
    else if (!roleFidelity) error = '有角色替别人说话或没说自己的口令';
    else if (!contextKept) error = `主持人没有复述全部角色口令：${(recall.missing ?? []).join('、')}`;
    return {
      ok, error, turns, recall, contextKept, roleFidelity, turnsOk,
      mechanism: '同一条连接、同一个 session_id。每次 listen state=detect 同时带 text 和 agent_params.voice（id/speed/pitch/emotion）。',
      docs: 'https://linx.qiniu.com/docs/xrobot/platform/agent-voice-switch',
      samples: turns.map(turn => ({ ok: turn.latencyMs != null, latencyMs: turn.latencyMs, role: turn.role, error: turn.error })),
      stats: summarizeLatencies(turns.filter(turn => turn.latencyMs != null).map(turn => turn.latencyMs)),
      switchStats: summarizeLatencies(turns.slice(1).map(turn => turn.deltaFromPreviousMs)),
    };
  } finally { session.close(); }
}

async function runSituationSection({ openSession, timeoutMs, now, promptKey, reconnectSamples, mcpStateForStall }) {
  const trials = [];
  let session = null;
  const open = async (purpose, hello, mcpState) => {
    session?.close();
    session = await openSession({ purpose, hello, mcpState });
    attachMcp(session, mcpState);
    return session;
  };
  try {
    try {
      await open('situation-hello', buildHello({ promptKey, promptText: situationBrief(SITUATIONS.hello) }), mcpStateForStall);
      const turn = await measureSpokenTurn(session, { text: SITUATION_QUESTION, timeoutMs, now });
      const heard = judgeMarker(turn.texts, SITUATIONS.hello).heard;
      trials.push({
        method: 'hello.custom_replace_prompt', ok: heard && turn.firstAudioMs != null, marker: SITUATIONS.hello,
        heardMarker: heard, latencyMs: turn.firstAudioMs, texts: turn.texts,
        error: turn.firstAudioMs == null ? (turn.error || '未收到 TTS 音频帧') : heard ? null : 'TTS 未包含 hello 注入的局势口令',
      });
    } catch (error) {
      trials.push({ method: 'hello.custom_replace_prompt', ok: false, heardMarker: false, latencyMs: null, texts: [], error: safeErrorMessage(error) });
      session = null;
    }
    try {
      if (!session || session.closed) throw new Error('没有可继续的会话');
      const turn = await measureSpokenTurn(session, {
        text: SITUATION_QUESTION, timeoutMs, now,
        promptReplace: { [promptKey]: situationBrief(SITUATIONS.listenUpdate) },
      });
      const judged = judgeMarker(turn.texts, SITUATIONS.listenUpdate, [SITUATIONS.hello]);
      const observation = judgePromptUpdate({ heardNew: judged.heard, heardOld: judged.alsoHeard.includes(SITUATIONS.hello) });
      trials.push({
        method: 'listen.custom_replace_prompt', ok: turn.firstAudioMs != null, observation,
        heardNew: judged.heard, heardOld: judged.alsoHeard.includes(SITUATIONS.hello), documentedHelloOnly: true,
        latencyMs: turn.firstAudioMs, texts: turn.texts,
        error: turn.firstAudioMs == null ? (turn.error || '未收到 TTS 音频帧') : null,
        note: '官方文档只把 custom_replace_prompt 定义在 hello。这里在同一会话的 listen 上再送一次，只观察会不会改口。',
      });
    } catch (error) {
      trials.push({ method: 'listen.custom_replace_prompt', ok: false, observation: null, error: safeErrorMessage(error) });
    }
    const mcpState = { instruction: mcpInstruction(SITUATIONS.mcpFirst), marker: SITUATIONS.mcpFirst, calls: 0, names: [], tools: undefined };
    try {
      await open('situation-mcp', buildHello({ mcp: true, promptKey, promptText: situationBrief(null, { mcp: true }) }), mcpState);
      const first = await measureSpokenTurn(session, { text: SITUATION_QUESTION, timeoutMs, now });
      mcpState.instruction = mcpInstruction(SITUATIONS.mcpSecond);
      mcpState.marker = SITUATIONS.mcpSecond;
      const second = await measureSpokenTurn(session, { text: SITUATION_QUESTION, timeoutMs, now });
      const heardFirst = judgeMarker(first.texts, SITUATIONS.mcpFirst).heard;
      const heardSecond = judgeMarker(second.texts, SITUATIONS.mcpSecond).heard;
      const toolCalled = mcpState.calls >= 2;
      let error = null;
      if (!toolCalled) error = '模型未调用局势工具';
      else if (!heardFirst) error = '第一次 instruction 没有进入 TTS';
      else if (!heardSecond) error = '新的 instruction 没有进入后续 TTS';
      trials.push({
        method: 'mcp-tool-instruction', ok: toolCalled && heardFirst && heardSecond, toolCalls: mcpState.calls,
        toolNames: [...mcpState.names], updated: heardSecond,
        updates: [
          { marker: SITUATIONS.mcpFirst, heard: heardFirst, latencyMs: first.firstAudioMs, texts: first.texts, error: first.error },
          { marker: SITUATIONS.mcpSecond, heard: heardSecond, latencyMs: second.firstAudioMs, texts: second.texts, error: second.error },
        ],
        error,
      });
    } catch (error) {
      trials.push({ method: 'mcp-tool-instruction', ok: false, toolCalls: mcpState.calls, error: safeErrorMessage(error) });
    }
    const samples = [];
    try {
      for (let index = 0; index < reconnectSamples; index += 1) {
        const started = now();
        const next = await open('situation-reconnect', buildHello({ promptKey, promptText: situationBrief(SITUATIONS.reconnect) }), mcpStateForStall);
        const reconnectMs = now() - started;
        const turn = await measureSpokenTurn(session, { text: SITUATION_QUESTION, timeoutMs, now });
        const heard = judgeMarker(turn.texts, SITUATIONS.reconnect).heard;
        samples.push({
          ok: heard && reconnectMs != null, reconnectMs, helloMs: next.timing?.helloMs ?? null,
          heardMarker: heard, latencyMs: turn.firstAudioMs,
          error: turn.firstAudioMs == null ? (turn.error || '未收到 TTS 音频帧') : heard ? null : '重连后的 hello 口令没有出现在 TTS',
        });
      }
      trials.push({
        method: 'reconnect-hello', ok: samples.length > 0 && samples.every(sample => sample.ok), marker: SITUATIONS.reconnect,
        samples, stats: summarizeLatencies(samples.filter(sample => sample.ok).map(sample => sample.reconnectMs)),
        error: samples.find(sample => !sample.ok)?.error ?? null,
        note: '重连耗时从关闭上一条开始，到新会话 hello 完成，不含 OTA。',
      });
    } catch (error) {
      trials.push({
        method: 'reconnect-hello', ok: false, samples, error: safeErrorMessage(error),
        stats: summarizeLatencies(samples.filter(sample => sample.reconnectMs != null).map(sample => sample.reconnectMs)),
      });
    }
  } finally { session?.close(); }
  return {
    ok: trials.length > 0 && trials.every(trial => trial.ok),
    error: trials.find(trial => !trial.ok)?.error ?? null,
    helloOnlyDocumented: true,
    promptKey,
    definition: 'custom_replace_prompt 按文档只在 hello 替换系统提示里的占位符。中途更新看 MCP instruction，或按阶段重连。',
    trials,
  };
}

async function runInterruptTrial(session, { mode, method, timeoutMs, now, armFrames = 2, tailMs = 250 }) {
  session.send(buildListen({ state: 'start', mode }));
  const acc = { phase: 'arm', audioFrames: 0, interrupt: null, error: null, tail: null };
  const pending = collectUntil(session, {
    timeoutMs,
    onEvent(event, control) {
      if (event.type === 'close') throw Object.assign(new Error('连接已关闭'), { code: 'CLOSED' });
      if (acc.phase === 'arm') {
        if (event.type === 'audio') acc.audioFrames += 1;
        if (event.type === 'json' && event.message?.type === 'tts' && event.message.state === 'stop' && acc.audioFrames < armFrames) {
          acc.phase = 'failed';
          acc.error = '未进入播报就结束';
        }
        if (acc.phase === 'arm' && acc.audioFrames >= armFrames) {
          acc.phase = 'wait-stop';
          acc.interrupt = createInterruptState(now());
          session.send(method === 'abort' ? buildAbort() : buildDetect({ text: NEW_INPUT_PROMPT, mode }));
        }
        return;
      }
      if (acc.phase === 'wait-stop') {
        reduceInterrupt(acc.interrupt, event);
        if (acc.interrupt.stopAt != null) {
          clearTimeout(acc.tail);
          acc.tail = setTimeout(() => control.complete(), tailMs);
        }
      }
    },
    done: () => acc.phase === 'failed',
  });
  try {
    session.send(buildDetect({ text: LONG_STORY_PROMPT, mode }));
    await pending.done;
  } catch (error) {
    pending.cancel();
    if (acc.phase === 'wait-stop') {
      const settled = finalizeInterrupt(acc.interrupt, { method });
      return { mode, method, ...settled, error: settled.error || safeErrorMessage(error) };
    }
    return { mode, method, ok: false, latencyMs: null, stopLatencyMs: null, lastAudioLatencyMs: null, isAborted: false, audioAfterStop: 0, error: safeErrorMessage(error) };
  } finally { clearTimeout(acc.tail); }
  if (acc.phase === 'failed') return { mode, method, ok: false, latencyMs: null, stopLatencyMs: null, lastAudioLatencyMs: null, isAborted: false, audioAfterStop: 0, error: acc.error };
  return { mode, method, ...finalizeInterrupt(acc.interrupt, { method }) };
}

async function runInterruptSection({ openSession, modes, interruptSamples, timeoutMs, now, mcpState, tailMs }) {
  const groups = {};
  for (const mode of modes) {
    for (const method of ['abort', 'new-input']) {
      const key = `${mode}:${method}`;
      const samples = [];
      for (let index = 0; index < interruptSamples; index += 1) {
        let session = null;
        try {
          session = await openSession({ purpose: 'interrupt', hello: buildHello({ promptText: DEFAULT_BRIEF }), mcpState });
          attachMcp(session, mcpState);
          samples.push(await runInterruptTrial(session, { mode, method, timeoutMs, now, tailMs }));
        } catch (error) {
          samples.push({ mode, method, ok: false, latencyMs: null, error: safeErrorMessage(error) });
        } finally { session?.close(); }
      }
      groups[key] = {
        ok: samples.length > 0 && samples.every(sample => sample.ok),
        error: samples.find(sample => !sample.ok)?.error ?? null,
        samples,
        stats: summarizeLatencies(samples.filter(sample => sample.ok && sample.latencyMs != null).map(sample => sample.latencyMs)),
      };
    }
  }
  const entries = Object.values(groups);
  return {
    ok: entries.length > 0 && entries.every(group => group.ok),
    error: entries.find(group => !group.ok)?.error ?? null,
    definition: '从发出打断到音频流停止。打断后若还有音频帧，取最后一帧相对打断的时间；否则取 tts.stop。abort 在 stop 之后又来音频算失败。new-input 允许 stop 之后开始新的一句。',
    groups,
  };
}

async function runTimingSection({ openSession, samples, timeoutMs, now, otaMs, source }) {
  const taken = [];
  for (let index = 0; index < samples; index += 1) {
    let session = null;
    try {
      session = await openSession({ purpose: 'timing', hello: buildHello({ promptText: DEFAULT_BRIEF }), mcpState: stallMcp() });
      taken.push({ ok: session.timing?.helloMs != null, otaMs: index === 0 ? otaMs : null, connectHelloMs: session.timing?.helloMs ?? null, error: null });
    } catch (error) {
      taken.push({ ok: false, otaMs: index === 0 ? otaMs : null, connectHelloMs: null, error: safeErrorMessage(error) });
    } finally { session?.close(); }
  }
  return {
    ok: taken.length > 0 && taken.every(sample => sample.ok),
    error: taken.find(sample => !sample.ok)?.error ?? null,
    optional: true,
    source,
    otaMs,
    otaNote: otaMs == null ? '本次 token 来自环境变量，没有调用 OTA。' : 'OTA 只测一次，后面的 hello 复用这次 token。',
    samples: taken,
    stats: summarizeLatencies(taken.filter(sample => sample.connectHelloMs != null).map(sample => sample.connectHelloMs)),
  };
}

async function runEchoSection({ openSession, timeoutMs, now, mcpState }) {
  const session = await openSession({ purpose: 'echo', hello: buildHello({ promptText: DEFAULT_BRIEF }), mcpState });
  attachMcp(session, mcpState);
  try {
    const turn = await measureSpokenTurn(session, { text: OPENING_TEXT, timeoutMs, now });
    const echo = judgeOpeningEcho({ openingText: OPENING_TEXT, sttTexts: turn.stt });
    return { ok: turn.firstAudioMs != null, optional: true, openingText: OPENING_TEXT, echoed: echo.echoed, sttTexts: echo.sttTexts, latencyMs: turn.firstAudioMs, error: turn.firstAudioMs == null ? (turn.error || '未收到 TTS 音频帧') : null };
  } finally { session.close(); }
}

async function runAsrSection({ openSession, asrWav, timeoutMs, now, readFileImpl = readFile }) {
  if (!asrWav) {
    return { ok: true, skipped: true, measured: false, optional: true, transcript: null, shape: null, reason: '默认文字注入，不经过真实 ASR。设置 --asr-wav 或 LINX_ASR_WAV 指向 16kHz 单声道 16bit WAV/PCM 后再测。', error: null };
  }
  const frames = loadPcmFrames(await readFileImpl(asrWav));
  const session = await openSession({ purpose: 'asr', hello: buildHello({ promptText: DEFAULT_BRIEF }), mcpState: stallMcp() });
  const state = createTurnState(now());
  const pending = collectUntil(session, {
    timeoutMs,
    onEvent: event => reduceTurn(state, event),
    done: () => state.stt.length > 0,
  });
  try {
    session.send(buildListen({ state: 'start', mode: 'manual' }));
    for (const frame of frames) session.sendBinary(frame);
    session.send(buildListen({ state: 'stop', mode: 'manual' }));
    await pending.done;
  } catch (error) {
    pending.cancel();
    const transcript = state.stt.join('\n');
    if (!transcript) return { ok: false, skipped: false, measured: true, optional: true, transcript: '', shape: null, frames: frames.length, error: safeErrorMessage(error) };
  } finally { session.close(); }
  const transcript = state.stt.join('\n');
  return { ok: true, skipped: false, measured: true, optional: true, transcript, shape: describeAsrShape(transcript), frames: frames.length, error: null };
}

async function runConcurrentSection({ openSession, holdMs, now, sleep }) {
  let first = null;
  let second = null;
  const started = now();
  try {
    first = await openSession({ purpose: 'concurrent', hello: buildHello({ promptText: DEFAULT_BRIEF }), mcpState: stallMcp() });
    try { second = await openSession({ purpose: 'concurrent', hello: buildHello({ promptText: DEFAULT_BRIEF }), mcpState: stallMcp() }); }
    catch (error) {
      return { ok: true, optional: true, allowed: false, bothAlive: false, connectMs: now() - started, error: null, detail: safeErrorMessage(error), method: '同一 Device-Id、Client-Id 和 token 上重叠两次握手' };
    }
    await sleep(holdMs);
    const bothAlive = !first.closed && !second.closed;
    return {
      ok: true, optional: true, allowed: bothAlive, bothAlive, connectMs: now() - started, error: null,
      detail: bothAlive ? '第二条 hello 完成，保持期间两条都没有断开' : '第二条握手之后，至少一条连接已断开',
      method: '同一 Device-Id、Client-Id 和 token 上重叠两次握手',
    };
  } catch (error) {
    return { ok: false, optional: true, allowed: null, bothAlive: false, connectMs: now() - started, error: safeErrorMessage(error), detail: null, method: '同一 Device-Id、Client-Id 和 token 上重叠两次握手' };
  } finally {
    first?.close();
    second?.close();
  }
}

function skipped(reason = '已跳过') {
  return { ok: true, skipped: true, error: null, reason };
}

export async function runVoiceProbe({
  openSession, now = () => Date.now(), voices = [], samples = 5, interruptSamples = 3, timingSamples = 3,
  reconnectSamples = 1, timeoutMs = DEFAULT_TIMEOUT_MS, modes = ['manual', 'realtime'], sections = ALL_SECTIONS,
  promptKey = 'counter_brief', holdMs = 500, tailMs = 250, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  otaMs = null, credentialSource = null, asrWav = null, readFileImpl, timestamp, live = false, secrets = [],
} = {}) {
  const wanted = new Set(sections);
  const report = {
    timestamp: timestamp ?? new Date(now()).toISOString(),
    targetMs: TURN_TARGET_MS,
    ok: false,
    optionalOk: true,
    live: Boolean(live),
    input: 'text',
    inputNote: '首字、换音色、打断、局势默认用 listen.detect 文字注入。预录音频只用于 asrShape。',
    uncertainties: VOICE_UNCERTAINTIES,
    probes: {},
    planB: null,
    error: null,
  };
  const run = async (name, fn) => {
    if (!wanted.has(name)) {
      report.probes[name] = skipped();
      return null;
    }
    try { return report.probes[name] = await fn(); }
    catch (error) {
      report.probes[name] = { ok: false, error: safeErrorMessage(error, secrets), samples: [], stats: emptyStats() };
      return null;
    }
  };
  const mcpState = stallMcp();
  let bundle = null;
  if (wanted.has('firstAudio') || wanted.has('turnLatency')) {
    try { bundle = await runTurnBundle({ openSession, samples, timeoutMs, now, mcpState }); }
    catch (error) { bundle = { error: safeErrorMessage(error, secrets) }; }
  }
  report.probes.firstAudio = !wanted.has('firstAudio') ? skipped() : bundle?.firstAudio ?? { ok: false, error: bundle?.error || '回合样本没有生成', samples: [], stats: emptyStats(), meetsTarget: null, optimizations: LATENCY_OPTIMIZATIONS };
  report.probes.turnLatency = !wanted.has('turnLatency') ? skipped() : bundle?.turnLatency ?? { ok: false, error: bundle?.error || '回合样本没有生成', samples: [], stats: emptyStats(), meetsTarget: null, completeMeetsTarget: null, optimizations: LATENCY_OPTIMIZATIONS };
  await run('voiceSwitch', () => runVoiceSection({ openSession, voiceIds: voices, timeoutMs, now, mcpState }));
  await run('situation', () => runSituationSection({ openSession, timeoutMs, now, promptKey, reconnectSamples, mcpStateForStall: mcpState }));
  await run('interrupt', () => runInterruptSection({ openSession, modes, interruptSamples, timeoutMs, now, mcpState, tailMs }));
  await run('connectTiming', () => runTimingSection({ openSession, samples: timingSamples, timeoutMs, now, otaMs, source: credentialSource }));
  await run('openingSttEcho', () => runEchoSection({ openSession, timeoutMs, now, mcpState }));
  await run('asrShape', () => runAsrSection({ openSession, asrWav, timeoutMs, now, readFileImpl }));
  await run('concurrentSocket', () => runConcurrentSection({ openSession, holdMs, now, sleep }));
  const voice = report.probes.voiceSwitch ?? {};
  const concurrent = report.probes.concurrentSocket;
  const turn = report.probes.turnLatency;
  report.planB = assessPlanB({
    contextKept: voice.contextKept ?? null,
    roleFidelity: voice.roleFidelity ?? null,
    turnsOk: voice.turnsOk ?? null,
    concurrentAllowed: concurrent?.skipped ? null : concurrent?.allowed ?? null,
    latencyOk: turn?.skipped ? null : turn?.meetsTarget ?? null,
    live,
  });
  if (voice && !voice.skipped) voice.planB = report.planB;
  report.ok = REQUIRED.every(name => report.probes[name]?.skipped || report.probes[name]?.ok === true);
  report.optionalOk = OPTIONAL.every(name => {
    const section = report.probes[name];
    return !section || section.skipped || section.ok === true;
  });
  return redactSecrets(report, secrets);
}

export async function writeProbeReport(dir, report) {
  await mkdir(dir, { recursive: true });
  const stamp = String(report.timestamp ?? 'unknown').replace(/[:.]/g, '-');
  const file = path.join(dir, `voice-probe-${stamp}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function parseArgs(argv) {
  const args = { help: false, out: 'probe-results', samples: 5, interruptSamples: 3, timingSamples: 3, reconnectSamples: 1, timeoutMs: DEFAULT_TIMEOUT_MS, voices: [], modes: ['manual', 'realtime'], skip: [], asrWav: null, holdMs: 500 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value == null || value.startsWith('--')) throw new Error(`缺少参数值：${token}`);
      index += 1;
      return value;
    };
    if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--out') args.out = next();
    else if (token === '--samples') args.samples = Number(next());
    else if (token === '--interrupt-samples') args.interruptSamples = Number(next());
    else if (token === '--timing-samples') args.timingSamples = Number(next());
    else if (token === '--reconnect-samples') args.reconnectSamples = Number(next());
    else if (token === '--timeout') args.timeoutMs = Number(next());
    else if (token === '--hold-ms') args.holdMs = Number(next());
    else if (token === '--voices') args.voices = next().split(',').map(item => item.trim()).filter(Boolean);
    else if (token === '--modes') args.modes = next().split(',').map(item => item.trim()).filter(Boolean);
    else if (token === '--skip') args.skip = next().split(',').map(item => item.trim()).filter(Boolean);
    else if (token === '--asr-wav') args.asrWav = next();
    else throw new Error(`未知参数：${token}`);
  }
  for (const [key, value] of [['samples', args.samples], ['interruptSamples', args.interruptSamples], ['timingSamples', args.timingSamples], ['reconnectSamples', args.reconnectSamples]]) {
    if (!Number.isInteger(value) || value < 1 || value > 30) throw new Error(`${key} 需要是 1 到 30 的整数`);
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 1) throw new Error('timeout 无效');
  for (const mode of args.modes) if (!['manual', 'realtime', 'auto'].includes(mode)) throw new Error(`未知监听模式：${mode}`);
  for (const name of args.skip) if (!ALL_SECTIONS.includes(name)) throw new Error(`未知探针项：${name}`);
  return args;
}

export const HELP = `用法: npm run probe:voice -- [选项]
  --out probe-results     结果目录（已 gitignore）
  --samples 5             首字/回合开口取样次数
  --interrupt-samples 3   每种打断方式的取样次数
  --timing-samples 3      hello 握手取样次数
  --reconnect-samples 1   局势重连取样次数
  --timeout 100000        单回合超时，默认 100 秒（平台偶发 80–120 秒空等）
  --voices id1,id2,id3,id4,id5
                          顺序为阿柿、阿梨、阿枣、阿桃、主持。也可用 LINX_VOICE_IDS
  --modes manual,realtime
  --skip concurrentSocket,asrShape
  --asr-wav path          16kHz 单声道 16bit WAV 或原始 PCM，测真实 ASR 文本
  --hold-ms 500           双连接同时存活的观察窗口
凭据: .linx-device.json（可用 LINX_DEVICE_FILE）或同时设置
  LINX_WS_URL LINX_WS_TOKEN LINX_DEVICE_ID LINX_CLIENT_ID
音色 ID 也可写在设备文件的 voiceIds，不要提交该文件。`;

export async function main(argv = process.argv.slice(2), io = console, deps = {}) {
  let args;
  try { args = parseArgs(argv); }
  catch (error) {
    io.error?.(safeErrorMessage(error));
    return 1;
  }
  if (args.help) {
    io.log?.(HELP);
    return 0;
  }
  const sections = ALL_SECTIONS.filter(name => !args.skip.includes(name));
  const load = deps.loadProbeCredentials ?? loadProbeCredentials;
  const open = deps.openLinxProbeSession ?? openLinxProbeSession;
  const write = deps.writeProbeReport ?? writeProbeReport;
  const env = deps.env ?? process.env;
  let loaded = null;
  try {
    if (sections.length) {
      loaded = await load({ env, devicePath: env.LINX_DEVICE_FILE || undefined, now: deps.now });
    }
  } catch (error) {
    const failed = redactSecrets({
      timestamp: new Date().toISOString(), ok: false, optionalOk: false, live: true, error: safeErrorMessage(error),
      probes: {}, planB: null, uncertainties: VOICE_UNCERTAINTIES,
    });
    try { await write(args.out, failed); } catch { /* 结果目录不可写时仍把原因打到终端 */ }
    io.error?.(failed.error);
    io.log?.(formatProbeReport(failed));
    return 1;
  }
  const secrets = loaded ? [loaded.credentials.token, loaded.config.deviceId, loaded.config.clientId, loaded.config.apiKey, loaded.config.api_key, env.LINX_API_KEY] : [env.LINX_API_KEY];
  const voices = resolveVoiceIds({ argvIds: args.voices, env, config: loaded?.config });
  const report = await runVoiceProbe({
    openSession: spec => open({
      config: loaded.config, credentials: loaded.credentials, hello: spec.hello, mcpState: spec.mcpState,
      timeoutMs: Math.min(args.timeoutMs, HANDSHAKE_MS), now: deps.now, createSocket: deps.createSocket,
    }),
    now: deps.now, voices, samples: args.samples, interruptSamples: args.interruptSamples, timingSamples: args.timingSamples,
    reconnectSamples: args.reconnectSamples, timeoutMs: args.timeoutMs, modes: args.modes, sections, promptKey: env.LINX_PROMPT_KEY || 'counter_brief',
    holdMs: args.holdMs, tailMs: deps.tailMs, otaMs: loaded?.otaMs ?? null, credentialSource: loaded?.source ?? null,
    asrWav: args.asrWav || env.LINX_ASR_WAV || null, live: true, secrets, sleep: deps.sleep, readFileImpl: deps.readFileImpl,
  });
  const file = await write(args.out, report);
  io.log?.(formatProbeReport(report));
  io.log?.(`结果文件: ${file}`);
  return report.ok ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then(code => { process.exitCode = code; }, error => {
    console.error(safeErrorMessage(error));
    process.exitCode = 1;
  });
}
