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
