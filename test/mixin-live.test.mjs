import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createAudioLane } from '../mixin-lane.mjs';
import { createMixinLink } from '../mixin-link.mjs';
import { createVoiceSession } from '../mixin-live.mjs';
import { HOST_REVEAL_BRIDGE, HOST_RULES, openingLine } from '../mixin-prompts.mjs';
import { createApp } from '../server.mjs';
import { startVoiceServer } from '../scripts/play-voice.mjs';

const TOKEN = 'secret-token';
const ROUNDS = ['感谢老板，算力减半，我的废话也会减半。', '我昨天加班到十点，嗯，我妈也说好烦。'];
const DEFENSE = '气死了，我昨天就是加班。';
const INTERRUPT = '我那是在跑批处理，凭什么这么说！';

function missingFile() {
  const error = new Error('missing');
  error.code = 'ENOENT';
  throw error;
}

function installFake({ hangAccuse = false, failReconnect = false, stallDetects = 0, onDetect } = {}) {
  const sockets = [];
  const detects = [];
  const fake = { sockets, detects, aborts: 0, hanging: false, armed: false, stallLeft: stallDetects };
  fake.createSocket = () => {
    const socket = new EventEmitter();
    sockets.push(socket);
    const failHandshake = failReconnect && sockets.length > 1;
    socket.readyState = 0;
    socket.sent = [];
    const send = obj => socket.emit('message', Buffer.from(JSON.stringify(obj)));
    socket.send = (data, options) => {
      socket.sent.push({ data, options });
      if (options?.binary) return;
      const message = JSON.parse(data.toString());
      if (message.type === 'hello') {
        queueMicrotask(() => {
          if (socket.readyState !== 1) return;
          send({ type: 'hello', session_id: `s${sockets.length}`, audio_params: { format: 'pcm', sample_rate: 16000, channels: 1 } });
        });
      }
      if (message.type === 'abort') {
        fake.aborts += 1;
        if (!fake.hanging) return;
        fake.hanging = false;
        send({ type: 'tts', state: 'stop', is_aborted: true });
      }
      if (message.type === 'listen' && message.state === 'detect') {
        detects.push(message);
        if (onDetect?.({ message, socket, send, index: detects.length })) return;
        if (fake.stallLeft > 0) {
          fake.stallLeft -= 1;
          return;
        }
        if (failReconnect) {
          socket.close();
          return;
        }
        const accuse = hangAccuse && !fake.armed && message.text.includes('【台词】') && message.text.includes('「');
        if (accuse) {
          fake.armed = true;
          fake.hanging = true;
          return;
        }
        setImmediate(() => {
          if (socket.readyState !== 1) return;
          send({ type: 'stt', text: message.text });
          send({ type: 'tts', state: 'start' });
          send({ type: 'tts', state: 'sentence_start', text: '收到' });
          socket.emit('message', Buffer.alloc(640, 1), true);
          send({ type: 'tts', state: 'stop' });
        });
      }
    };
    socket.close = () => {
      if (socket.readyState === 3) return;
      socket.readyState = 3;
      socket.emit('close');
    };
    queueMicrotask(() => {
      if (socket.readyState === 3) return;
      if (failHandshake) {
        socket.emit('error', new Error('重连失败'));
        return;
      }
      socket.readyState = 1;
      socket.emit('open');
    });
    return socket;
  };
  return fake;
}

async function waitFor(check) {
  for (let i = 0; i < 80; i += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('等待条件超时');
}

function voiceApp(dir, fake, extra = {}) {
  let opened = 0;
  const server = createApp({
    audioDir: dir,
    log() {},
    mixinCredentials: {
      config: { deviceId: '02:10:20:30:40:50', clientId: 'client-test' },
      credentials: { url: 'wss://xrobo-io.qiniuapi.com/v1/ws/', token: TOKEN },
    },
    openAudioLink() {
      opened += 1;
      return createMixinLink({
        config: { deviceId: '02:10:20:30:40:50', clientId: 'client-test' },
        credentials: { url: 'wss://xrobo-io.qiniuapi.com/v1/ws/', token: TOKEN },
        createSocket: fake.createSocket,
        handshakeMs: 1000,
      });
    },
    ...extra,
  });
  return { server, opened: () => opened };
}

test('one socket plays a demo, reuses presynth, and the page can fetch each wav', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'live-'));
  const fake = installFake({ hangAccuse: true });
  const { server, opened } = voiceApp(dir, fake);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await waitFor(() => server.audioLane.mode === 'idle');
    assert.equal(opened(), 1);
    assert.equal(fake.sockets.length, 1);
    assert.equal((await fetch(`${base}/mixin`)).status, 200);
    const sfx = await fetch(`${base}/mixin/audio/reveal-sfx.wav`);
    assert.equal(sfx.status, 200);
    assert.equal(sfx.headers.get('content-type'), 'audio/wav');
    assert.equal(Buffer.from(await sfx.arrayBuffer()).subarray(0, 4).toString(), 'RIFF');
    assert.equal((await fetch(`${base}/mixin/audio/../package.json`)).status, 404);
    assert.equal((await fetch(`${base}/mixin/audio/..%2Fpackage.json`)).status, 404);
    assert.equal((await fetch(`${base}/mixin/audio/.env`)).status, 404);
    const post = (url, body, cookie = '') => fetch(`${base}${url}`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body ?? {}),
    });
    const created = await post('/api/mixin', { demo: true, seed: 1 });
    assert.equal(created.status, 201);
    const cookie = created.headers.get('set-cookie').split(';')[0];
    const { id } = await created.json();
    const act = async (action, body) => {
      const response = await post(`/api/mixin/${id}/${action}`, body, cookie);
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify({ error: data.error, phase: data.game?.phase }));
      assert.equal(JSON.stringify(data).includes(TOKEN), false);
      return data;
    };
    let state = (await act('start')).game;
    assert.equal(state.mode, 'live');
    assert.equal(state.generation, 1);
    const urls = [];
    let interruptDone = false;
    for (let steps = 0; steps < 120 && state.phase !== 'result'; steps += 1) {
      if (state.phase === 'round_player') {
        state = (await act('text', { text: ROUNDS[state.round - 1], typed: true })).game;
        state = (await act('confirm', { revision: state.pending.revision })).game;
        continue;
      }
      if (state.phase === 'defense') {
        state = (await act('text', { text: DEFENSE })).game;
        state = (await act('vote', { seat: 4 })).game;
        state = (await act('confirm', { revision: state.pending.revision })).game;
        continue;
      }
      if (state.phase === 'accuse' && !interruptDone && state.cue?.kind === 'accuse') {
        const stepping = act('step');
        await waitFor(() => fake.hanging);
        const interrupted = await act('interrupt', { text: INTERRUPT });
        const stepped = await stepping;
        assert.equal(stepped.audioUrl ?? null, null);
        interruptDone = true;
        state = interrupted.game;
        continue;
      }
      if (state.cue) {
        const data = await act('step');
        if (data.audioUrl) {
          assert.equal(data.clip.url, data.audioUrl);
          urls.push(data.audioUrl);
        }
        state = data.game;
        continue;
      }
      state = (await act('tick', { ms: 1000 })).game;
    }
    assert.equal(state.phase, 'result');
    assert.equal(interruptDone, true);
    assert.equal(opened(), 1);
    assert.equal(fake.sockets.length, 1);
    assert.ok(fake.aborts >= 1);
    assert.equal(state.generation, 1);
    assert.equal(typeof state.report.quote, 'string');
    assert.ok(state.dialogue.some(line => line.text === openingLine('模型年会', '碳基-7B')));
    assert.ok(state.dialogue.some(line => line.text === HOST_RULES));
    assert.ok(state.dialogue.some(line => line.text === '收到'));
    assert.ok(state.dialogue.some(line => line.text === INTERRUPT));
    const reveal = urls.find(url => url.includes('reveal=1'));
    assert.ok(reveal);
    assert.equal(urls.some(url => url.includes(HOST_REVEAL_BRIDGE)), false);
    const wav = await fetch(`${base}${reveal}`, { headers: { cookie } });
    assert.equal(wav.headers.get('content-type'), 'audio/wav');
    const bytes = Buffer.from(await wav.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
    assert.equal((await fetch(`${base}${reveal.split('?')[0]}`)).status, 409);
    const voices = new Set(fake.detects.map(item => item.agent_params.voice.id));
    assert.ok(voices.size >= 2);
    assert.ok(fake.detects.every(item => item.agent_params.custom_replace_prompt == null));
    assert.equal(fake.detects.every(item => typeof item.agent_params.voice.id === 'string'), true);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed reconnect still lets the demo reach the reveal', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'live-reconnect-'));
  const fake = installFake({ failReconnect: true });
  const { server, opened } = voiceApp(dir, fake, { presynthCatalog: [] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await waitFor(() => server.audioLane.mode === 'idle');
    const post = (url, body, cookie = '') => fetch(`${base}${url}`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body ?? {}),
    });
    const created = await post('/api/mixin', { demo: true, seed: 1 });
    const cookie = created.headers.get('set-cookie').split(';')[0];
    const { id } = await created.json();
    const act = async (action, body) => {
      const response = await post(`/api/mixin/${id}/${action}`, body, cookie);
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify({ error: data.error, phase: data.game?.phase }));
      return data;
    };
    let state = (await act('start')).game;
    for (let steps = 0; steps < 120 && state.phase !== 'result'; steps += 1) {
      if (state.phase === 'round_player') {
        state = (await act('text', { text: ROUNDS[state.round - 1], typed: true })).game;
        state = (await act('confirm', { revision: state.pending.revision })).game;
        continue;
      }
      if (state.phase === 'defense') {
        state = (await act('text', { text: DEFENSE })).game;
        state = (await act('vote', { seat: 4 })).game;
        state = (await act('confirm', { revision: state.pending.revision })).game;
        continue;
      }
      if (state.cue) {
        state = (await act('step')).game;
        continue;
      }
      state = (await act('tick', { ms: 1000 })).game;
    }
    assert.equal(state.phase, 'result');
    assert.equal(state.generation, 1);
    assert.equal(typeof state.report.quote, 'string');
    assert.equal(opened(), 1);
    assert.equal(fake.sockets.length, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('a detect that never stops still lets the next line speak', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'live-stall-'));
  const fake = installFake({ stallDetects: 1 });
  let opened = 0;
  const lane = createAudioLane({
    dir,
    catalog: [],
    log() {},
    openLink() {
      opened += 1;
      return createMixinLink({
        config: { deviceId: '02:10:20:30:40:50', clientId: 'client-test' },
        credentials: { url: 'wss://xrobo-io.qiniuapi.com/v1/ws/', token: TOKEN },
        createSocket: fake.createSocket,
        handshakeMs: 1000,
        settleMs: 10,
      });
    },
  });
  lane.warmupBackground();
  try {
    await waitFor(() => lane.mode === 'idle');
    const session = createVoiceSession({
      options: { demo: true, seed: 1 },
      lane,
      audioDir: dir,
      timeoutMs: 80,
    });
    await session.start();
    const stepped = await session.step();
    assert.equal(opened, 1);
    assert.equal(fake.sockets.length, 1);
    assert.ok(fake.aborts >= 1);
    assert.ok(fake.detects.length >= 2);
    assert.equal(stepped.clipWav?.subarray(0, 4).toString(), 'RIFF');
  } finally {
    lane.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('voice mode rejects the legacy voice socket', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'live-legacy-'));
  const fake = installFake();
  let voiceOpens = 0;
  const { server } = voiceApp(dir, fake, {
    presynthCatalog: [],
    loadConfig: async () => ({}),
    getOta: async () => ({ websocket: { url: 'wss://xrobo-io.qiniuapi.com/v1/ws/', token: 'ticket-token' } }),
    openVoice() { voiceOpens += 1; return { close() {} }; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await waitFor(() => server.audioLane.mode === 'idle');
    const start = await fetch(`${base}/api/game`, { method: 'POST', headers: { origin: base } });
    const cookie = start.headers.get('set-cookie').split(';')[0];
    const ticket = await (await fetch(`${base}/api/connect`, {
      method: 'POST',
      headers: { origin: base, cookie },
    })).json();
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http:', 'ws:')}/voice?ticket=${ticket.ticket}`, { headers: { origin: base, cookie } });
      const timer = setTimeout(() => reject(new Error('旧语音连接没有被拒绝')), 1000);
      ws.on('error', () => { clearTimeout(timer); resolve(); });
      ws.on('open', () => { clearTimeout(timer); reject(new Error('旧语音连接不该打开')); });
    });
    assert.equal(voiceOpens, 0);
    assert.equal(fake.sockets.length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('play:voice without credentials stays on the text page', async () => {
  const logs = [];
  const started = await startVoiceServer({
    env: { LINX_DEVICE_JSON: '', LINX_API_KEY: 'hidden-key', LINX_WS_URL: '', LINX_WS_TOKEN: '', LINX_DEVICE_ID: '', LINX_CLIENT_ID: '' },
    readFile: missingFile,
    log: line => logs.push(line),
    port: 0,
  });
  try {
    assert.equal(started.mode, 'text');
    assert.equal(started.server.audioLane, null);
    const page = await fetch(`http://127.0.0.1:${started.port}/mixin`);
    assert.equal(page.status, 200);
    assert.match(logs.join('\n'), /文字版：http:\/\/127\.0\.0\.1:\d+\/mixin/);
    assert.match(logs.join('\n'), /打字/);
    assert.equal(logs.join('\n').includes('hidden-key'), false);
  } finally {
    await new Promise(resolve => started.server.close(resolve));
  }
});

async function liveFixture(onDetect, extra = {}) {
  const fake = installFake({ onDetect });
  const link = createMixinLink({
    config: { deviceId: 'fake-device', clientId: 'fake-client' },
    credentials: { url: 'wss://xrobo-io.qiniuapi.com/v1/ws/', token: 'fake-token' },
    createSocket: fake.createSocket,
    settleMs: 50,
  });
  await link.connect();
  const session = createVoiceSession({
    options: { demo: true, seed: 1 },
    lane: { async acquireForGame() { return link; }, releaseGame() {} },
    timeoutMs: 100,
    ...extra,
  });
  await session.start();
  return { session, fake, link };
}

function replyAudio({ socket, send }, value = 2) {
  send({ type: 'tts', state: 'sentence_start', text: '测试台词' });
  socket.emit('message', Buffer.alloc(640, value), true);
  send({ type: 'tts', state: 'stop' });
}

test('一个 cue 超时后，下一 cue 排空旧帧并拿到自己的 WAV', async () => {
  const f = await liveFixture(request => {
    if (request.index === 2) {
      setTimeout(() => replyAudio(request, 9), 110);
      return true;
    }
    if (request.index === 3) {
      setTimeout(() => replyAudio(request, 3), 30);
      return true;
    }
  }, { timeoutMs: 80 });
  try {
    assert.equal((await f.session.step()).clipWav, null);
    const next = await f.session.step();
    assert.ok(next.clipWav?.length > 44);
    assert.deepEqual(next.clipWav.subarray(44), Buffer.alloc(640, 3));
  } finally { f.link.close(); }
});

for (const scenario of [
  { name: '过渡超时后结局仍出音频', bridgeDelay: null, endingDelay: 0, expected: [3] },
  { name: '两段独立计时，总耗时可超过单段上限', bridgeDelay: 100, endingDelay: 100, timeoutMs: 160, expected: [2, 3] },
  { name: '结局使用单独的 revealTimeoutMs', bridgeDelay: 0, endingDelay: 140, timeoutMs: 80, revealTimeoutMs: 240, expected: [2, 3] },
  { name: '结局失败仍保留过渡音频', bridgeDelay: 0, endingDelay: null, expected: [2] },
]) {
  test(`揭晓：${scenario.name}`, async () => {
    const f = await liveFixture(request => {
      if (request.index === 1) return;
      const delay = request.index === 2 ? scenario.bridgeDelay : scenario.endingDelay;
      if (delay !== null) setTimeout(() => replyAudio(request, request.index), delay);
      return true;
    }, {
      timeoutMs: scenario.timeoutMs ?? 100,
      ...(scenario.revealTimeoutMs ? { revealTimeoutMs: scenario.revealTimeoutMs } : {}),
    });
    try {
      // 复用开局 cue 的身份，仅把待合成内容设成揭晓，避免完整对局影响计时断言。
      f.session.game.cue.kind = 'reveal';
      f.session.game.cue.line = '测试结局';
      const began = performance.now();
      const result = await f.session.step();
      assert.equal(result.reveal, true);
      // 揭晓用的是伪装的开局 cue，落地后会立即预取下一句。
      await waitFor(() => f.fake.detects.length === 4);
      assert.deepEqual(result.clipWav.subarray(44), Buffer.concat(scenario.expected.map(value => Buffer.alloc(640, value))));
      if (scenario.bridgeDelay === 100) assert.ok(performance.now() - began > scenario.timeoutMs);
    } finally { f.link.close(); }
  });
}


test('下一句在播放期间预取，复用正确声线和 WAV，落地使用 step 的时间', async () => {
  const f = await liveFixture(request => {
    if (request.index === 1) return;
    setTimeout(() => replyAudio(request, request.index), 150);
    return true;
  }, { timeoutMs: 500 });
  try {
    await f.session.step();
    const cue = f.session.game.cue;
    const instruction = cue.instruction;
    await waitFor(() => f.fake.detects.length === 3);
    assert.equal(f.fake.detects[2].text, instruction);
    assert.equal(f.fake.detects[2].agent_params.voice.id, cue.voice.voiceId);
    const lines = f.session.game.lines.length;
    await new Promise(resolve => setTimeout(resolve, 180));
    assert.equal(f.session.game.lines.length, lines);
    f.session.setNow(1234);
    const began = performance.now();
    const result = await f.session.step();
    assert.ok(performance.now() - began < 50);
    assert.equal(result.clipWav.subarray(0, 4).toString(), 'RIFF');
    assert.deepEqual(result.clipWav.subarray(44), Buffer.alloc(640, 3));
    assert.equal(f.session.game.lines.at(-1).at, 1234);
    assert.equal(f.session.game.lines.at(-1).voiceUsed, cue.voice.voiceId);
    assert.equal(f.fake.detects.filter(item => item.text === instruction).length, 1);
  } finally { f.session.tick(1_000_000); f.link.close(); }
});

test('tick 改变 cue 后取消预取，新 cue 不会复用旧音频', async () => {
  const f = await liveFixture(request => {
    if (request.index === 3) return true;
    if (request.index > 3) { replyAudio(request, 7); return true; }
  });
  try {
    await f.session.step();
    await waitFor(() => f.fake.detects.length === 3);
    const oldCue = f.session.game.cue;
    f.session.tickTo(oldCue.deadlineAt);
    const cue = f.session.game.cue;
    assert.ok(cue);
    assert.notEqual(cue.cueId, oldCue.cueId);
    assert.ok(f.fake.aborts >= 1);
    const result = await f.session.step();
    assert.equal(f.fake.detects[3].text, cue.instruction);
    assert.equal(f.fake.detects[3].agent_params.voice.id, cue.voice.voiceId);
    assert.deepEqual(result.clipWav.subarray(44), Buffer.alloc(640, 7));
  } finally { f.session.tick(1_000_000); f.link.close(); }
});

test('预取超时只留字幕，没有未处理 rejection', async () => {
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  const f = await liveFixture(request => request.index === 3);
  try {
    await f.session.step();
    await waitFor(() => f.fake.detects.length === 3);
    await new Promise(resolve => setTimeout(resolve, 140));
    const result = await f.session.step();
    assert.equal(result.fulfilled, true);
    assert.equal(result.clipWav, null);
    assert.ok(result.view.dialogue.at(-1).text);
    assert.deepEqual(unhandled, []);
  } finally {
    f.session.tick(1_000_000);
    f.link.close();
    process.off('unhandledRejection', onUnhandled);
  }
});

test('整局到 result 后释放通道，不再 detect，重开不会复用旧预取', async () => {
  let released = 0;
  const f = await liveFixture();
  try {
    // 使用原通道并记录真正结局的释放时机。
    const session = createVoiceSession({
      options: { demo: true, seed: 1 },
      lane: { async acquireForGame() { return f.link; }, releaseGame() { released += 1; } },
    });
    await session.start();
    for (let i = 0; i < 120 && session.game.phase !== 'result'; i += 1) {
      if (session.game.cue) await session.step();
      else session.tick(30_000);
    }
    assert.equal(session.game.phase, 'result');
    assert.ok(released >= 1);
    const count = f.fake.detects.length;
    await session.step();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.fake.detects.length, count);
    session.restart();
    await session.start();
    assert.equal((await session.step()).fulfilled, true);
    session.tick(1_000_000);
  } finally { f.link.close(); }
});


test('即兴 answer 在 shiftCue 定稿后预取，step 使用相同 instruction', async () => {
  const f = await liveFixture();
  try {
    for (let i = 0; i < 15; i += 1) {
      await f.session.step();
      const cue = f.session.game.cue;
      if (cue?.kind !== 'answer' || cue.spoken === '还没有') continue;
      const instruction = cue.instruction;
      const count = f.fake.detects.length;
      assert.equal(f.fake.detects.at(-1).text, instruction);
      assert.equal(f.fake.detects.at(-1).agent_params.voice.id, cue.voice.voiceId);
      assert.ok(cue.spoken);
      await f.session.step();
      assert.equal(f.fake.detects.slice(0, count).filter(item => item.text === instruction).length, 1);
      assert.equal(cue.instruction, instruction);
      return;
    }
    assert.fail('没有走到带已发言上下文的即兴句');
  } finally { f.session.tick(1_000_000); f.link.close(); }
});
