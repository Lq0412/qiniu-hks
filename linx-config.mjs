import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';

export async function deviceConfig(path = new URL('./.linx-device.json', import.meta.url)) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const bytes = randomBytes(6); bytes[0] = 2;
    const config = { deviceId: [...bytes].map(b => b.toString(16).padStart(2, '0')).join(':').toUpperCase(), clientId: randomUUID() };
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    return config;
  }
}

// 应用名和 elf 摘要先保持 counter-game。真机确认改名不影响设备绑定之前，不要改这两个默认值。
// 试跑覆盖：LINX_APP_NAME、LINX_APP_ELF_SHA256，或设备配置里的 applicationName、elfSha256。
const DEFAULT_APP_NAME = 'counter-game';
const DEFAULT_APP_ELF_SHA256 = 'counter-game-local';

function textOr(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  return text || fallback;
}

export function otaApplication(config = {}, env = process.env) {
  return {
    name: textOr(config.applicationName, textOr(env.LINX_APP_NAME, DEFAULT_APP_NAME)),
    version: '1.0.0',
    elf_sha256: textOr(config.elfSha256, textOr(env.LINX_APP_ELF_SHA256, DEFAULT_APP_ELF_SHA256)),
  };
}

export async function ota(config, fetcher = fetch, env = process.env) {
  const response = await fetcher('https://xrobo.qiniuapi.com/v1/ota/', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', 'Activation-Version': '1', 'Device-Id': config.deviceId, 'Client-Id': config.clientId, 'User-Agent': 'who-is-human/1.0.0' },
    body: JSON.stringify({ version: 0, uuid: config.clientId, mac_address: config.deviceId, application: otaApplication(config, env), board: { type: 'xiaoling-web-test', ssid: 'local', rssi: 0, mac: config.deviceId } }),
  });
  if (!response.ok) throw new Error(`Linx OTA 返回 ${response.status}`);
  return response.json();
}
