import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { deviceConfig, ota } from './linx-config.mjs';
import { createGame, advance, view } from './game.mjs';
import { connectLinx } from './linx.mjs';
import { createMixinLink } from './mixin-link.mjs';
import { createAudioLane } from './mixin-lane.mjs';
import { createMixinHub } from './mixin-http.mjs';
import { createTextSession } from './mixin-session.mjs';
import { createVoiceSession } from './mixin-live.mjs';

const assets = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'],
  '/audio.js': ['audio.js', 'text/javascript'],
  '/recorder.js': ['recorder.js', 'text/javascript'],
  '/mixin': ['mixin/index.html', 'text/html'],
  '/mixin/': ['mixin/index.html', 'text/html'],
  '/mixin/index.html': ['mixin/index.html', 'text/html'],
  '/mixin/app.js': ['mixin/app.js', 'text/javascript'],
  '/mixin/style.css': ['mixin/style.css', 'text/css'],
  '/mixin/audio.js': ['mixin/audio.js', 'text/javascript'],
  '/mixin/logic.js': ['mixin/logic.js', 'text/javascript'],
};

const speechTypes = {
  '.wav': 'audio/wav',
  '.mxop': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
};

function speechAsset(speechDir, pathname) {
  const match = /^\/mixin\/audio\/([A-Za-z0-9][A-Za-z0-9._-]{0,80})$/.exec(pathname);
  if (!match) return null;
  const name = match[1];
  const type = speechTypes[path.extname(name).toLowerCase()];
  if (!type) return null;
  const root = path.resolve(speechDir);
  const file = path.resolve(root, name);
  if (file !== path.join(root, name)) return null;
  return { file, type };
}

async function imageAssetFile(dir, name) {
  const root = await realpath(dir);
  const file = await realpath(path.join(root, name));
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return file;
}

export function createApp({ loadConfig = deviceConfig, getOta = ota, openVoice = connectLinx, mixinCredentials = null, openAudioLink = null, audioDir = null, assetDir = null, log = console.log, presynthCatalog = undefined } = {}) {
  const sessions = new Map();
  const speechDir = audioDir ?? fileURLToPath(new URL('./public/mixin/audio/', import.meta.url));
  let audioLane = null;
  if (mixinCredentials?.credentials?.url && mixinCredentials?.credentials?.token) {
    audioLane = createAudioLane({
      dir: speechDir,
      log,
      catalog: presynthCatalog,
      openLink: openAudioLink ?? (() => createMixinLink({
        config: mixinCredentials.config,
        credentials: mixinCredentials.credentials,
      })),
    });
    audioLane.warmupBackground();
  }
  const mixin = createMixinHub({
    createSession: createTextSession,
    selectSession(session) {
      if (!audioLane || session.game.phase !== 'lobby') return session;
      const game = session.game;
      const options = { ...game.options, now: session.now() };
      // 开局才分配通道：打开页面、停留大厅都不占用语音。
      if (audioLane.mode === 'game') {
        const text = createTextSession(options, game);
        text.notice = '语音通道正被其他玩家使用，本局已自动切换为纯文字模式，无需等待。';
        return text;
      }
      return createVoiceSession({ options, game, lane: audioLane, audioDir: speechDir });
    },
  });
  let active = null;
  const sidOf = req => /(?:^|;\s*)counter=([a-f0-9-]+)/.exec(req.headers.cookie ?? '')?.[1];
  const server = http.createServer(async (req, res) => {
    const json = (status, value, extra = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(value)); };
    try {
      if (!['localhost', '127.0.0.1'].includes((req.headers.host ?? '').split(':')[0])) return json(403, { error: '只接受本机访问。' });
      const path = new URL(req.url, 'http://localhost').pathname;
      if (['GET', 'HEAD'].includes(req.method) && path.startsWith('/mixin/assets/')) {
        let name;
        try { name = decodeURIComponent(path.slice('/mixin/assets/'.length)); }
        catch { return json(404, { error: '没有这个资源。' }); }
        if (!name || name.includes('\\') || name.split('/').some(part => part === '..' || part === '') || name.includes('\0') || /^[A-Za-z]:/.test(name)) return json(404, { error: '没有这个资源。' });
        const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.avif': 'image/avif' };
        const type = types[name.slice(name.lastIndexOf('.')).toLowerCase()];
        if (!type) return json(404, { error: '没有这个资源。' });
        try {
          const file = await imageAssetFile(assetDir ?? fileURLToPath(new URL('./public/mixin/assets/', import.meta.url)), name);
          if (!file) return json(404, { error: '没有这个资源。' });
          const data = await readFile(file);
          res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(data.length), 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' });
          return res.end(req.method === 'HEAD' ? undefined : data);
        } catch (error) {
          if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return json(404, { error: '没有这个资源。' });
          throw error;
        }
      }

      if (req.method === 'GET' && Object.hasOwn(assets, path)) {
        const [file, type] = assets[path];
        const data = await readFile(new URL(`./public/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; worker-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'" });
        return res.end(data);
      }
      if (req.method === 'GET') {
        const speech = speechAsset(speechDir, path);
        if (speech) {
          try {
            const data = await readFile(speech.file);
            res.writeHead(200, { 'Content-Type': speech.type, 'Content-Length': String(data.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            return res.end(data);
          } catch (error) {
            if (error?.code === 'ENOENT') return json(404, { error: '没有这段音频。' });
            throw error;
          }
        }
      }
      if (path === '/api/health' && req.method === 'GET') return json(200, { ok: true, provider: 'Linx' });
      if (path === '/api/mixin' || path.startsWith('/api/mixin/')) {
        if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(403, { error: '请求来源不合法。' });
        if (req.method !== 'GET' && req.method !== 'POST') return json(404, { error: '未找到接口。' });
        let body = '';
        if (req.method === 'POST') {
          const limit = /^\/api\/mixin\/[0-9a-f-]+\/transcribe$/.test(path) ? 1284096 : 4096;
          for await (const chunk of req) { body += chunk; if (body.length > limit) throw new Error('请求内容过大。'); }
        }
        if (path.startsWith('/api/mixin/')) {
          const id = path.split('/')[3];
          const cookie = /(?:^|;\s*)mixin=([0-9a-f-]+)/.exec(req.headers.cookie ?? '')?.[1];
          if (!cookie || cookie !== id) return json(409, { error: '这局不属于当前会话。' });
        }
        const clipMatch = /^\/api\/mixin\/([0-9a-f-]+)\/clip\/([0-9a-f-]+)$/.exec(path);
        if (clipMatch && req.method === 'GET') {
          const wav = mixin.clip(clipMatch[1], clipMatch[2]);
          if (!wav) return json(404, { error: '没有这段音频。' });
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(wav.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return res.end(wav);
        }
        const result = await mixin.dispatch({ method: req.method, path, body: body ? JSON.parse(body) : {} });
        return json(result.status, result.payload, result.headers ?? {});
      }
      let sid = sidOf(req);
      let session = sessions.get(sid);
      for (const [key, s] of sessions) if (Date.now() - s.updated > 60 * 60 * 1000 && s !== active?.session) sessions.delete(key);
      if (path === '/api/game' && req.method === 'GET') return json(200, { game: session ? view(session.game) : null });
      if (req.method !== 'POST' || !['/api/game', '/api/next', '/api/connect', '/api/activation'].includes(path)) return json(404, { error: '未找到接口。' });
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(403, { error: '请求来源不合法。' });
      if (path === '/api/activation') {
        const config = await loadConfig(); const result = await getOta(config);
        return json(200, { bound: !!result.websocket?.token, code: result.activation?.code ?? null });
      }
      if (path === '/api/game') {
        if (active && active.session === session) { const previous = active; active = null; previous.bridge?.close(); previous.client.close(); }
        sid = sid ?? randomUUID(); session = { game: createGame(), updated: Date.now(), ticket: null }; sessions.set(sid, session);
        return json(201, { game: view(session.game) }, { 'Set-Cookie': `counter=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600` });
      }
      if (!session) return json(409, { error: '请先开始新一局。' });
      session.updated = Date.now();
      if (path === '/api/next') {
        let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)throw new Error('请求内容过大。');}
        const input=JSON.parse(body||'{}');
        const game = advance(session.game,input.revision);
        if (active && active.session === session) { const previous = active; active = null; previous.bridge?.close(); previous.client.close(); }
        session.ticket = null;
        return json(200, { game });
      }
      if (!['playing','reporting'].includes(session.game.status)) return json(409, { error: '测评已经结束，请重新开始。' });
      const config = await loadConfig(); const result = await getOta(config);
      if (!result.websocket?.token) return json(409, { error: '测试设备尚未绑定 Linx，请先绑定。', activation: result.activation?.code });
      if (active) { const previous = active; active = null; previous.bridge?.close(); previous.client.close(); }
      session.ticket = { value: randomUUID(), config, credentials: result.websocket, until: Date.now() + 30000 };
      return json(200, { ticket: session.ticket.value });
    } catch (error) { return json(400, { error: error.message }); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  server.on('upgrade', (req, socket, head) => {
    if (audioLane) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    const url = new URL(req.url, 'http://localhost');
    const session = sessions.get(sidOf(req));
    const ticket = session?.ticket;
    if (url.pathname !== '/voice' || req.headers.origin !== `http://${req.headers.host}` || !ticket || ticket.value !== url.searchParams.get('ticket') || ticket.until < Date.now()) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    session.ticket = null;
    wss.handleUpgrade(req, socket, head, client => {
      const handle = { session, client, bridge: null };
      active = handle;
      try { handle.bridge = openVoice({ ...ticket, game: session.game, client, onClose: () => { if (active === handle) active = null; } }); }
      catch { if(active === handle)active=null; client.close(1011,'Linx连接参数无效'); }
    });
  });
  server.on('close', () => { active?.bridge?.close(); audioLane?.close(); wss.close(); });
  server.audioLane = audioLane;
  return server;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/server.mjs') || process.argv[1] === 'server.mjs') createApp().listen(Number(process.env.PORT ?? 4173), '127.0.0.1', () => console.log('人类模型测评站 · http://127.0.0.1:4173'));
