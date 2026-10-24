import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSpeakCredentials, resolveWebsocket, scrub } from '../linx-credentials.mjs';

const SECRET = 'super-secret-token-value';
const KEY = 'api-key-should-stay-hidden';

function env(extra = {}) {
  return {
    LINX_DEVICE_JSON: '',
    LINX_API_KEY: '',
    LINX_WS_URL: '',
    LINX_WS_TOKEN: '',
    LINX_DEVICE_ID: '',
    LINX_CLIENT_ID: '',
    ...extra,
  };
}

test('credentials load from JSON text, a path, or direct socket env', async () => {
  const files = new Map();
  const readFile = target => {
    if (!files.has(String(target))) {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    }
    return files.get(String(target));
  };
  const fromText = loadSpeakCredentials({
    env: env({ LINX_DEVICE_JSON: JSON.stringify({ deviceId: 'aa:bb', clientId: 'client-1', token: SECRET }), LINX_API_KEY: KEY }),
    readFile,
  });
  assert.equal(fromText.config.deviceId, 'aa:bb');
  assert.equal(fromText.credentials, null);
  assert.equal(fromText.apiKey, KEY);
  assert.equal(fromText.source, 'env');

  files.set('/tmp/device.json', JSON.stringify({ deviceId: '02:00:00:00:00:01', clientId: 'client-2', url: 'wss://xrobo-io.qiniuapi.com/v1/ws/', token: SECRET }));
  const fromPath = loadSpeakCredentials({
    env: env({ LINX_DEVICE_JSON: '/tmp/device.json' }),
    readFile,
  });
  assert.equal(fromPath.credentials.token, SECRET);
  assert.equal(fromPath.config.clientId, 'client-2');

  const direct = loadSpeakCredentials({
    env: env({
      LINX_WS_URL: 'wss://xrobo-io.qiniuapi.com/v1/ws/',
      LINX_WS_TOKEN: SECRET,
      LINX_DEVICE_ID: '02:10:20:30:40:50',
      LINX_CLIENT_ID: 'client-3',
      LINX_API_KEY: KEY,
    }),
    readFile,
  });
  assert.equal(direct.credentials.url.includes('qiniuapi'), true);
  assert.equal(direct.apiKey, KEY);
  assert.equal(direct.source, 'env');
});

test('credential errors do not echo secrets', async () => {
  const readFile = () => {
    const error = new Error(`cannot read ${SECRET}`);
    error.code = 'EACCES';
    throw error;
  };
  assert.throws(() => loadSpeakCredentials({
    env: env({ LINX_DEVICE_JSON: `{${SECRET}` , LINX_API_KEY: KEY }),
    readFile,
  }), error => {
    assert.match(error.message, /不是合法 JSON/);
    assert.equal(error.message.includes(SECRET), false);
    assert.equal(error.message.includes(KEY), false);
    return true;
  });
  assert.throws(() => loadSpeakCredentials({
    env: env({ LINX_DEVICE_JSON: `/tmp/${SECRET}.json`, LINX_API_KEY: KEY }),
    readFile() {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
  }), error => {
    assert.match(error.message, /无法读取/);
    assert.equal(error.message.includes(SECRET), false);
    assert.equal(error.message.includes(KEY), false);
    return true;
  });
  assert.throws(() => loadSpeakCredentials({
    env: env(),
    readFile() {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    fallbackPath: '/missing/device.json',
  }), error => {
    assert.match(error.message, /LINX_DEVICE_JSON/);
    assert.equal(error.message.includes(KEY), false);
    return true;
  });
  assert.throws(() => loadSpeakCredentials({
    env: env({ LINX_WS_TOKEN: SECRET, LINX_API_KEY: KEY }),
    readFile() {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
    fallbackPath: '/missing/device.json',
  }), error => {
    assert.match(error.message, /不完整/);
    assert.equal(error.message.includes(SECRET), false);
    assert.equal(error.message.includes(KEY), false);
    return true;
  });
  const resolved = await resolveWebsocket(
    { config: { deviceId: '02:10:20:30:40:50', clientId: 'client-9' }, credentials: null, apiKey: KEY },
    { otaFn: async () => { throw new Error(`OTA ${KEY} 02:10:20:30:40:50`); } },
  ).catch(error => error);
  assert.match(resolved.message, /OTA/);
  assert.equal(resolved.message.includes(KEY), false);
  assert.equal(resolved.message.includes('02:10:20:30:40:50'), false);
  const unbound = await resolveWebsocket(
    { config: { deviceId: '02:10:20:30:40:50', clientId: 'client-9' }, credentials: null, apiKey: null },
    { otaFn: async () => ({ websocket: { url: 'wss://xrobo-io.qiniuapi.com/v1/ws/' } }) },
  ).catch(error => error);
  assert.match(unbound.message, /未绑定/);
  assert.equal(unbound.message.includes(KEY), false);
  assert.equal(scrub(`see ${SECRET}`, [SECRET]).includes(SECRET), false);
  const ready = await resolveWebsocket({
    config: { deviceId: 'aa', clientId: 'bb' },
    credentials: null,
    apiKey: null,
  }, { otaFn: async () => ({ websocket: { url: 'wss://xrobo-io.qiniuapi.com/v1/ws/', token: 'tok' } }) });
  assert.equal(ready.credentials.token, 'tok');
  const reused = await resolveWebsocket(ready, { otaFn: async () => { throw new Error('should not run'); } });
  assert.equal(reused.credentials.token, 'tok');
  assert.throws(() => loadSpeakCredentials({
    env: env({ LINX_DEVICE_JSON: '{}', LINX_API_KEY: KEY }),
    readFile,
  }), error => {
    assert.match(error.message, /deviceId/);
    assert.equal(error.message.includes(KEY), false);
    return true;
  });
});
