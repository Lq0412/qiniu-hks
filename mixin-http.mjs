// 文字模式的 HTTP 入口。和旧测评的 /api/game、/voice 分开，不读取灵矽凭据。

import { randomUUID } from 'node:crypto';
import { MixinError } from './mixin-game.mjs';
import { createTextSession } from './mixin-session.mjs';

export function createMixinHub() {
  const sessions = new Map();
  return {
    sessions,
    async dispatch({ method, path, body = {} }) {
      if (method === 'POST' && path === '/api/mixin') return create(sessions, body);
      const match = /^\/api\/mixin\/([0-9a-f-]+)(?:\/([a-z]+))?$/.exec(path);
      if (!match) return { status: 404, payload: { error: '未找到接口。' } };
      const session = sessions.get(match[1]);
      if (!session) return { status: 404, payload: { error: '没有这一局。' } };
      if (Number.isFinite(body.now)) session.setNow(body.now);
      const action = match[2] ?? (method === 'GET' ? 'view' : '');
      try {
        if (method === 'GET' && action === 'view') return ok(session);
        if (method !== 'POST') return { status: 404, payload: { error: '未找到接口。' } };
        if (action === 'start') return done(session, session.start());
        if (action === 'text') return done(session, session.say(body.text, body));
        if (action === 'confirm') return done(session, session.confirm(body.revision));
        if (action === 'vote') return done(session, session.vote(body.seat));
        if (action === 'interrupt') return done(session, session.interrupt(body.text));
        if (action === 'hint') return done(session, session.hint());
        if (action === 'step') return done(session, await session.step());
        if (action === 'tick') return done(session, Number.isFinite(body.now) ? session.tickTo(body.now) : session.tick(body.ms ?? 0));
        return { status: 404, payload: { error: '未找到接口。' } };
      } catch (error) {
        if (error instanceof MixinError) return { status: 409, payload: { error: error.message, game: session.view() } };
        throw error;
      }
    },
  };
}

function create(sessions, body) {
  const id = randomUUID();
  const session = createTextSession(body ?? {});
  sessions.set(id, session);
  return {
    status: 201,
    payload: { id, game: session.view() },
    headers: { 'Set-Cookie': `mixin=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600` },
  };
}

function ok(session) {
  return { status: 200, payload: { game: session.view() } };
}

function done(session, result) {
  const game = result?.view ?? result?.game ?? session.view();
  return { status: 200, payload: { ...result, game } };
}
