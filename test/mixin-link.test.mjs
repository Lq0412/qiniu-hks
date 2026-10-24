import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMixinLink } from '../mixin-link.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 只在内存里收发消息，不连接设备。
async function fakeLink(settleMs = 40) {
  const socket = new EventEmitter();
  socket.readyState = 1;
  const detects = [];
  const json = message => socket.emit('message', Buffer.from(JSON.stringify(message)), false);
  socket.send = data => {
    const message = JSON.parse(data);
    if (message.type === 'hello') queueMicrotask(() => json({ type: 'hello' }));
    if (message.type === 'listen') detects.push(message);
  };
  socket.close = () => { socket.readyState = 3; socket.emit('close'); };
  const link = createMixinLink({
    config: { deviceId: 'fake-device', clientId: 'fake-client' },
    credentials: { url: 'wss://xrobo-io.qiniuapi.com/v1/ws/', token: 'fake-token' },
    createSocket: () => { socket.readyState = 1; return socket; },
    settleMs,
  });
  await link.connect();
  return {
    link, socket, detects, json,
    audio: bytes => socket.emit('message', Buffer.from(bytes), true),
    stop: () => json({ type: 'tts', state: 'stop' }),
    detect: text => link.detect({ text, voiceId: 'fake-voice' }),
  };
}

test('取消后排空迟到音频、台词和 stop，下一句只收自己的完整音频', async () => {
  const f = await fakeLink(1000);
  try {
    const events = [];
    f.link.subscribe(event => events.push(event));
    const first = f.detect('第一句');
    const rejected = assert.rejects(first, { code: 'CANCELLED' });
    f.link.cancelTurn();
    await rejected;
    let ended = false;
    const second = f.detect('第二句').then(result => { ended = true; return result; });
    assert.equal(f.detects.length, 1);
    f.audio([9, 9]);
    f.json({ type: 'tts', state: 'sentence_start', text: '旧台词' });
    f.stop();
    assert.equal(f.detects.length, 2);
    await Promise.resolve();
    assert.equal(ended, false);
    assert.equal(events.length, 0);
    f.json({ type: 'tts', state: 'sentence_start', text: '新台词' });
    f.audio([1, 2]);
    f.audio([3, 4]);
    f.stop();
    const result = await second;
    assert.deepEqual(result.pcm, Buffer.from([1, 2, 3, 4]));
    assert.equal(result.spoken, '新台词');
  } finally { f.link.close(); }
});

test('旧轮没有 stop 时，排空窗口结束后发送下一句', async () => {
  const f = await fakeLink(30);
  try {
    const rejected = assert.rejects(f.detect('第一句'), { code: 'CANCELLED' });
    f.link.cancelTurn();
    await rejected;
    const second = f.detect('第二句');
    assert.equal(f.detects.length, 1);
    await sleep(60);
    assert.equal(f.detects.length, 2);
    f.audio([1, 2]);
    f.stop();
    assert.deepEqual((await second).pcm, Buffer.from([1, 2]));
  } finally { f.link.close(); }
});

test('正常 stop 后下一句立即发送，abort 仍等待 stop 并返回 aborted', async () => {
  const f = await fakeLink(60000);
  try {
    const first = f.detect('第一句');
    assert.throws(() => f.detect('并发句'), /上一段/);
    f.link.abort();
    f.stop();
    assert.equal((await first).aborted, true);
    const second = f.detect('第二句');
    assert.equal(f.detects.length, 2);
    f.stop();
    assert.equal((await second).aborted, false);
  } finally { f.link.close(); }
});

test('排空期间多次 detect 按顺序等待，关闭会结束所有等待', async () => {
  const f = await fakeLink(60000);
  const rejected = assert.rejects(f.detect('第一句'), { code: 'CANCELLED' });
  f.link.cancelTurn();
  await rejected;
  const second = f.detect('第二句');
  const third = f.detect('第三句');
  f.stop();
  assert.equal(f.detects.length, 2);
  f.stop();
  await second;
  assert.equal(f.detects.length, 3);
  const closed = assert.rejects(third, { code: 'CLOSED' });
  f.link.close();
  await closed;
});

test('等待排空的句子被取消后不会迟发，关闭会清除排空', async () => {
  const f = await fakeLink(60000);
  const first = assert.rejects(f.detect('第一句'), { code: 'CANCELLED' });
  f.link.cancelTurn();
  await first;
  const second = assert.rejects(f.detect('第二句'), { code: 'CANCELLED' });
  f.link.cancelTurn();
  await second;
  const third = assert.rejects(f.detect('第三句'), { code: 'CLOSED' });
  f.socket.close();
  await third;
  assert.equal(f.detects.length, 1);
});

test('重连清除旧排空，不阻塞新连接的下一句', async () => {
  const f = await fakeLink(60000);
  try {
    const rejected = assert.rejects(f.detect('第一句'), { code: 'CANCELLED' });
    f.link.cancelTurn();
    await rejected;
    const waiting = assert.rejects(f.detect('等待句'), { code: 'CLOSED' });
    await f.link.reconnect();
    await waiting;
    const next = f.detect('重连后的句子');
    assert.equal(f.detects.length, 2);
    f.audio([4, 5]);
    f.stop();
    assert.deepEqual((await next).pcm, Buffer.from([4, 5]));
  } finally { f.link.close(); }
});
