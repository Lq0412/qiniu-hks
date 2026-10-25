import test from 'node:test';
import assert from 'node:assert/strict';
import { createMixinHub } from '../mixin-http.mjs';
import { createTextSession } from '../mixin-session.mjs';
import { createVoiceSession } from '../mixin-live.mjs';
import { play, stop, pausePlayback, resumePlayback } from '../public/mixin/audio.js';

function mockAudio(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Audio');
  const instances = [];
  class Audio {
    currentTime = 0; calls = 0; pauses = 0;
    constructor() { instances.push(this); }
    play() { this.calls++; return Promise.resolve(); }
    pause() { this.pauses++; }
    removeAttribute() {}
    load() {}
  }
  globalThis.Audio = Audio;
  t.after(() => {
    stop(); resumePlayback();
    if (original) Object.defineProperty(globalThis, 'Audio', original);
    else delete globalThis.Audio;
  });
  return instances;
}

test('暂停保留音频位置，继续播放同一段，暂停期间到达的音频等待继续', async t => {
  const instances = mockAudio(t);
  const first = play('/first.wav');
  instances[0].currentTime = 2.4;
  pausePlayback();
  assert.equal(instances[0].pauses, 1);
  assert.equal(instances[0].currentTime, 2.4);
  resumePlayback();
  assert.equal(instances[0].calls, 2);
  assert.equal(instances[0].currentTime, 2.4);
  instances[0].onended();
  await first;
  pausePlayback();
  const next = play('/next.wav');
  assert.equal(instances[1].calls, 0);
  resumePlayback();
  assert.equal(instances[1].calls, 1);
  instances[1].onended();
  await next;
});

test('暂停引起的旧播放 Promise 拒绝不会终止后来继续的音频', async t => {
  const instances = mockAudio(t);
  const pending = play('/first.wav');
  let reject;
  instances[0].play = () => new Promise((_, fail) => { reject = fail; });
  pausePlayback(); resumePlayback();
  pausePlayback();
  reject(new Error('AbortError'));
  await Promise.resolve();
  let ended = false;
  pending.then(() => { ended = true; });
  await Promise.resolve();
  assert.equal(ended, false);
  instances[0].play = () => Promise.resolve();
  resumePlayback();
  instances[0].onended();
  await pending;
});

test('退出删除会话并清理资源，即使正在识别也可以退出', async () => {
  let closed = 0;
  const hub = createMixinHub({ createSession: options => ({ ...createTextSession(options), transcribing: true, close() { closed++; } }) });
  const created = await hub.dispatch({ method: 'POST', path: '/api/mixin', body: {} });
  const path = `/api/mixin/${created.payload.id}`;
  const result = await hub.dispatch({ method: 'POST', path: `${path}/exit` });
  assert.equal(result.status, 200);
  assert.match(result.headers['Set-Cookie'], /Max-Age=0/);
  assert.equal(closed, 1);
  assert.equal((await hub.dispatch({ method: 'GET', path })).status, 404);
});

test('语音局退出取消未完成配音且只释放一次设备通道', async () => {
  let active, released = 0;
  const link = {
    detect: async () => ({ spoken: '预热', pcm: Buffer.alloc(640) }),
    cancelTurn() {},
    abort() { active?.({ aborted: true, spoken: '', pcm: Buffer.alloc(0) }); },
  };
  const session = createVoiceSession({ options: { seed: 42 }, lane: { acquireForGame: async () => link, releaseGame() { released++; } } });
  await session.start();
  link.detect = () => new Promise(resolve => { active = resolve; });
  const step = session.step();
  session.close();
  session.close();
  assert.equal((await step).fulfilled, false);
  assert.equal(released, 1);
  assert.equal(session.game.cue, null);
  await assert.rejects(session.start(), /退出/);
});

test('已经结束并释放的旧局退出时，不打断被后续对局复用的连接', async () => {
  let released = 0, aborted = 0;
  const link = { detect: async () => ({ spoken: '台词', pcm: Buffer.alloc(640) }), cancelTurn() {}, abort() { aborted++; } };
  const session = createVoiceSession({ options: { demo: true, seed: 42 }, lane: { acquireForGame: async () => link, releaseGame() { released++; } } });
  await session.start();
  for (let i = 0; i < 120 && session.view().phase !== 'result'; i++) {
    if (session.view().cue) await session.step();
    else session.tick(30000);
  }
  assert.equal(session.view().phase, 'result');
  assert.equal(released, 1);
  session.close();
  assert.equal(released, 1);
  assert.equal(aborted, 0);
});
