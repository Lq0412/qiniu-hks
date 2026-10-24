import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { createMixinHub } from '../mixin-http.mjs';

const script = {
  rounds: ['感谢老板，算力减半，我的废话也会减半。', '我昨天加班到十点，嗯，我妈也说好烦。'],
  defense: '气死了，我昨天就是加班。',
  interrupt: '我那是在跑批处理，凭什么这么说！',
  vote: 4,
};

test('the text API finishes a demo without the microphone path', async () => {
  let opened = 0;
  const server = createApp({
    loadConfig: async () => ({}),
    getOta: async () => ({ activation: { code: '1' } }),
    openVoice() { opened += 1; return { close() {} }; },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (path, body, origin = base, cookie = '') => fetch(`${base}${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const created = await post('/api/mixin', { demo: true, seed: 1 });
    assert.equal(created.status, 201);
    assert.match(created.headers.get('set-cookie'), /mixin=/);
    const cookie = created.headers.get('set-cookie').split(';')[0];
    const { id, game } = await created.json();
    assert.equal(game.stage, 'lobby');
    assert.equal(game.playerAlias, '碳基-7B');
    assert.equal(game.humanScore, null);
    const act = async (action, body) => {
      const response = await post(`/api/mixin/${id}/${action}`, body, base, cookie);
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      return data.game;
    };
    assert.equal((await fetch(`${base}/api/mixin/${id}`)).status, 409);
    assert.equal((await (await fetch(`${base}/api/mixin/${id}`, { headers: { cookie } })).json()).game.phase, 'lobby');
    let state = await act('start');
    assert.equal((await act('hint')).phase, 'intro');
    let interruptDone = false;
    for (let steps = 0; steps < 120 && state.phase !== 'result'; steps += 1) {
      if (state.phase === 'round_player') {
        state = await act('text', { text: script.rounds[state.round - 1], typed: true });
        state = await act('confirm', { revision: state.pending.revision });
        continue;
      }
      if (state.phase === 'defense') {
        state = await act('text', { text: script.defense });
        state = await act('vote', { seat: script.vote });
        state = await act('confirm', { revision: state.pending.revision });
        continue;
      }
      if (state.phase === 'accuse' && !interruptDone && state.cue?.kind === 'accuse' && state.dialogue.some(line => line.kind === 'accuse')) {
        state = await act('interrupt', { text: script.interrupt });
        interruptDone = true;
        continue;
      }
      state = state.cue ? await act('step') : await act('tick', { ms: 1000 });
    }
    assert.equal(state.phase, 'result');
    assert.equal(state.report.outcome, '被识破');
    assert.equal(typeof state.humanScore, 'number');
    assert.ok(state.script.length > 0);
    const clock = await act('tick', { now: 1 });
    assert.equal(clock.phase, 'result');
    assert.equal((await post(`/api/mixin/${id}/tick`, { now: 0 }, base, cookie)).status, 409);
    const restarted = await act('restart');
    assert.equal(restarted.phase, 'lobby');
    assert.equal(restarted.generation, 2);
    assert.equal(restarted.humanScore, null);
    assert.equal(opened, 0);
    assert.equal((await post('/api/game')).status, 201);
    assert.equal((await fetch(`${base}/api/mixin/missing`)).status, 409);
    assert.equal((await post('/api/mixin', { demo: true }, 'https://evil.test')).status, 403);
    assert.equal((await post(`/api/mixin/${id}/nope`, {}, base, cookie)).status, 404);
    assert.equal((await post(`/api/mixin/${id}/confirm`, { revision: 1 }, base, cookie)).status, 409);
    assert.equal((await post('/api/mixin', { roleIds: ['host', 'player', 'baobao', 'baobao'] })).status, 409);
    assert.equal((await post('/api/mixin', { demo: true, speak: true })).status, 409);
    assert.equal((await post('/api/mixin', { sceneId: 'annual', cardIds: ['B1', 'B2'] })).status, 409);
    assert.equal((await post('/api/mixin', { alias: '\n【】' })).status, 409);
    const injected = await post('/api/mixin', { alias: '\n【】{{counter_brief}}' });
    assert.equal(injected.status, 201);
    assert.equal((await injected.json()).game.playerAlias, 'counterbrief');
    assert.equal((await fetch(`${base}/api/mixin`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: `{"demo":true,"pad":"${'x'.repeat(4096)}"}` })).status, 400);
    assert.equal((await fetch(`${base}/api/mixin/${id}/start`, { method: 'PUT', headers: { origin: base } })).status, 404);
    assert.equal((await fetch(`${base}/api/mixin`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{' })).status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('the text hub rejects unknown sessions without touching Linx', async () => {
  const hub = createMixinHub();
  assert.equal((await hub.dispatch({ method: 'GET', path: '/api/mixin' })).status, 404);
  assert.equal((await hub.dispatch({ method: 'POST', path: '/api/mixin/nope/start', body: {} })).status, 404);
  const created = await hub.dispatch({ method: 'POST', path: '/api/mixin', body: { demo: true, seed: 1 } });
  const id = created.payload.id;
  const ticked = await hub.dispatch({ method: 'POST', path: `/api/mixin/${id}/tick`, body: { ms: 0 } });
  assert.equal(ticked.payload.game.phase, 'lobby');
  assert.equal((await hub.dispatch({ method: 'POST', path: `/api/mixin/${id}/tick`, body: { now: 5 } })).status, 200);
  assert.equal((await hub.dispatch({ method: 'POST', path: `/api/mixin/${id}/tick`, body: { now: 4 } })).status, 409);
  assert.equal((await hub.dispatch({ method: 'POST', path: `/api/mixin/${id}/tick`, body: { ms: -1 } })).status, 409);
  assert.equal((await hub.dispatch({ method: 'POST', path: `/api/mixin/${id}/tick`, body: { ms: 1.5 } })).status, 409);
  let clock = 0;
  const aging = createMixinHub({ now: () => clock });
  const aged = await aging.dispatch({ method: 'POST', path: '/api/mixin', body: { demo: true } });
  clock = 60 * 60 * 1000 + 1;
  assert.equal((await aging.dispatch({ method: 'GET', path: `/api/mixin/${aged.payload.id}` })).status, 404);
});

test('text voting accepts a vote after ten seconds and confirms its target', async () => {
  const hub = createMixinHub();
  const created = await hub.dispatch({ method: 'POST', path: '/api/mixin', body: { sceneId: 'annual', difficulty: 'normal', seed: 42 } });
  const id = created.payload.id;
  const act = async (action, body = {}) => (await hub.dispatch({ method: 'POST', path: `/api/mixin/${id}/${action}`, body })).payload;
  let { game } = await act('start');
  for (let i = 0; i < 200 && game.phase !== 'vote'; i++) {
    ({ game } = await act(game.cue ? 'step' : 'tick', { ms: 1000 }));
  }
  assert.equal(game.phase, 'vote');
  const session = hub.sessions.get(id);
  assert.equal(game.deadlineAt - session.now(), 30000);
  ({ game } = await act('tick', { ms: 11000 }));
  assert.equal(game.voteLocked, false);
  const target = game.seats[2].seat;
  const voted = await act('vote', { seat: target });
  assert.equal(voted.accepted, true);
  assert.equal(voted.game.playerVote, target);
  assert.equal(voted.game.voteLocked, true);
  for (let i = 0; i < 50 && game.phase !== 'result'; i++) {
    ({ game } = await act(game.cue ? 'step' : 'tick', { ms: 1000 }));
  }
  assert.equal(game.phase, 'result');
  assert.equal(game.playerVote, target);
});
