import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { matchAsset, ttsKey } from '../mixin-audio.mjs';
import { createHash } from 'node:crypto';
import { scriptedBody } from '../mixin-prompts.mjs';
import { sanitizeForTts } from '../tts-text.mjs';
import { createMixinLink } from '../mixin-link.mjs';
import { presynthCatalog } from '../mixin-prompts.mjs';
import { roleById, voiceOf } from '../mixin-roles.mjs';
import { main as speakMain, runSpeakRound, SPEAK_ROUND } from '../scripts/speak-round.mjs';
import { runPresynth } from '../scripts/presynth.mjs';

const TOKEN = 'super-secret-token-value';
const KEY = 'api-key-should-stay-hidden';

function missingFile() {
  const error = new Error('missing');
  error.code = 'ENOENT';
  throw error;
}

function installFake({ pcmBytes = 640, extraStt = null } = {}) {
  const sockets = [];
  const detects = [];
  const createSocket = () => {
    const socket = new EventEmitter();
    sockets.push(socket);
    socket.readyState = 0;
    socket.sent = [];
    socket.send = (data, options) => {
      socket.sent.push({ data, options });
      if (options?.binary) return;
      const message = JSON.parse(data.toString());
      if (message.type === 'hello') {
        queueMicrotask(() => {
          if (socket.readyState !== 1) return;
          socket.emit('message', Buffer.from(JSON.stringify({
            type: 'hello',
            session_id: 'round-1',
            audio_params: { format: 'pcm', sample_rate: 16000, channels: 1 },
          })), false);
        });
      }
      if (message.type === 'listen' && message.state === 'detect') {
        detects.push(message);
        setImmediate(() => {
          if (socket.readyState !== 1) return;
          const send = obj => socket.emit('message', Buffer.from(JSON.stringify(obj)), false);
          send({ type: 'stt', text: message.text });
          if (extraStt && detects.length === SPEAK_ROUND.length) send({ type: 'stt', text: extraStt });
          send({ type: 'tts', state: 'start' });
          send({ type: 'tts', state: 'sentence_start', text: message.text.slice(message.text.indexOf('【台词】') + 4, message.text.indexOf('（局势：')) });
          socket.emit('message', Buffer.alloc(pcmBytes, 1), true);
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
  return { createSocket, sockets, detects };
}

function loadedFrom(env) {
  return async () => ({
    source: 'env',
    config: { deviceId: '02:10:20:30:40:50', clientId: 'client-test' },
    credentials: { url: 'wss://xrobo-io.qiniuapi.com/v1/ws/', token: TOKEN },
    apiKey: env.LINX_API_KEY || null,
  });
}

test('speak:round uses one socket, distinct voices, verbatim host lines, and drops echo', async () => {
  const fake = installFake({ extraStt: '我是玩家，不是回声' });
  const logs = [];
  const errors = [];
  const result = await speakMain({
    env: {
      LINX_DEVICE_JSON: JSON.stringify({ deviceId: '02:10:20:30:40:50', clientId: 'client-test' }),
      LINX_API_KEY: KEY,
    },
    readFile: missingFile,
    log: line => logs.push(line),
    error: line => errors.push(line),
    resolve: loadedFrom({ LINX_API_KEY: KEY }),
    createLink: loaded => createMixinLink({
      config: loaded.config,
      credentials: loaded.credentials,
      createSocket: fake.createSocket,
      handshakeMs: 1000,
    }),
    timeoutMs: 1000,
  });
  assert.equal(result.code, 0);
  assert.equal(errors.length, 0);
  assert.equal(fake.sockets.length, 1);
  assert.equal(fake.detects.length, SPEAK_ROUND.length);
  const hello = JSON.parse(fake.sockets[0].sent[0].data.toString());
  assert.equal(hello.type, 'hello');
  assert.equal(hello.features.mcp, false);
  assert.equal(Object.hasOwn(hello.agent_params.custom_replace_prompt, 'counter_brief'), true);
  const voices = new Set();
  for (const [index, cue] of SPEAK_ROUND.entries()) {
    const detect = fake.detects[index];
    assert.equal(detect.agent_params.custom_replace_prompt, undefined);
    assert.equal(detect.agent_params.voice.id, voiceOf(roleById(cue.roleId)).voiceId);
    assert.ok(detect.text.includes(`【台词】${sanitizeForTts(cue.line)}`));
    voices.add(detect.agent_params.voice.id);
  }
  assert.equal(voices.size, SPEAK_ROUND.length);
  assert.match(fake.detects[0].text, /角色：群主·零号。【台词】下一位，请加载。/);
  assert.equal(result.report.connectCount, 1);
  assert.equal(result.report.stray.length, 1);
  assert.equal(result.report.stray[0], '我是玩家，不是回声');
  assert.equal(result.report.echoes.length >= SPEAK_ROUND.length, true);
  assert.equal(result.report.echoes.some(text => text.startsWith('角色：')), true);
  const printed = logs.join('\n');
  assert.equal(printed.includes(TOKEN), false);
  assert.equal(printed.includes(KEY), false);
  assert.match(printed, /凭据来源：env/);
  assert.match(printed, /单连接已建立/);
  assert.match(printed, /回声已过滤：/);
  assert.match(printed, /非回声转写：1 条｜我是玩家，不是回声/);
  assert.match(printed, /speak-round 完成/);
  assert.equal(printed.includes('02:10:20:30:40:50'), false);
});

test('speak:round and presynth fail clearly when credentials are missing', async () => {
  const logs = [];
  const errors = [];
  const env = { LINX_DEVICE_JSON: '', LINX_API_KEY: KEY, LINX_WS_URL: '', LINX_WS_TOKEN: '', LINX_DEVICE_ID: '', LINX_CLIENT_ID: '' };
  const spoken = await speakMain({ env, readFile: missingFile, log: line => logs.push(line), error: line => errors.push(line) });
  assert.equal(spoken.code, 1);
  assert.match(errors.join('\n'), /LINX_DEVICE_JSON/);
  assert.equal(errors.join('\n').includes(KEY), false);
  const dir = path.join(tmpdir(), `presynth-missing-${Date.now()}`);
  const failed = await runPresynth({
    dir,
    env,
    readFile: missingFile,
    log: line => logs.push(line),
  }).catch(error => error);
  assert.match(failed.message, /LINX_DEVICE_JSON/);
  assert.equal(failed.message.includes(KEY), false);
  await assert.rejects(readdir(dir), { code: 'ENOENT' });
});

test('presynth writes stable small mxop files and a manifest on one connection', async () => {
  const fake = installFake();
  const dir = await mkdtemp(path.join(tmpdir(), 'presynth-'));
  const logs = [];
  try {
    const report = await runPresynth({
      dir,
      env: { LINX_DEVICE_JSON: JSON.stringify({ deviceId: '02:10:20:30:40:50', clientId: 'client-test' }), LINX_API_KEY: KEY },
      readFile: missingFile,
      log: line => logs.push(line),
      resolve: loadedFrom({ LINX_API_KEY: KEY }),
      createLink: loaded => createMixinLink({
        config: loaded.config,
        credentials: loaded.credentials,
        createSocket: fake.createSocket,
        handshakeMs: 1000,
      }),
      timeoutMs: 1000,
    });
    assert.equal(fake.sockets.length, 1);
    assert.equal(report.connectCount, 1);
    assert.equal(report.lines.length, presynthCatalog().length);
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, 1);
    assert.equal(manifest.lines[0].file, 'reveal-sfx.wav');
    assert.equal(manifest.lines[0].kind, 'sfx');
    const hostVoice = voiceOf(roleById('host')).voiceId;
    for (const item of presynthCatalog()) {
      const entry = manifest.lines.find(line => line.id === item.id);
      assert.equal(entry.file, `${item.id}.mxop`);
      assert.equal(entry.text, item.text);
      assert.equal(entry.voiceId, hostVoice);
      assert.equal(entry.kind, 'tts');
      assert.equal(entry.roleId, 'host');
      const bytes = await readFile(path.join(dir, entry.file));
      assert.ok(bytes.length > 16 && bytes.length < 256 * 1024);
      assert.equal(bytes.subarray(0, 4).toString(), 'MXOP');
    }
    const sfx = await readFile(path.join(dir, 'reveal-sfx.wav'));
    assert.ok(sfx.length < 20_000);
    const printed = `${logs.join('\n')}\n${JSON.stringify(manifest)}`;
    assert.equal(printed.includes(TOKEN), false);
    assert.equal(printed.includes(KEY), false);
    assert.match(logs.join('\n'), /presynth 完成：55 句/);
    assert.equal(/口播「/.test(logs.join('\n')), false);
    assert.match(logs.join('\n'), /这些文件已在 \.gitignore 里，不要提交。/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('presynth sanitizes detect text and preserves manifest text and stable keys', async () => {
  const fake = installFake();
  const dir = await mkdtemp(path.join(tmpdir(), 'presynth-tts-'));
  const link = createMixinLink({
    config: { deviceId: 'fake-device', clientId: 'fake-client' },
    credentials: { url: 'wss://xrobo-io.qiniuapi.com/v1/ws/', token: 'fake-token' },
    createSocket: fake.createSocket,
  });
  try {
    await link.connect();
    const item = { id: 'list', roleId: 'host', text: '1️⃣核对🙂②结论👍' };
    const report = await runPresynth({ dir, link, catalog: [item], log() {} });
    assert.ok(fake.detects[0].text.includes('【台词】第一、核对第二、结论（局势：'));
    assert.equal(report.lines[0].text, item.text);
    assert.equal(report.lines[0].file, 'list.mxop');
  } finally {
    link.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('presynth and runtime invalidate missing or stale TTS hashes and changed voices, and reuse unchanged audio', async () => {
  const fake = installFake();
  const dir = await mkdtemp(path.join(tmpdir(), 'presynth-cache-'));
  const link = createMixinLink({
    config: { deviceId: 'fake-device', clientId: 'fake-client' },
    credentials: { url: 'wss://xrobo-io.qiniuapi.com/v1/ws/', token: 'fake-token' },
    createSocket: fake.createSocket,
  });
  const item = { id: 'list', roleId: 'host', text: '1️⃣核对🙂②结论👍' };
  const voiceId = voiceOf(roleById('host')).voiceId;
  const request = { text: item.text, voiceId };
  const run = () => runPresynth({ dir, link, catalog: [item], log() {} });
  try {
    await link.connect();
    const initial = await run();
    const entry = initial.lines[0];
    const speak = scriptedBody(fake.detects[0].text);
    assert.equal(entry.ttsHash, createHash('sha256').update(JSON.stringify([speak, voiceId])).digest('hex').slice(0, 16));
    assert.equal(ttsKey(item.text, voiceId), ttsKey(speak, voiceId));
    assert.notEqual(ttsKey(item.text, voiceId), ttsKey(item.text, 'other-voice'));
    assert.equal(matchAsset(initial.manifest, request).ttsHash, entry.ttsHash);
    await run();
    assert.equal(fake.detects.length, 1, 'unchanged audio is skipped');
    for (const change of ['missing hash', 'stale hash', 'changed voice']) {
      const old = { ...entry };
      if (change === 'missing hash') delete old.ttsHash;
      if (change === 'stale hash') old.ttsHash = createHash('sha256').update(JSON.stringify([item.text, voiceId])).digest('hex').slice(0, 16);
      if (change === 'changed voice') {
        old.voiceId = 'other-voice';
        old.ttsHash = ttsKey(item.text, old.voiceId);
      }
      const manifest = { version: 1, lines: [old] };
      assert.equal(matchAsset(manifest, request), null, change);
      await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
      const before = fake.detects.length;
      const refreshed = await run();
      assert.equal(fake.detects.length, before + 1, `${change} is resynthesized`);
      assert.equal(matchAsset(refreshed.manifest, request).ttsHash, entry.ttsHash);
      await run();
      assert.equal(fake.detects.length, before + 1, 'refreshed audio is skipped');
    }
    assert.equal(fake.sockets.length, 1);
  } finally {
    link.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a turn with no audio does not publish a manifest, and bad sockets stay redacted', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'presynth-empty-'));
  try {
    const failed = await runPresynth({
      dir,
      env: { LINX_DEVICE_JSON: JSON.stringify({ deviceId: 'd', clientId: 'c' }) },
      readFile: missingFile,
      log() {},
      resolve: async () => ({
        source: 'env',
        config: { deviceId: 'd', clientId: 'c' },
        credentials: { url: 'wss://xrobo-io.qiniuapi.com/v1/ws/', token: TOKEN },
      }),
      createLink: () => ({
        connectCount: 1,
        async connect() {},
        async detect() { return { pcm: Buffer.alloc(0), spoken: '' }; },
        close() {},
      }),
      timeoutMs: 1000,
      catalog: [{ id: 'host-rules', roleId: 'host', text: '规则很简单' }],
    }).catch(error => error);
    assert.match(failed.message, /没有收到音频/);
    assert.equal(failed.message.includes(TOKEN), false);
    await assert.rejects(readFile(path.join(dir, 'manifest.json')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const link = createMixinLink({
    config: { deviceId: '02:10:20:30:40:50', clientId: 'client-test' },
    credentials: { url: 'wss://xrobo-io.qiniuapi.com/v1/ws/', token: TOKEN },
    createSocket: () => { throw new Error(`connect failed ${TOKEN}`); },
  });
  const logs = [];
  const report = await runSpeakRound({
    link,
    log: line => logs.push(line),
    timeoutMs: 200,
    cues: SPEAK_ROUND.slice(0, 1),
  }).catch(error => error);
  assert.match(report.message, /连接失败|connect failed|redacted/);
  assert.equal(report.message.includes(TOKEN), false);
  assert.equal(logs.join('\n').includes(TOKEN), false);
});
