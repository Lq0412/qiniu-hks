import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMixinLink } from '../mixin-link.mjs';
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

function installFake({ hangAccuse = false, empty = false } = {}) {
  const sockets = [];
  const detects = [];
  const fake = { sockets, detects, aborts: 0, hanging: false, armed: false, failNext: false };
  fake.createSocket = () => {
    const socket = new EventEmitter();
    sockets.push(socket);
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
        const accuse = hangAccuse && !fake.armed && message.text.includes('【台词】') && message.text.includes('「');
        if (accuse) {
          fake.armed = true;
          fake.hanging = true;
          return;
        }
        setImmediate(() => {
          if (socket.readyState !== 1) return;
          if (fake.failNext) {
            fake.failNext = false;
            socket.close();
            return;
          }
          send({ type: 'stt', text: message.text });
          send({ type: 'tts', state: 'start' });
          send({ type: 'tts', state: 'sentence_start', text: '收到' });
          if (!empty) socket.emit('message', Buffer.alloc(640, 1), true);
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

test('a dropped socket reconnects once, and a line with no audio still keeps the script', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'live-drop-'));
  const fake = installFake({ empty: true });
  fake.failNext = true;
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
    const started = await post(`/api/mixin/${id}/start`, {}, cookie);
    const startBody = await started.json();
    assert.equal(started.status, 200, JSON.stringify(startBody));
    assert.equal(startBody.game.phase, 'intro');
    assert.equal(startBody.game.generation, 1);
    assert.equal(fake.sockets.length, 2);
    fake.failNext = true;
    const stepped = await post(`/api/mixin/${id}/step`, {}, cookie);
    const stepBody = await stepped.json();
    assert.equal(stepped.status, 200, JSON.stringify(stepBody));
    assert.equal(stepBody.audioUrl ?? null, null);
    assert.equal(stepBody.game.dialogue.at(-1).text, openingLine('模型年会', '碳基-7B'));
    assert.equal(fake.sockets.length, 2);
    assert.equal(opened(), 1);
    assert.equal(stepBody.game.generation, 1);
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

test('the voice command names the page, the env, and typed speech', async () => {
  const logs = [];
  let seen = null;
  const started = await startVoiceServer({
    env: {
      LINX_DEVICE_JSON: JSON.stringify({ deviceId: '02:10:20:30:40:50', clientId: 'client-test' }),
      LINX_API_KEY: 'hidden-key',
    },
    readFile: missingFile,
    log: line => logs.push(line),
    port: 0,
    resolve: async () => ({
      source: 'env',
      config: { deviceId: 'd', clientId: 'c' },
      credentials: { url: 'wss://xrobo-io.qiniuapi.com/v1/ws/', token: TOKEN },
    }),
    makeApp(options) {
      seen = options;
      return {
        once() {},
        listen(_port, _host, callback) { callback(); },
        address() { return { port: 4321 }; },
        close() {},
      };
    },
  });
  assert.equal(started.mode, 'voice');
  assert.equal(seen.mixinCredentials.credentials.token, TOKEN);
  const printed = logs.join('\n');
  assert.match(printed, /语音版：http:\/\/127\.0\.0\.1:4321\/mixin/);
  assert.match(printed, /打字/);
  assert.match(printed, /LINX_DEVICE_JSON/);
  assert.match(printed, /90 秒/);
  assert.equal(printed.includes(TOKEN), false);
  assert.equal(printed.includes('hidden-key'), false);
});
