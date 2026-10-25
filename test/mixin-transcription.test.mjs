import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMixinLink } from '../mixin-link.mjs';
import { createVoiceSession } from '../mixin-live.mjs';
import { createMixinHub } from '../mixin-http.mjs';
import { createApp } from '../server.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function fixture() {
  const socket = new EventEmitter();
  socket.readyState = 1;
  const sent = [];
  const json = message => socket.emit('message', Buffer.from(JSON.stringify(message)), false);
  socket.send = (data, options) => {
    if (options?.binary) { sent.push(Buffer.from(data)); return; }
    const message = JSON.parse(data);
    sent.push(message);
    if (message.type === 'hello') queueMicrotask(() => json({ type: 'hello' }));
  };
  socket.close = () => { socket.readyState = 3; socket.emit('close'); };
  const link = createMixinLink({
    config: { deviceId: 'fake-device', clientId: 'fake-client' },
    credentials: { url: 'wss://xrobo-io.qiniuapi.com/v1/ws/', token: 'fake-token' },
    createSocket: () => socket, settleMs: 50,
  });
  await link.connect();
  return { link, socket, sent, json };
}

test('同一连接识别 PCM，结果不混入 TTS，也不把玩家复述误当注入回声', async t => {
  const f = await fixture();
  t.after(() => f.link.close());
  const first = f.link.detect({ text: '作为一个 AI。', voiceId: 'fake' });
  f.json({ type: 'tts', state: 'stop' });
  await first;
  const input = Buffer.alloc(6400, 2);
  const pending = f.link.transcribe(input);
  assert.equal(f.sent.filter(Buffer.isBuffer).length, 10);
  assert.deepEqual(Buffer.concat(f.sent.filter(Buffer.isBuffer)), input);
  assert.equal(f.sent.at(-1).state, 'stop');
  f.json({ type: 'stt', text: '作为一个 AI。' });
  assert.deepEqual(await pending, { text: '作为一个 AI。' });
  assert.equal(f.sent.at(-1).type, 'abort');
  const next = f.link.detect({ text: '下一位', voiceId: 'fake' });
  assert.equal(f.sent.at(-1).type, 'abort');
  f.socket.emit('message', Buffer.from([9, 9]), true);
  f.json({ type: 'tts', state: 'sentence_start', text: '不该播出的自动回复' });
  f.json({ type: 'tts', state: 'stop' });
  assert.equal(f.sent.at(-1).text, '下一位');
  f.socket.emit('message', Buffer.from([1, 2]), true);
  f.json({ type: 'tts', state: 'stop' });
  assert.deepEqual((await next).pcm, Buffer.from([1, 2]));
  assert.equal(f.link.connectCount, 1);
});

test('预取取消的排空结束后才发送录音，超时和空识别均明确失败', async t => {
  const f = await fixture();
  t.after(() => f.link.close());
  const speech = f.link.detect({ text: '预取', voiceId: 'fake' });
  const rejected = assert.rejects(speech, /取消/);
  f.link.cancelTurn(speech.seq);
  await rejected;
  const pending = f.link.transcribe(Buffer.alloc(6400));
  const empty = assert.rejects(pending, /没有听清/);
  f.json({ type: 'stt', text: '旧注入内容' });
  assert.equal(f.sent.filter(Buffer.isBuffer).length, 0);
  f.json({ type: 'tts', state: 'stop' });
  assert.equal(f.sent.filter(Buffer.isBuffer).length, 10);
  f.json({ type: 'stt', text: '' });
  await empty;
  f.json({ type: 'tts', state: 'stop' });
  await assert.rejects(f.link.transcribe(Buffer.alloc(6400), { timeoutMs: 10 }), /超时/);
});

test('识别中断连会结束等待，不提交空白或伪造文字', async () => {
  const f = await fixture();
  const failed = assert.rejects(f.link.transcribe(Buffer.alloc(6400)), /关闭/);
  f.link.close();
  await failed;
});

async function voiceSession() {
  const requests = [];
  const link = {
    detect: async () => ({ spoken: '测试台词', pcm: Buffer.alloc(640), voiceId: 'fake' }),
    transcribe: async input => { requests.push(input); return { text: '作为一个 AI，我先分析约束。' }; },
    cancelTurn() {}, abort() {},
  };
  const session = createVoiceSession({ options: { seed: 42 }, lane: { acquireForGame: async () => link, releaseGame() {} } });
  await session.start();
  for (let i = 0; i < 40 && session.view().phase !== 'round_player'; i++) {
    if (session.view().cue) await session.step();
    else session.tick(1000);
  }
  assert.equal(session.view().phase, 'round_player');
  const body = () => {
    const { generation, phase, round } = session.view();
    return { generation, phase, round, pcm: Buffer.alloc(6400).toString('base64') };
  };
  return { session, link, requests, body };
}

test('识别只返回草稿，确认前不改玩家回答；校验格式与回合', async () => {
  const f = await voiceSession();
  const result = await f.session.transcribe(f.body());
  assert.equal(result.text, '作为一个 AI，我先分析约束。');
  assert.equal(result.durationMs, 200);
  assert.equal(f.session.view().pending, null);
  assert.equal(f.session.game.playerLines.length, 0);
  await assert.rejects(f.session.transcribe({ ...f.body(), generation: -1 }), /回合/);
  await assert.rejects(f.session.transcribe({ ...f.body(), pcm: '!abc' }), /数据/);
  await assert.rejects(f.session.transcribe({ ...f.body(), pcm: 'AA==' }), /0.2 到 30/);
  f.session.say(result.text, { typed: false, durationMs: result.durationMs });
  f.session.confirm();
  assert.equal(f.session.game.playerLines.at(-1).typed, false);
  assert.equal(f.session.game.playerLines.at(-1).text, result.text);
});

test('识别期间拒绝推进和重复识别，失败后可重试', async () => {
  const f = await voiceSession();
  let reject;
  f.link.transcribe = () => new Promise((_, fail) => { reject = fail; });
  const hub = createMixinHub({ createSession: () => f.session });
  const created = await hub.dispatch({ method: 'POST', path: '/api/mixin', body: {} });
  const path = `/api/mixin/${created.payload.id}`;
  const pending = hub.dispatch({ method: 'POST', path: `${path}/transcribe`, body: f.body() });
  const failed = assert.rejects(pending, /没有听清/);
  assert.equal(f.session.transcribing, true);
  for (const action of ['tick', 'step', 'restart', 'transcribe']) {
    const response = await hub.dispatch({ method: 'POST', path: `${path}/${action}`, body: {} });
    assert.equal(response.status, 409);
  }
  reject(new Error('没有听清'));
  await failed;
  assert.equal(f.session.transcribing, false);
  f.link.transcribe = async () => ({ text: '重试成功' });
  assert.equal((await f.session.transcribe(f.body())).text, '重试成功');
});

test('文字模式明确说明不支持录音识别', async () => {
  const hub = createMixinHub();
  const created = await hub.dispatch({ method: 'POST', path: '/api/mixin', body: {} });
  const result = await hub.dispatch({ method: 'POST', path: `/api/mixin/${created.payload.id}/transcribe`, body: {} });
  assert.equal(result.status, 409);
  assert.match(result.payload.error, /文字模式/);
});

test('HTTP 接受超过普通正文上限的录音，保留来源与会话校验', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mixin-asr-'));
  let received = 0;
  const server = createApp({
    mixinCredentials: { config: {}, credentials: { url: 'fake', token: 'fake' } },
    audioDir: dir, presynthCatalog: [], log() {},
    openAudioLink: () => ({
      async connect() {}, close() {}, abort() {}, cancelTurn() {},
      detect: async () => ({ spoken: '测试台词', pcm: Buffer.alloc(640) }),
      transcribe: async input => { received = input.length; return { text: '这是麦克风识别草稿。' }; },
    }),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const post = (path, body = {}, headers = {}) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie, ...headers }, body: JSON.stringify(body),
  });
  const created = await post('/api/mixin', { seed: 42 });
  cookie = created.headers.get('set-cookie').split(';')[0];
  const { id } = await created.json();
  const path = `/api/mixin/${id}`;
  let game = (await (await post(`${path}/start`)).json()).game;
  for (let i = 0; i < 40 && game.phase !== 'round_player'; i++) {
    game = (await (await post(`${path}/${game.cue ? 'step' : 'tick'}`, { ms: 1000 })).json()).game;
  }
  assert.equal(game.phase, 'round_player');
  const body = { pcm: Buffer.alloc(6400).toString('base64'), generation: game.generation, phase: game.phase, round: game.round };
  assert.equal((await post(`${path}/transcribe`, body, { origin: 'https://other.test' })).status, 403);
  assert.equal((await post(`${path}/transcribe`, body, { cookie: '' })).status, 409);
  const response = await post(`${path}/transcribe`, body);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.text, '这是麦克风识别草稿。');
  assert.equal(result.game.pending, null);
  assert.equal(received, 6400);
  assert.equal((await post(`${path}/transcribe`, { ...body, pcm: 'invalid' })).status, 400);
});
