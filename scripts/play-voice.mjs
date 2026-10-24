// 启动一局能在浏览器里玩完的语音版。凭据只从环境变量或 .linx-device.json 读取。
//
//   export LINX_DEVICE_JSON='{"deviceId":"<设备号>","clientId":"<客户端号>"}'
//   export LINX_API_KEY='<API key>'
//   npm run play:voice
//
// 打开 http://127.0.0.1:4173/mixin
// 玩家在输入框打字，然后点确认。按住说话不会把录音送进这一局。
// 没有凭据时自动退回文字版，仍然打开同一个网址。

import { createApp } from '../server.mjs';
import { loadSpeakCredentials, resolveWebsocket } from '../linx-credentials.mjs';

export async function startVoiceServer({
  env = process.env,
  readFile,
  log = console.log,
  port = Number(env.PORT ?? 4173),
  resolve = resolveWebsocket,
  makeApp = createApp,
} = {}) {
  let loaded = null;
  try {
    loaded = await resolve(await loadSpeakCredentials({ env, readFile }));
  } catch (error) {
    const message = typeof error?.message === 'string' && error.message ? error.message : '没有找到灵矽设备配置。';
    log(message);
    log('没有凭据，已退回文字版。');
  }
  const server = makeApp(loaded ? { mixinCredentials: loaded } : {});
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', ok);
  });
  const actual = server.address().port;
  const page = `http://127.0.0.1:${actual}/mixin`;
  if (loaded) {
    log(`语音版：${page}`);
    log('玩家在页面输入框打字，然后点确认。按住说话不会把录音送进这一局。');
    log('需要 LINX_DEVICE_JSON（JSON 正文或文件路径）和 LINX_API_KEY，或仓库根目录的 .linx-device.json。');
    log('也可以同时设置 LINX_WS_URL、LINX_WS_TOKEN、LINX_DEVICE_ID、LINX_CLIENT_ID 跳过 OTA。');
    log('第一次启动会在后台预合成群主台词，大约 90 秒，不挡住开局。没合成好时群主走实时合成。揭晓音效由浏览器现做。');
    log('请用 Node 24。浏览器要允许这个页面播放声音。');
  } else {
    log(`文字版：${page}`);
    log('玩家在输入框打字，然后点确认。');
  }
  return { server, mode: loaded ? 'voice' : 'text', port: actual };
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/play-voice.mjs')) {
  await startVoiceServer();
}
