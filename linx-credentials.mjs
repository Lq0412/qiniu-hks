// 真机凭据只从环境变量或本机 .linx-device.json 进入内存。
// 报错不带回 JSON、令牌、API key 或设备号。

import { readFileSync } from 'node:fs';
import { ota as defaultOta } from './linx-config.mjs';

const MISSING = '没有找到灵矽设备配置。请设置 LINX_DEVICE_JSON（JSON 内容或文件路径），或在本机放置 .linx-device.json。';
const INCOMPLETE = '环境变量凭据不完整。请同时提供 LINX_WS_URL、LINX_WS_TOKEN、LINX_DEVICE_ID、LINX_CLIENT_ID，或改用 LINX_DEVICE_JSON / .linx-device.json。';

export function scrub(message, secrets = []) {
  let text = String(message ?? '灵矽请求失败');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) text = text.split(secret).join('[redacted]');
  }
  return text;
}

function parseDevice(text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('设备配置不是合法 JSON。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('设备配置不是合法 JSON。');
  const deviceId = typeof parsed.deviceId === 'string' ? parsed.deviceId.trim() : '';
  const clientId = typeof parsed.clientId === 'string' ? parsed.clientId.trim() : '';
  if (!deviceId || !clientId) throw new Error('设备配置缺少 deviceId 或 clientId。');
  return {
    deviceId,
    clientId,
    url: typeof parsed.url === 'string' ? parsed.url.trim() : '',
    token: typeof parsed.token === 'string' ? parsed.token.trim() : '',
    apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '',
  };
}

function readText(readFile, target) {
  try { return readFile(target, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('设备配置无法读取。');
  }
}

export function loadDeviceConfig({ env = process.env, readFile = readFileSync, fallbackPath } = {}) {
  const raw = env.LINX_DEVICE_JSON;
  if (typeof raw === 'string' && raw.trim()) {
    const text = raw.trim();
    if (text.startsWith('{')) return { ...parseDevice(text), source: 'env' };
    const fileText = readText(readFile, text);
    if (fileText == null) throw new Error('LINX_DEVICE_JSON 指向的设备文件无法读取。');
    return { ...parseDevice(fileText), source: 'env' };
  }
  const path = fallbackPath ?? new URL('./.linx-device.json', import.meta.url);
  const fileText = readText(readFile, path);
  if (fileText == null) throw new Error(MISSING);
  return { ...parseDevice(fileText), source: 'file' };
}

function trimmed(env, key) {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function loadSpeakCredentials(options = {}) {
  const env = options.env ?? process.env;
  const apiKey = trimmed(env, 'LINX_API_KEY');
  const wsUrl = trimmed(env, 'LINX_WS_URL');
  const wsToken = trimmed(env, 'LINX_WS_TOKEN');
  const envDevice = trimmed(env, 'LINX_DEVICE_ID');
  const envClient = trimmed(env, 'LINX_CLIENT_ID');
  const direct = [wsUrl, wsToken, envDevice, envClient];
  const directCount = direct.filter(Boolean).length;
  if (directCount === 4 && !trimmed(env, 'LINX_DEVICE_JSON')) {
    return {
      config: { deviceId: envDevice, clientId: envClient },
      credentials: { url: wsUrl, token: wsToken },
      apiKey: apiKey || null,
      source: 'env',
    };
  }
  if (directCount > 0 && directCount < 4 && !trimmed(env, 'LINX_DEVICE_JSON')) {
    try {
      const device = loadDeviceConfig(options);
      return pack(device, apiKey, wsUrl, wsToken, envDevice, envClient);
    } catch {
      throw new Error(INCOMPLETE);
    }
  }
  const device = loadDeviceConfig(options);
  return pack(device, apiKey, wsUrl, wsToken, envDevice, envClient);
}

function pack(device, apiKey, wsUrl, wsToken, envDevice, envClient) {
  const url = wsUrl || device.url || '';
  const token = wsToken || device.token || '';
  return {
    config: { deviceId: envDevice || device.deviceId, clientId: envClient || device.clientId },
    credentials: url && token ? { url, token } : null,
    apiKey: apiKey || device.apiKey || null,
    source: device.source,
  };
}

export async function resolveWebsocket(loaded, { otaFn = defaultOta, fetcher } = {}) {
  if (!loaded?.config?.deviceId || !loaded?.config?.clientId) throw new Error(MISSING);
  if (loaded.credentials?.url && loaded.credentials?.token) return loaded;
  const secrets = [loaded.apiKey, loaded.config.deviceId, loaded.config.clientId];
  let data;
  try { data = await otaFn(loaded.config, fetcher); }
  catch (error) { throw new Error(scrub(error?.message || 'OTA 失败', secrets)); }
  const url = data?.websocket?.url;
  const token = data?.websocket?.token;
  if (typeof url !== 'string' || !url || typeof token !== 'string' || !token) throw new Error('设备未绑定或没有返回语音地址。');
  return { ...loaded, credentials: { url, token } };
}
