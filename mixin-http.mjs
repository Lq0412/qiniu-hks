// 文字模式的 HTTP 入口。和旧测评的 /api/game、/voice 分开，不读取灵矽凭据。

import { randomUUID } from 'node:crypto';
import { MixinError } from './mixin-game.mjs';
import { createTextSession } from './mixin-session.mjs';

const CREATE_FIELDS = new Set(['demo', 'difficulty', 'seed', 'sceneId', 'cardIds', 'roleIds', 'alias']);
const SESSION_TTL_MS = 60 * 60 * 1000;

export function createMixinHub({ now = Date.now, ttlMs = SESSION_TTL_MS } = {}) {
  const sessions = new Map();
  const sweep = () => {
    const clock = now();
    for (const [id, session] of sessions) {
      if (clock - session.updated > ttlMs) sessions.delete(id);
    }
  };
  return {
    sessions,
    async dispatch({ method, path, body = {} }) {
      sweep();
      if (method === 'POST' && path === '/api/mixin') return create(sessions, body, now);
      const match = /^\/api\/mixin\/([0-9a-f-]+)(?:\/([a-z]+))?$/.exec(path);
      if (!match) return { status: 404, payload: { error: '未找到接口。' } };
      const session = sessions.get(match[1]);
      if (!session) return { status: 404, payload: { error: '没有这一局。' } };
      session.updated = now();
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
        if (action === 'restart') return done(session, session.restart());
        if (action === 'tick') return done(session, tick(session, body));
        return { status: 404, payload: { error: '未找到接口。' } };
      } catch (error) {
        if (error instanceof MixinError) return { status: 409, payload: { error: error.message, game: session.view() } };
        throw error;
      }
    },
  };
}

function createOptions(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) throw new MixinError('建局参数不合法。');
  for (const key of Object.keys(body)) {
    if (!CREATE_FIELDS.has(key)) throw new MixinError(`不能使用字段 ${key}。`);
  }
  if ('demo' in body && typeof body.demo !== 'boolean') throw new MixinError('demo 必须是布尔值。');
  if ('difficulty' in body && !['easy', 'normal', 'hell'].includes(body.difficulty)) throw new MixinError('未知难度。');
  if ('seed' in body && !Number.isInteger(body.seed)) throw new MixinError('seed 必须是整数。');
  if ('sceneId' in body && typeof body.sceneId !== 'string') throw new MixinError('未知场景。');
  if ('cardIds' in body && !Array.isArray(body.cardIds)) throw new MixinError('话题卡不合法。');
  if ('roleIds' in body && !Array.isArray(body.roleIds)) throw new MixinError('角色不合法。');
  if ('alias' in body && typeof body.alias !== 'string') throw new MixinError('代号不合法。');
  return body;
}

function tick(session, body) {
  if (Object.hasOwn(body, 'now')) {
    if (!Number.isInteger(body.now)) throw new MixinError('时间不合法。');
    if (body.now < session.now()) throw new MixinError('时间不能倒退。');
    return session.tickTo(body.now);
  }
  const ms = body.ms ?? 0;
  if (!Number.isInteger(ms) || ms < 0 || ms > 120000) throw new MixinError('推进步长不合法。');
  return session.tick(ms);
}

function create(sessions, body, now) {
  try {
    const options = createOptions(body ?? {});
    const id = randomUUID();
    const session = createTextSession(options);
    session.updated = now();
    sessions.set(id, session);
    return {
      status: 201,
      payload: { id, game: session.view() },
      headers: { 'Set-Cookie': `mixin=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600` },
    };
  } catch (error) {
    if (error instanceof MixinError) return { status: 409, payload: { error: error.message } };
    throw error;
  }
}

function ok(session) {
  return { status: 200, payload: { game: session.view() } };
}

function done(session, result) {
  const game = result?.view ?? result?.game ?? session.view();
  return { status: 200, payload: { ...result, game } };
}
