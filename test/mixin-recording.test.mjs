import test from 'node:test';
import assert from 'node:assert/strict';
import { startHoldToTalk, stopHoldToTalk } from '../public/mixin/audio.js';

function environment(t, getMedia) {
  const keys = ['navigator', 'AudioContext', 'AudioWorkletNode'];
  const original = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const nodes = [], contexts = [];
  class Context {
    state = 'running'; destination = {}; audioWorklet = { addModule: async () => {} };
    constructor() { contexts.push(this); }
    async resume() {}
    async close() { this.state = 'closed'; }
    createMediaStreamSource() { return { connect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
  }
  class Worklet {
    port = { postMessage: value => { this.active = value; } };
    constructor() { nodes.push(this); }
    connect() {}
    disconnect() { this.disconnected = true; }
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: getMedia } } });
  globalThis.AudioContext = Context;
  globalThis.AudioWorkletNode = Worklet;
  t.after(() => {
    stopHoldToTalk({ cancel: true });
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return { nodes, contexts };
}

test('按住采集 PCM，松开返回完整内容与时长并释放麦克风', async t => {
  let stopped = 0, started = 0, result;
  const env = environment(t, async () => ({ getTracks: () => [{ stop() { stopped++; } }] }));
  await startHoldToTalk({ onStart() { started++; }, onStop(value) { result = value; } });
  const packet = new Uint8Array(640).fill(7);
  for (let i = 0; i < 10; i++) env.nodes[0].port.onmessage({ data: packet.buffer });
  stopHoldToTalk();
  assert.equal(started, 1);
  assert.equal(stopped, 1);
  assert.equal(env.nodes[0].disconnected, true);
  assert.equal(env.contexts[0].state, 'closed');
  assert.equal(result.durationMs, 200);
  assert.deepEqual(Buffer.from(result.pcm, 'base64'), Buffer.alloc(6400, 7));
});

test('等待权限时松开，迟到的授权会释放设备且不提交录音', async t => {
  let resolveMedia, stopped = 0, result = 'not-called', errors = 0;
  environment(t, () => new Promise(resolve => { resolveMedia = resolve; }));
  const pending = startHoldToTalk({ onStop(value) { result = value; }, onError() { errors++; } });
  await Promise.resolve();
  stopHoldToTalk();
  resolveMedia({ getTracks: () => [{ stop() { stopped++; } }] });
  await pending;
  assert.equal(stopped, 1);
  assert.equal(result, null);
  assert.equal(errors, 0);
});

test('权限被拒绝时明确提示，并允许下一次重新录音', async t => {
  let denied = true, message = '';
  environment(t, async () => {
    if (denied) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    return { getTracks: () => [{ stop() {} }] };
  });
  await startHoldToTalk({ onError(error) { message = error.message; } });
  assert.match(message, /权限被拒绝/);
  denied = false;
  let started = false;
  await startHoldToTalk({ onStart() { started = true; } });
  assert.equal(started, true);
});

test('30 秒自动结束并只返回一次；取消时不提交采集内容', async t => {
  const env = environment(t, async () => ({ getTracks: () => [{ stop() {} }] }));
  const results = [];
  await startHoldToTalk({ onStop(value) { results.push(value); } });
  for (let i = 0; i < 1501; i++) env.nodes[0].port.onmessage({ data: new ArrayBuffer(640) });
  stopHoldToTalk();
  assert.equal(results.length, 1);
  assert.equal(results[0].durationMs, 30000);
  await startHoldToTalk({ onStop(value) { results.push(value); } });
  env.nodes[1].port.onmessage({ data: new ArrayBuffer(640) });
  stopHoldToTalk({ cancel: true });
  assert.equal(results[1], null);
});

test('录音期间每两秒返回完整快照，预览不停止采集，松开保留最后不足两秒的尾音', async t => {
  let stopped = 0, final;
  const env = environment(t, async () => ({ getTracks: () => [{ stop() { stopped++; } }] }));
  const previews = [];
  await startHoldToTalk({ onProgress(snapshot) { previews.push(snapshot); }, onStop(snapshot) { final = snapshot; } });
  for (let i = 0; i < 225; i++) env.nodes[0].port.onmessage({ data: new Uint8Array(640).fill(i % 256).buffer });
  assert.deepEqual(previews.map(item => item.durationMs), [2000, 4000]);
  assert.equal(stopped, 0);
  assert.equal(Buffer.from(previews[0].pcm, 'base64').length, 64000);
  const second = Buffer.from(previews[1].pcm, 'base64');
  assert.equal(second.length, 128000);
  assert.deepEqual(second.subarray(0, 64000), Buffer.from(previews[0].pcm, 'base64'));
  stopHoldToTalk();
  assert.equal(stopped, 1);
  assert.equal(final.durationMs, 4500);
  assert.equal(Buffer.from(final.pcm, 'base64').length, 144000);
});
