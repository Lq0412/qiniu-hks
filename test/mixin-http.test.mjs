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
    const post = (path, body, origin = base) => fetch(`${base}${path}`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const created = await post('/api/mixin', { demo: true, seed: 1 });
    assert.equal(created.status, 201);
    assert.match(created.headers.get('set-cookie'), /mixin=/);
    const { id, game } = await created.json();
    assert.equal(game.stage, 'lobby');
    assert.equal(game.playerAlias, '碳基-7B');
    const act = async (action, body) => {
      const response = await post(`/api/mixin/${id}/${action}`, body);
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      return data.game;
    };
    assert.equal((await (await fetch(`${base}/api/mixin/${id}`)).json()).game.phase, 'lobby');
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
      if (state.phase === 'accuse' && !interruptDone && state.cue?.kind === 'accuse' && state.script.some(item => item.done)) {
        state = await act('interrupt', { text: script.interrupt });
        interruptDone = true;
        continue;
      }
      state = state.cue ? await act('step') : await act('tick', { ms: 1000 });
    }
    assert.equal(state.phase, 'result');
    assert.equal(state.report.outcome, '被识破');
    assert.equal(opened, 0);
    assert.equal((await post('/api/game')).status, 201);
    assert.equal((await fetch(`${base}/api/mixin/missing`)).status, 404);
    assert.equal((await post('/api/mixin', { demo: true }, 'https://evil.test')).status, 403);
    assert.equal((await post(`/api/mixin/${id}/nope`, {})).status, 404);
    assert.equal((await post(`/api/mixin/${id}/confirm`, { revision: 1 })).status, 409);
    assert.equal((await fetch(`${base}/api/mixin/${id}/start`, { method: 'PUT', headers: { origin: base } })).status, 404);
    assert.equal((await fetch(`${base}/api/mixin`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{' })).status, 400);
    const clock = await act('tick', { now: 1 });
    assert.equal(clock.phase, 'result');
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
});
