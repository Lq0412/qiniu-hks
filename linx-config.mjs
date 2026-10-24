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

export async function ota(config, fetcher = fetch) {
  const response = await fetcher('https://xrobo.qiniuapi.com/v1/ota/', {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', 'Activation-Version': '1', 'Device-Id': config.deviceId, 'Client-Id': config.clientId, 'User-Agent': 'counter-game/1.0.0' },
    body: JSON.stringify({ version: 0, uuid: config.clientId, mac_address: config.deviceId, application: { name: 'counter-game', version: '1.0.0', elf_sha256: 'counter-game-local' }, board: { type: 'xiaoling-web-test', ssid: 'local', rssi: 0, mac: config.deviceId } }),
  });
  if (!response.ok) throw new Error(`Linx OTA 返回 ${response.status}`);
  return response.json();
}
