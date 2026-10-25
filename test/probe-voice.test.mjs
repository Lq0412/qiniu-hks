import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAST, OPENING_TEXT, LONG_STORY_PROMPT, NEW_INPUT_PROMPT, SITUATION_QUESTION, SITUATIONS,
  assessPlanB, buildAbort, buildDetect, buildHello, buildVoiceParams, castPrompt, createInterruptState,
  createTurnState, describeAsrShape, finalizeInterrupt, finalizeTurn, formatProbeReport, judgeContextRecall,
  judgeOpeningEcho, judgePromptUpdate, judgeRoleTurn, judgeTarget, loadPcmFrames, mcpInstruction,
  percentileNearestRank, probeMcpReply, recallPrompt, redactSecrets, reduceInterrupt, reduceTurn,
  safeErrorMessage, situationBrief, summarizeLatencies,
} from '../scripts/probe-metrics.mjs';
import {
  attachMcp, credentialsFromEnv, loadProbeCredentials, main, openLinxProbeSession, parseArgs,
  resolveVoiceIds, runVoiceProbe, writeProbeReport,
} from '../scripts/probe-voice.mjs';

const VOICES = ['v-shi', 'v-li', 'v-zao', 'v-tao', 'v-host'];

function wavWithPcm(pcm, { channels = 1, rate = 16000, bits = 16 } = {}) {
  const dataSize = pcm.length;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * channels * (bits / 8), 28);
  buffer.writeUInt16LE(channels * (bits / 8), 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  Buffer.from(pcm).copy(buffer, 44);
  return buffer;
}

function speak(session, clock, text) {
  session.emit({ type: 'audio', at: clock.value });
  clock.value += 5;
  session.emit({ type: 'json', at: clock.value, message: { type: 'tts', state: 'sentence_start', text } });
  clock.value += 5;
  session.emit({ type: 'json', at: clock.value, message: { type: 'tts', state: 'stop', is_aborted: false } });
}

function createHarness(options = {}) {
  const clock = { value: 1_700_000_000_000 };
  const sessions = [];
  const now = () => clock.value;
  const openSession = async spec => {
    const helloText = spec.hello?.agent_params?.custom_replace_prompt?.counter_brief || '';
    const overlapping = sessions.some(item => !item.closed);
    if (options.refuseSecond && overlapping) throw new Error('第二条连接被拒绝 probe-secret-token');
    if (spec.purpose === 'voiceSwitch' && options.failVoice) throw new Error('换音色失败 probe-secret-token 02:10:20:30:40:50');
    const pad = spec.purpose === 'situation-reconnect' || helloText.includes(SITUATIONS.reconnect) ? 120 : 30;
    clock.value += pad;
    const listeners = new Set();
    const session = {
      purpose: spec.purpose,
      helloBrief: helloText,
      mcpState: spec.mcpState,
      sent: [],
      closed: false,
      mcpSeq: 0,
      timing: { helloMs: pad, startedAt: clock.value - pad, helloAt: clock.value },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      emit(event) { for (const listener of [...listeners]) listener({ ...event, at: event.at ?? now() }); },
      send(message) { session.sent.push(message); react(session, message); },
      sendBinary(frame) { session.sent.push({ binary: true, bytes: frame.length }); },
      close() { session.closed = true; session.emit({ type: 'close' }); },
    };
    sessions.push(session);
    return session;
  };
  function react(session, message) {
    if (message.type === 'mcp') {
      const text = message.payload?.result?.content?.[0]?.text;
      if (!text) return;
      clock.value += 40;
      speak(session, clock, JSON.parse(text).situation || '没有口令');
      return;
    }
    if (message.type === 'abort') {
      clock.value += 25;
      session.emit({ type: 'audio' });
      clock.value += 15;
      session.emit({ type: 'json', message: { type: 'tts', state: 'stop', is_aborted: true } });
      if (options.abortLeak) { clock.value += 5; session.emit({ type: 'audio' }); }
      return;
    }
    if (message.type !== 'listen') return;
    if (message.state === 'stop') {
      clock.value += 20;
      session.emit({ type: 'json', message: { type: 'stt', text: '明天三点见' } });
      return;
    }
    if (message.state !== 'detect') return;
    const text = message.text || '';
    if (options.stallFirst && text.includes('第1次')) return;
    if (text === LONG_STORY_PROMPT) {
      if (options.shortStory) {
        session.emit({ type: 'json', message: { type: 'tts', state: 'stop', is_aborted: false } });
        return;
      }
      clock.value += 10;
      session.emit({ type: 'audio' });
      clock.value += 10;
      session.emit({ type: 'audio' });
      return;
    }
    if (text === NEW_INPUT_PROMPT) {
      clock.value += 20;
      session.emit({ type: 'json', message: { type: 'tts', state: 'stop', is_aborted: false } });
      clock.value += 5;
      session.emit({ type: 'audio' });
      return;
    }
    if (text === SITUATION_QUESTION) {
      if (session.helloBrief.includes('probe.situation')) {
        session.mcpSeq += 1;
        clock.value += 10;
        session.emit({ type: 'json', message: { type: 'mcp', payload: { jsonrpc: '2.0', id: session.mcpSeq, method: 'tools/call', params: { name: 'probe.situation', arguments: {} } } } });
        return;
      }
      const replaced = message.agent_params?.custom_replace_prompt?.counter_brief;
      const fromReplace = Object.values(SITUATIONS).find(marker => replaced?.includes(marker));
      const fromHello = Object.values(SITUATIONS).find(marker => session.helloBrief.includes(marker));
      clock.value += 50;
      speak(session, clock, options.adoptListen && fromReplace ? fromReplace : fromHello || '不知道');
      return;
    }
    if (text === OPENING_TEXT) {
      clock.value += 15;
      session.emit({ type: 'json', message: { type: 'stt', text: options.echo ? text : '用户在说话' } });
      speak(session, clock, '好');
      return;
    }
    if (text === recallPrompt()) {
      clock.value += 60;
      const body = options.forgetContext ? '阿柿赞成' : '阿柿赞成，阿梨反对，阿枣弃权，阿桃跟票';
      speak(session, clock, body);
      return;
    }
    const member = CAST.find(item => text.includes(item.marker));
    if (member) {
      const extra = options.leak && member.marker === '阿梨反对' ? '。阿柿赞成' : '';
      clock.value += 45;
      speak(session, clock, `${member.marker}${extra}`);
      return;
    }
    clock.value += 45;
    speak(session, clock, '收到完毕');
  }
  return { now, openSession, sessions, clock };
}

function probeOptions(harness, extra = {}) {
  return {
    openSession: harness.openSession, now: harness.now, voices: VOICES, samples: 5, interruptSamples: 1,
    timingSamples: 2, reconnectSamples: 1, timeoutMs: 1000, tailMs: 0, holdMs: 0, sleep: async () => {},
    otaMs: 80, credentialSource: 'ota', live: false, secrets: ['probe-secret-token', '02:10:20:30:40:50'],
    ...extra,
  };
}

test('latency stats, redaction and protocol builders stay pure', () => {
  assert.deepEqual(summarizeLatencies([]), { count: 0, min: null, median: null, p90: null, max: null });
  assert.deepEqual(summarizeLatencies([10, Number.NaN, 30, Infinity]), { count: 2, min: 10, median: 20, p90: 30, max: 30 });
  assert.equal(percentileNearestRank([10, 20, 30, 40, 50], 90), 50);
  assert.equal(percentileNearestRank([], 90), null);
  assert.equal(judgeTarget(summarizeLatencies([100, 200, 1500])).meetsTarget, true);
  assert.equal(judgeTarget(summarizeLatencies([100, 1600])).meetsTarget, false);
  assert.equal(judgeTarget(summarizeLatencies([])).meetsTarget, null);
  const secret = 'probe-secret-token';
  const redacted = redactSecrets({
    token: secret, apiKey: 'k', voiceId: 'v-shi', latencyMs: 12, note: `Bearer ${secret} 02:10:20:30:40:50`,
    nested: ['eyJhbGciOi.eyJzdWIiOi.signatureX'],
  }, [secret]);
  assert.equal(redacted.token, '[redacted]');
  assert.equal(redacted.apiKey, '[redacted]');
  assert.equal(redacted.voiceId, 'v-shi');
  assert.equal(redacted.latencyMs, 12);
  assert.equal(redacted.note.includes(secret), false);
  assert.equal(redacted.note.includes('02:10:20:30:40:50'), false);
  assert.equal(redacted.nested[0], '[redacted]');
  const box = { ok: true }; box.self = box;
  assert.equal(redactSecrets(box).self, null);
  assert.equal(safeErrorMessage(Object.assign(new Error(`失败 ${secret}`), { code: 'TIMEOUT' })), '超时');
  assert.equal(buildHello().agent_params.custom_replace_prompt.counter_brief.includes('语音探针'), true);
  assert.equal(buildHello().features.mcp, false);
  assert.throws(() => buildHello({ promptKey: 'assistant_name' }), /assistant_name/);
  const detect = buildDetect({ text: '只说一句', voice: { id: ' voice-a ', speed: 1.1, pitch: 0.9, emotion: 'calm' }, promptReplace: { counter_brief: '新局势' } });
  assert.equal(detect.state, 'detect');
  assert.deepEqual(detect.agent_params.voice, { id: 'voice-a', speed: 1.1, pitch: 0.9, emotion: 'calm' });
  assert.equal(detect.agent_params.custom_replace_prompt.counter_brief, '新局势');
  assert.equal(detect.session_id, undefined);
  assert.throws(() => buildVoiceParams({ id: 'x', speed: 3 }), /语速/);
  assert.deepEqual(buildAbort(), { type: 'abort', reason: 'wake_word_detected' });
  for (const member of CAST) {
    assert.equal(castPrompt(member).includes(member.marker), true);
    for (const other of CAST) if (other !== member) assert.equal(castPrompt(member).includes(other.marker), false);
  }
  for (const member of CAST.filter(item => item.role !== 'host')) assert.equal(recallPrompt().includes(member.marker), false);
  assert.equal(SITUATION_QUESTION.includes(SITUATIONS.hello), false);
  assert.equal(situationBrief(SITUATIONS.hello).includes(SITUATIONS.hello), true);
  assert.equal(mcpInstruction(SITUATIONS.mcpFirst).includes(SITUATIONS.mcpFirst), true);
});

test('turn, interrupt, role and ASR judgments ignore out-of-window events', () => {
  const turn = createTurnState(100);
  reduceTurn(turn, { at: 90, type: 'audio' });
  reduceTurn(turn, { at: 120, type: 'audio' });
  reduceTurn(turn, { at: 130, type: 'json', message: { type: 'stt', text: '原话' } });
  reduceTurn(turn, { at: 140, type: 'json', message: { type: 'tts', state: 'sentence_start', text: '阿柿赞成' } });
  reduceTurn(turn, { at: 180, type: 'json', message: { type: 'tts', state: 'stop', is_aborted: false } });
  const done = finalizeTurn(turn);
  assert.equal(done.firstAudioMs, 20);
  assert.equal(done.endToEndMs, 80);
  assert.deepEqual(done.texts, ['阿柿赞成']);
  const armed = createInterruptState(200);
  reduceInterrupt(armed, { at: 190, type: 'audio' });
  reduceInterrupt(armed, { at: 230, type: 'audio' });
  reduceInterrupt(armed, { at: 250, type: 'json', message: { type: 'tts', state: 'stop', is_aborted: true } });
  reduceInterrupt(armed, { at: 260, type: 'audio' });
  const aborted = finalizeInterrupt(armed, { method: 'abort' });
  assert.equal(aborted.ok, false);
  assert.equal(aborted.latencyMs, 30);
  assert.equal(aborted.isAborted, true);
  assert.match(aborted.error, /仍有音频帧/);
  const follow = createInterruptState(200);
  reduceInterrupt(follow, { at: 220, type: 'json', message: { type: 'tts', state: 'stop', is_aborted: false } });
  reduceInterrupt(follow, { at: 240, type: 'audio' });
  assert.equal(finalizeInterrupt(follow, { method: 'new-input' }).ok, true);
  assert.equal(judgeRoleTurn({ texts: ['阿梨反对。阿柿赞成'], ownMarker: '阿梨反对', otherMarkers: ['阿柿赞成'] }).roleFidelity, false);
  assert.equal(judgeContextRecall({ texts: ['阿柿赞成，阿梨反对'], markers: ['阿柿赞成', '阿梨反对'] }).contextKept, true);
  assert.equal(judgeContextRecall({ texts: ['阿柿赞成'], markers: ['阿柿赞成', '阿梨反对'] }).missing.join(','), '阿梨反对');
  assert.equal(judgePromptUpdate({ heardNew: false, heardOld: true }), 'kept-hello');
  assert.equal(judgePromptUpdate({ heardNew: true, heardOld: false }), 'adopted-new');
  assert.equal(judgePromptUpdate({ heardNew: true, heardOld: true }), 'mixed');
  assert.equal(judgePromptUpdate({ heardNew: false, heardOld: false }), 'neither');
  assert.equal(judgeOpeningEcho({ openingText: OPENING_TEXT, sttTexts: [`前面${OPENING_TEXT}`] }).echoed, true);
  assert.equal(judgeOpeningEcho({ openingText: OPENING_TEXT, sttTexts: ['用户在说话'] }).echoed, false);
  assert.equal(describeAsrShape('明天三点见。').numberStyle, 'chinese');
  assert.equal(describeAsrShape('明天3点见。').numberStyle, 'arabic');
  assert.equal(describeAsrShape('三点，共3人').numberStyle, 'mixed');
  assert.equal(describeAsrShape('hello').hasPunctuation, false);
  assert.equal(describeAsrShape('3点').numberStyle, 'arabic');
  const pcm = wavWithPcm(Buffer.alloc(640, 1));
  assert.equal(loadPcmFrames(pcm).length, 1);
  assert.equal(loadPcmFrames(Buffer.alloc(1280, 1)).length, 2);
  assert.throws(() => loadPcmFrames(Buffer.alloc(10)), /太短/);
  assert.throws(() => loadPcmFrames(wavWithPcm(Buffer.alloc(640), { channels: 2 })), /单声道/);
  assert.throws(() => loadPcmFrames(wavWithPcm(Buffer.alloc(640), { rate: 8000 })), /16000/);
  const viable = assessPlanB({ contextKept: true, roleFidelity: true, turnsOk: true, latencyOk: true, concurrentAllowed: true, live: true });
  assert.equal(viable.required, false);
  assert.equal(viable.confirmedOnDevice, true);
  assert.match(viable.recommendation, /可以不启用 Plan B/);
  const slow = assessPlanB({ contextKept: true, roleFidelity: true, turnsOk: true, latencyOk: false, live: false });
  assert.equal(slow.required, true);
  assert.match(slow.recommendation, /非真机/);
  assert.match(slow.recommendation, /预先合成/);
  const refused = assessPlanB({ contextKept: false, roleFidelity: false, turnsOk: true, concurrentAllowed: false, live: true });
  assert.match(refused.recommendation, /独立设备号/);
  assert.equal(refused.prerender.name.includes('预先合成'), true);
  assert.equal(assessPlanB({}).inSessionViable, null);
});

test('MCP replies carry the current situation instruction', () => {
  const state = { instruction: mcpInstruction(SITUATIONS.mcpFirst), marker: SITUATIONS.mcpFirst, calls: 0, names: [] };
  assert.equal(probeMcpReply({ method: 'notifications/initialized' }), null);
  assert.equal(probeMcpReply({ id: 1, method: 'initialize' }).result.serverInfo.name, 'voice-probe');
  assert.equal(probeMcpReply({ id: 2, method: 'tools/list' }, state).result.tools.some(tool => tool.name === 'probe.situation'), true);
  const call = probeMcpReply({ id: 3, method: 'tools/call', params: { name: 'self.test.status' } }, state);
  assert.equal(JSON.parse(call.result.content[0].text).situation, SITUATIONS.mcpFirst);
  assert.deepEqual(state.names, ['self.test.status']);
  assert.equal(probeMcpReply({ id: 4, method: 'nope' }, state).error.code, -32601);
  const session = { mcpAttached: false, sent: [], subscribe(listener) { this.listener = listener; return () => {}; }, send: message => session.sent.push(message) };
  attachMcp(session, state);
  session.listener({ type: 'json', message: { type: 'mcp', payload: { id: 5, method: 'tools/call', params: { name: 'probe.situation' } } } });
  assert.equal(session.sent.length, 1);
  attachMcp(session, state);
  assert.equal(session.sent.length, 1);
});

test('mock socket stream measures voice, situation, interrupt and optional probes', async () => {
  const harness = createHarness({ echo: true });
  const report = await runVoiceProbe(probeOptions(harness, { asrWav: 'clip.wav', readFileImpl: async () => wavWithPcm(Buffer.alloc(640)) }));
  assert.equal(report.live, false);
  assert.equal(report.probes.firstAudio.ok, true);
  assert.deepEqual(report.probes.firstAudio.stats, { count: 5, min: 45, median: 45, p90: 45, max: 45 });
  assert.equal(report.probes.firstAudio.meetsTarget, true);
  assert.equal(report.probes.turnLatency.completeStats.p90, 55);
  assert.equal(report.probes.turnLatency.meetsTarget, true);
  assert.equal(report.probes.voiceSwitch.ok, true);
  assert.equal(report.probes.voiceSwitch.contextKept, true);
  assert.equal(report.probes.voiceSwitch.roleFidelity, true);
  assert.equal(report.probes.voiceSwitch.turns.length, 5);
  assert.deepEqual(report.probes.voiceSwitch.turns.map(turn => turn.voiceParams.emotion), ['calm', 'happy', 'sad', 'angry', 'neutral']);
  assert.equal(report.probes.voiceSwitch.turns[1].deltaFromPreviousMs, 0);
  const voiceSession = harness.sessions.find(session => session.purpose === 'voiceSwitch');
  const voiced = voiceSession.sent.filter(message => message.agent_params?.voice);
  assert.equal(voiced.length, 6);
  assert.equal(voiced[0].agent_params.voice.id, 'v-shi');
  assert.equal(voiced[0].state, 'detect');
  const situation = report.probes.situation;
  assert.equal(situation.ok, true);
  assert.equal(situation.trials.find(trial => trial.method === 'hello.custom_replace_prompt').heardMarker, true);
  assert.equal(situation.trials.find(trial => trial.method === 'listen.custom_replace_prompt').observation, 'kept-hello');
  const mcp = situation.trials.find(trial => trial.method === 'mcp-tool-instruction');
  assert.equal(mcp.updated, true);
  assert.equal(mcp.toolCalls >= 2, true);
  const reconnect = situation.trials.find(trial => trial.method === 'reconnect-hello');
  assert.equal(reconnect.samples[0].reconnectMs, 120);
  assert.equal(report.probes.interrupt.ok, true);
  assert.equal(report.probes.interrupt.groups['manual:abort'].samples[0].latencyMs, 25);
  assert.equal(report.probes.interrupt.groups['manual:abort'].samples[0].isAborted, true);
  assert.equal(report.probes.interrupt.groups['realtime:new-input'].samples[0].audioAfterStop, 1);
  assert.equal(report.probes.connectTiming.otaMs, 80);
  assert.equal(report.probes.connectTiming.stats.count, 2);
  assert.equal(report.probes.openingSttEcho.echoed, true);
  assert.equal(report.probes.asrShape.shape.numberStyle, 'chinese');
  assert.equal(report.probes.asrShape.transcript, '明天三点见');
  assert.equal(report.probes.concurrentSocket.allowed, true);
  assert.match(report.planB.recommendation, /非真机/);
  assert.equal(report.ok, true);
  assert.match(formatProbeReport(report), /p90=45/);
  assert.match(formatProbeReport(report), /1500/);
  assert.equal(JSON.stringify(report).includes('probe-secret-token'), false);
});

test('one section failing still records the others and strips secrets', async () => {
  const harness = createHarness({ failVoice: true, echo: false });
  const report = await runVoiceProbe(probeOptions(harness, { samples: 2, timeoutMs: 40, stallFirst: false }));
  assert.equal(report.probes.voiceSwitch.ok, false);
  assert.match(report.probes.voiceSwitch.error, /换音色失败/);
  assert.equal(report.probes.firstAudio.ok, true);
  assert.equal(report.probes.situation.ok, true);
  assert.equal(report.ok, false);
  assert.equal(JSON.stringify(report).includes('probe-secret-token'), false);
  assert.equal(JSON.stringify(report).includes('02:10:20:30:40:50'), false);
  const stalled = createHarness({ stallFirst: true });
  const partial = await runVoiceProbe(probeOptions(stalled, {
    sections: ['firstAudio', 'turnLatency'], samples: 2, timeoutMs: 30,
  }));
  assert.equal(partial.probes.firstAudio.samples[0].ok, false);
  assert.equal(partial.probes.firstAudio.samples[0].error, '超时');
  assert.equal(partial.probes.firstAudio.samples[1].ok, true);
  assert.equal(partial.probes.firstAudio.ok, false);
  const missing = await runVoiceProbe(probeOptions(createHarness(), { voices: ['only-one'], sections: ['voiceSwitch', 'firstAudio'], samples: 1 }));
  assert.match(missing.probes.voiceSwitch.error, /需要 5 个音色/);
  assert.equal(missing.probes.firstAudio.ok, true);
  const leaked = await runVoiceProbe(probeOptions(createHarness({ abortLeak: true, shortStory: false }), {
    sections: ['interrupt'], modes: ['manual'], interruptSamples: 1,
  }));
  assert.equal(leaked.probes.interrupt.groups['manual:abort'].ok, false);
  assert.match(leaked.probes.interrupt.groups['manual:abort'].error, /仍有音频帧/);
  const early = await runVoiceProbe(probeOptions(createHarness({ shortStory: true }), {
    sections: ['interrupt'], modes: ['realtime'], interruptSamples: 1,
  }));
  assert.match(early.probes.interrupt.error, /未进入播报就结束/);
  const adopted = await runVoiceProbe(probeOptions(createHarness({ adoptListen: true }), { sections: ['situation'] }));
  assert.equal(adopted.probes.situation.trials.find(trial => trial.method === 'listen.custom_replace_prompt').observation, 'adopted-new');
  const quiet = await runVoiceProbe(probeOptions(createHarness(), { sections: ['asrShape'] }));
  assert.equal(quiet.probes.asrShape.skipped, true);
  const refused = await runVoiceProbe(probeOptions(createHarness({ refuseSecond: true }), { sections: ['concurrentSocket'] }));
  assert.equal(refused.probes.concurrentSocket.allowed, false);
  assert.equal(refused.probes.concurrentSocket.ok, true);
  assert.equal(JSON.stringify(refused).includes('probe-secret-token'), false);
});

class FakeSocket extends EventEmitter {
  constructor() { super(); this.sent = []; this.readyState = 1; }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; this.emit('close'); }
}

test('probe socket handshake does not leak credentials', async () => {
  assert.throws(() => openLinxProbeSession({
    credentials: { url: 'wss://evil.test/v1/ws/', token: 'probe-secret-token' },
    config: { deviceId: 'd', clientId: 'c' }, hello: buildHello(), createSocket() { throw new Error('不应拨号'); },
  }), /未支持/);
  const clock = { value: 5000 };
  const sock = new FakeSocket();
  const pending = openLinxProbeSession({
    credentials: { url: 'ws://xrobo-io.qiniuapi.com/v1/ws/', token: 'probe-secret-token' },
    config: { deviceId: '02:10:20:30:40:50', clientId: 'client-secret-id' },
    hello: buildHello({ mcp: true }), createSocket: () => sock, timeoutMs: 1000, now: () => clock.value,
    mcpState: { instruction: mcpInstruction('灯塔五号'), marker: '灯塔五号', calls: 0, names: [] },
  });
  const hello = JSON.parse(sock.sent[0]);
  assert.equal(hello.type, 'hello');
  assert.equal(hello.features.mcp, true);
  clock.value = 5080;
  sock.emit('message', Buffer.from(JSON.stringify({ type: 'hello', session_id: 'sess-1', transport: 'websocket' })), false);
  const session = await pending;
  assert.equal(session.sessionId, 'sess-1');
  assert.equal(session.timing.helloMs, 80);
  const seen = [];
  session.subscribe(event => seen.push(event));
  sock.emit('message', Buffer.alloc(4), true);
  assert.equal(seen.at(-1).type, 'audio');
  assert.equal(seen.at(-1).bytes, 4);
  session.send({ type: 'listen', state: 'detect', text: 'hi' });
  assert.equal(JSON.parse(sock.sent.at(-1)).session_id, 'sess-1');
  sock.emit('message', Buffer.from(JSON.stringify({ type: 'mcp', payload: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'probe.situation' } } })), false);
  assert.equal(JSON.parse(JSON.parse(sock.sent.at(-1)).payload.result.content[0].text).situation, '灯塔五号');
  sock.emit('message', Buffer.from('{'), false);
  assert.equal(seen.some(event => event.type === 'error'), true);
  sock.emit('close');
  assert.equal(session.closed, true);
  const closed = new FakeSocket();
  closed.readyState = 0;
  const failing = openLinxProbeSession({
    credentials: { url: 'ws://xrobo-io.qiniuapi.com/v1/ws/', token: 'probe-secret-token' },
    config: { deviceId: '02:10:20:30:40:50', clientId: 'client-secret-id' },
    hello: buildHello(), createSocket: () => closed, timeoutMs: 1000, now: () => 1,
  });
  closed.emit('error', new Error('boom probe-secret-token 02:10:20:30:40:50'));
  await assert.rejects(failing, error => {
    assert.equal(error.message.includes('probe-secret-token'), false);
    assert.equal(error.message.includes('02:10:20:30:40:50'), false);
    return true;
  });
  await assert.rejects(openLinxProbeSession({
    credentials: { url: 'ws://xrobo-io.qiniuapi.com/v1/ws/', token: 'probe-secret-token' },
    config: { deviceId: 'd', clientId: 'c' }, hello: buildHello(), timeoutMs: 20, now: () => 1,
    createSocket: () => { const quiet = new FakeSocket(); quiet.readyState = 0; return quiet; },
  }), /握手超时/);
});

test('credentials come from env or device file and results omit them', async t => {
  assert.equal(credentialsFromEnv({}), null);
  await assert.rejects(loadProbeCredentials({ env: { LINX_WS_TOKEN: 'probe-secret-token' } }), error => {
    assert.equal(error.message.includes('probe-secret-token'), false);
    return true;
  });
  const fromEnv = await loadProbeCredentials({
    env: { LINX_WS_URL: 'wss://xrobo-io.qiniuapi.com/v1/ws/', LINX_WS_TOKEN: 'probe-secret-token', LINX_DEVICE_ID: 'dev', LINX_CLIENT_ID: 'cli' },
    fetcher: () => { throw new Error('不应请求 OTA'); },
  });
  assert.equal(fromEnv.source, 'env');
  assert.equal(fromEnv.otaMs, null);
  assert.deepEqual(resolveVoiceIds({ env: { LINX_VOICE_IDS: ' a, b ' }, config: { voiceIds: ['nope'] } }), ['a', 'b']);
  const dir = await mkdtemp(join(tmpdir(), 'probe-cred-'));
  try {
    const devicePath = join(dir, 'device.json');
    await writeFile(devicePath, JSON.stringify({ deviceId: '02:00:00:00:00:0A', clientId: 'cid', voiceIds: VOICES, apiKey: 'probe-api-key' }));
    let ticks = 100;
    const loaded = await loadProbeCredentials({
      env: {}, devicePath, now: () => { ticks += 25; return ticks; },
      fetcher: async (url, options) => {
        assert.match(url, /qiniuapi/);
        assert.equal(options.headers['Device-Id'], '02:00:00:00:00:0A');
        return { ok: true, json: async () => ({ websocket: { url: 'ws://xrobo-io.qiniuapi.com/v1/ws/', token: 'ota-token-value' } }) };
      },
    });
    assert.equal(loaded.source, 'ota');
    assert.equal(loaded.otaMs, 25);
    assert.deepEqual(resolveVoiceIds({ env: {}, config: loaded.config }), VOICES);
    await assert.rejects(loadProbeCredentials({
      env: {}, devicePath, fetcher: async () => ({ ok: true, json: async () => ({ activation: { code: '654321' } }) }),
    }), error => {
      assert.match(error.message, /未绑定/);
      assert.equal(error.message.includes('654321'), false);
      return true;
    });
    await assert.rejects(loadProbeCredentials({ env: {}, devicePath, fetcher: async () => ({ ok: false, status: 503 }) }), /503/);
    const out = join(dir, 'out');
    const harness = createHarness();
    const report = await runVoiceProbe(probeOptions(harness, { samples: 1, timingSamples: 1, sections: ['connectTiming', 'firstAudio', 'turnLatency', 'voiceSwitch', 'situation', 'interrupt', 'openingSttEcho', 'asrShape', 'concurrentSocket'] }));
    const file = await writeProbeReport(out, report);
    const saved = await readFile(file, 'utf8');
    assert.equal(saved.includes('probe-secret-token'), false);
    assert.equal(saved.includes('probe-api-key'), false);
    await t.test('report permissions exclude group and others on POSIX', {
      skip: process.platform === 'win32' ? 'Windows 不提供 POSIX 权限位语义；Linux CI 执行此检查' : false,
    }, async () => {
      assert.equal((await stat(file)).mode & 0o077, 0);
    });
    assert.throws(() => parseArgs(['--nope']), /未知参数/);
    assert.throws(() => parseArgs(['--samples', '0']), /samples/);
    assert.equal(parseArgs(['--voices', 'a,b', '--skip', 'asrShape']).skip[0], 'asrShape');
    const logs = [];
    assert.equal(await main(['--help'], { log: line => logs.push(line), error() {} }), 0);
    assert.match(logs.join('\n'), /probe:voice/);
    let loadedByMain = false;
    const output = [];
    const code = await main(['--out', out, '--samples', '1', '--interrupt-samples', '1', '--timing-samples', '1', '--hold-ms', '0', '--voices', VOICES.join(',')], {
      log: line => output.push(line), error: line => output.push(line),
    }, {
      env: { LINX_API_KEY: 'probe-api-key' }, now: harness.now, tailMs: 0, sleep: async () => {},
      loadProbeCredentials: async () => {
        loadedByMain = true;
        return { config: { deviceId: '02:10:20:30:40:50', clientId: 'client-secret-id', apiKey: 'probe-api-key', voiceIds: VOICES }, credentials: { url: 'ws://xrobo-io.qiniuapi.com/v1/ws/', token: 'probe-secret-token' }, source: 'env', otaMs: null };
      },
      openLinxProbeSession: spec => harness.openSession({ purpose: spec.hello.agent_params.custom_replace_prompt.counter_brief.includes(SITUATIONS.reconnect) ? 'situation-reconnect' : spec.purpose, hello: spec.hello, mcpState: spec.mcpState }),
    });
    assert.equal(loadedByMain, true);
    assert.equal(code, 0, output.join('\n'));
    const names = await readdir(out);
    assert.equal(names.length > 0, true);
    for (const name of names) {
      const saved = await readFile(join(out, name), 'utf8');
      assert.equal(saved.includes('probe-secret-token'), false);
      assert.equal(saved.includes('probe-api-key'), false);
      assert.equal(saved.includes('02:10:20:30:40:50'), false);
      assert.equal(saved.includes('client-secret-id'), false);
    }
  } finally { await rm(dir, { recursive: true }); }
});
