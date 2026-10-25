import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAudioLane } from '../mixin-lane.mjs';
import { createApp } from '../server.mjs';
import { runPresynth } from '../scripts/presynth.mjs';

const CATALOG = [
  { id: 'host-a', roleId: 'host', text: '第一句固定台词' },
  { id: 'host-b', roleId: 'host', text: '第二句固定台词' },
  { id: 'host-c', roleId: 'host', text: '第三句固定台词' },
];

function controllableLink() {
  const pending = [];
  const link = {
    connectCount: 1,
    aborts: 0,
    closed: false,
    async connect() {},
    detect() {
      return new Promise(resolve => { pending.push(resolve); });
    },
    abort() {
      link.aborts += 1;
      pending.shift()?.({ pcm: Buffer.alloc(0), spoken: '', aborted: true });
    },
    close() { link.closed = true; },
  };
  link.pending = pending;
  link.finish = (spoken = '口播字幕') => {
    pending.shift()?.({ pcm: Buffer.alloc(640, 1), spoken, aborted: false });
  };
  return link;
}

async function waitFor(check) {
  for (let i = 0; i < 40; i += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('等待条件超时');
}

test('a game aborts presynth and reuses the same socket', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lane-'));
  const logs = [];
  let opened = 0;
  let link;
  try {
    const lane = createAudioLane({
      dir,
      catalog: CATALOG,
      timeoutMs: 1000,
      log: line => logs.push(line),
      openLink() {
        opened += 1;
        link = controllableLink();
        return link;
      },
    });
    let settled = false;
    const pending = lane.warmupBackground();
    pending.then(() => { settled = true; });
    await waitFor(() => link?.pending.length === 1);
    assert.equal(settled, false);
    assert.equal(lane.mode, 'presynth');
    link.finish('欢迎来到模型群');
    await waitFor(() => link.pending.length === 1 && logs.some(line => line.includes('host-a.mxop')));
    const acquired = await lane.acquireForGame();
    assert.equal(opened, 1);
    assert.equal(acquired, link);
    assert.equal(link.aborts, 1);
    assert.equal(link.closed, false);
    assert.equal(lane.mode, 'game');
    await pending;
    const names = await readdir(dir);
    assert.deepEqual(names.sort(), ['host-a.mxop', 'manifest.json', 'reveal-sfx.wav']);
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.lines.filter(item => item.kind === 'tts').length, 1);
    assert.match(logs.join('\n'), /预合成让给对局：已写 1 句/);
    lane.releaseGame();
    assert.equal(lane.mode, 'presynth');
    await waitFor(() => link.pending.length === 1);
    const again = await lane.acquireForGame();
    assert.equal(again, link);
    assert.equal(opened, 1);
    assert.equal(link.aborts, 2);
    lane.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('starting a game while presynth is still connecting does not open a second socket', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lane-connect-'));
  let opened = 0;
  let releaseConnect;
  let link;
  try {
    const lane = createAudioLane({
      dir,
      catalog: CATALOG,
      timeoutMs: 1000,
      log() {},
      openLink() {
        opened += 1;
        link = controllableLink();
        link.connect = () => new Promise(resolve => { releaseConnect = resolve; });
        return link;
      },
    });
    const background = lane.warmupBackground();
    const acquired = lane.acquireForGame();
    await waitFor(() => typeof releaseConnect === 'function');
    releaseConnect();
    const got = await acquired;
    await background;
    assert.equal(got, link);
    assert.equal(opened, 1);
    assert.equal(link.closed, false);
    assert.equal(link.pending.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an injected presynth link is not closed when the game asks it to stop', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lane-inject-'));
  const link = controllableLink();
  const logs = [];
  try {
    const running = runPresynth({
      dir,
      link,
      catalog: CATALOG.slice(0, 1),
      timeoutMs: 1000,
      log: line => logs.push(line),
      shouldStop: () => true,
    });
    const report = await running;
    assert.equal(report.stopped, true);
    assert.equal(report.lines.length, 0);
    assert.equal(link.closed, false);
    assert.equal(link.pending.length, 0);
    const names = await readdir(dir);
    assert.deepEqual(names, ['reveal-sfx.wav']);
    assert.match(logs.join('\n'), /预合成让给对局：已写 0 句/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the server starts before presynth finishes and text mode does not open a socket', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lane-server-'));
  let opened = 0;
  let link;
  try {
    const voice = createApp({
      audioDir: dir,
      mixinCredentials: {
        config: { deviceId: '02:10:20:30:40:50', clientId: 'client-test' },
        credentials: { url: 'wss://xrobo-io.qiniuapi.com/v1/ws/', token: 'secret-token' },
      },
      openAudioLink() {
        opened += 1;
        link = controllableLink();
        return link;
      },
    });
    assert.equal(voice.audioLane.mode, 'presynth');
    await new Promise(resolve => voice.listen(0, '127.0.0.1', resolve));
    await waitFor(() => opened === 1 && link?.pending.length === 1);
    const base = `http://127.0.0.1:${voice.address().port}`;
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const acquired = await voice.audioLane.acquireForGame();
    assert.equal(acquired, link);
    assert.equal(opened, 1);
    voice.close();

    const text = createApp();
    assert.equal(text.audioLane, null);
    text.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('增量预合成跳过已有文件，打断和失败保留清单', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'incremental-'));
  let count = 0;
  const link = { connectCount: 1, close() {}, cancelTurn() {}, async detect() {
    count += 1;
    return { pcm: Buffer.alloc(640, 1) };
  } };
  try {
    await runPresynth({ dir, link, catalog: CATALOG.slice(0, 1), log() {} });
    await runPresynth({ dir, link, catalog: CATALOG, shouldStop: () => count >= 2, log() {} });
    assert.equal(count, 2);
    let manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.lines.filter(item => item.kind === 'tts').length, 1);
    await runPresynth({ dir, link, catalog: CATALOG, log() {} });
    assert.equal(count, 4);
    await runPresynth({ dir, link, catalog: CATALOG, log() {} });
    assert.equal(count, 4);
    manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.lines.filter(item => item.kind === 'tts').length, 3);
    link.detect = async () => { throw new Error('假连接断开'); };
    await assert.rejects(runPresynth({ dir, link, catalog: [...CATALOG, { id: 'new', text: '新句', roleId: 'host' }], log() {} }));
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')), manifest);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('对局结束续预合成只补剩余句，再开局仍用同一连接', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lane-resume-'));
  const link = controllableLink();
  let opened = 0;
  let calls = 0;
  const detect = link.detect;
  link.detect = () => { calls += 1; return detect(); };
  const lane = createAudioLane({ dir, catalog: CATALOG, log() {}, openLink() { opened += 1; return link; } });
  try {
    lane.warmupBackground();
    await waitFor(() => calls === 1);
    link.finish();
    await waitFor(() => calls === 2);
    await lane.acquireForGame();
    lane.releaseGame();
    await waitFor(() => calls === 3);
    assert.equal(opened, 1);
    link.finish();
    await waitFor(() => calls === 4);
    await lane.acquireForGame();
    assert.equal(link.aborts, 2);
    lane.releaseGame();
    await waitFor(() => calls === 5);
    link.finish();
    await waitFor(() => lane.mode === 'idle');
    assert.equal(calls, 5);
    assert.equal(opened, 1);
    assert.equal(link.connectCount, 1);
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.lines.filter(item => item.kind === 'tts').length, 3);
  } finally { lane.close(); await rm(dir, { recursive: true, force: true }); }
});

test('多人同时开局仅一局使用语音，其他局自动文字且不会释放占用者的通道', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lane-multi-'));
  const link = controllableLink();
  let detects = 0;
  link.detect = async () => { detects++; return { pcm: Buffer.alloc(640, 1), spoken: '测试台词' }; };
  const server = createApp({
    audioDir: dir, presynthCatalog: [], log() {},
    mixinCredentials: { config: { deviceId: 'fake-device', clientId: 'fake-client' }, credentials: { url: 'wss://fake.invalid', token: 'fake-token' } },
    openAudioLink: () => link,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body = {}, cookie = '') => {
    const response = await fetch(base + path, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    return { response, data: await response.json() };
  };
  const create = async () => {
    const { response, data } = await post('/api/mixin', { sceneId: 'annual', seed: 1 });
    assert.equal(response.status, 201);
    return { id: data.id, cookie: response.headers.get('set-cookie').split(';')[0] };
  };
  const act = (session, action, body) => post(`/api/mixin/${session.id}/${action}`, body, session.cookie);
  try {
    await waitFor(() => server.audioLane.mode === 'idle');
    const sessions = await Promise.all([create(), create(), create()]);
    assert.equal(server.audioLane.mode, 'idle');
    const started = await Promise.all(sessions.slice(0, 2).map(session => act(session, 'start')));
    assert.ok(started.every(item => item.response.status === 200));
    assert.deepEqual(started.map(item => item.data.game.mode).sort(), ['live', 'text']);
    const voice = sessions[started.findIndex(item => item.data.game.mode === 'live')];
    const text = sessions[started.findIndex(item => item.data.game.mode === 'text')];
    const textStart = started.find(item => item.data.game.mode === 'text');
    assert.match(textStart.data.notice, /自动切换为纯文字/);
    assert.equal(server.audioLane.mode, 'game');
    const beforeDetects = detects, beforeAborts = link.aborts;
    const step = await act(text, 'step');
    assert.equal(step.data.game.mode, 'text');
    assert.equal(step.data.audioUrl, undefined);
    assert.equal(detects, beforeDetects);
    const record = await act(text, 'transcribe', { pcm: 'fake' });
    assert.equal(record.response.status, 409);
    await act(text, 'exit');
    assert.equal(link.aborts, beforeAborts);
    assert.equal(server.audioLane.mode, 'game');
    const repeated = await act(voice, 'start');
    assert.equal(repeated.response.status, 409);
    await act(voice, 'exit');
    await waitFor(() => server.audioLane.mode === 'idle');
    const next = await act(sessions[2], 'start');
    assert.equal(next.data.game.mode, 'live');
    assert.equal(next.data.notice, undefined);
    await act(sessions[2], 'exit');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await server.audioLane.warmupBackground();
    await rm(dir, { recursive: true, force: true });
  }
});

test('连接建立期间也保留占用，不能给另一局分配同一通道', async () => {
  let connected;
  const link = controllableLink();
  link.connect = () => new Promise(resolve => { connected = resolve; });
  const lane = createAudioLane({ openLink: () => link, catalog: [], log() {} });
  const first = lane.acquireForGame();
  await waitFor(() => connected);
  await assert.rejects(lane.acquireForGame(), /其他对局占用/);
  assert.equal(lane.mode, 'game');
  connected();
  assert.equal(await first, link);
  lane.close();
});

test('开局连接失败后释放占用，后续对局仍可获得语音通道', async () => {
  let attempts = 0;
  const link = controllableLink();
  link.connect = async () => {
    attempts++;
    if (attempts === 1) throw new Error('模拟连接失败');
  };
  const lane = createAudioLane({ openLink: () => link, catalog: [], log() {} });
  try {
    await assert.rejects(lane.acquireForGame(), /模拟连接失败/);
    await lane.warmupBackground();
    assert.equal(lane.mode, 'idle');
    assert.equal(await lane.acquireForGame(), link);
    assert.equal(lane.mode, 'game');
    assert.equal(attempts, 2);
  } finally { lane.close(); }
});
