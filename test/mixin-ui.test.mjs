import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../server.mjs';
import { DIFFICULTY } from '../humanity.mjs';
import { SCENES as BANK } from '../mixin-bank.mjs';
import { HOST, PLAYER_ALIASES, ROLES } from '../mixin-roles.mjs';
import {
  AI_CHIPS,
  ALIASES,
  CAST,
  CHARACTERS,
  characterOf,
  DIFFICULTIES,
  HOST_NAME,
  SCENES,
  autoIntent,
  ballotCards,
  caughtQuote,
  clipUrl,
  concealmentHolds,
  createBody,
  dockMode,
  friendlyError,
  hasEndingSpeech,
  orchestrate,
  paintShareCard,
  phaseLabel,
  randomAlias,
  readBeat,
  remainingMs,
  sanitizeView,
  screenOf,
  sessionRecord,
  shareCardLines,
  shareCardModel,
  speechPlay,
  speakingSeat,
  subtitleModel,
  tableSeats,
  topicModel,
  wrapText,
} from '../public/mixin/logic.js';
import * as audio from '../public/mixin/audio.js';

const rounds = [
  '作为一个语言模型，首先压缩上下文，其次希望对你有帮助。',
  '我昨天加班到十点，嗯，我妈也说好烦。',
];

test('pure helpers follow the public table and hide secrets before the reveal', () => {
  assert.deepEqual(CAST.map(item => item.name).sort(), [HOST.name, ...ROLES.map(role => role.name)].sort());
  assert.equal(HOST_NAME, HOST.name);
  assert.deepEqual(ALIASES, PLAYER_ALIASES);
  assert.deepEqual(SCENES.map(scene => scene.id), BANK.map(scene => scene.id));
  assert.deepEqual(SCENES.map(scene => scene.name), BANK.map(scene => scene.name));
  assert.deepEqual(SCENES.map(scene => scene.blurb), BANK.map(scene => scene.background));
  assert.deepEqual(DIFFICULTIES.map(item => [item.id, item.name]), Object.values(DIFFICULTY).map(item => [item.id, item.label]));
  assert.equal(randomAlias(() => 0), ALIASES[0]);
  assert.equal(randomAlias(() => 0.99), ALIASES.at(-1));
  assert.deepEqual(createBody({ sceneId: 'night', difficulty: 'hell', alias: '  熬夜-Pro  ', seed: 4 }), {
    demo: false, sceneId: 'night', difficulty: 'hell', alias: '熬夜-Pro', seed: 4,
  });
  assert.equal('alias' in createBody({ sceneId: 'annual', difficulty: 'easy', alias: '  ', seed: 1 }), false);

  const poisoned = sanitizeView({
    phase: 'round_ai',
    humanScore: 8,
    aiScore: 20,
    outcome: '被识破',
    script: [{ seat: 1, quote: '秘密剧本' }],
    report: { endingText: '不该出现', humanScore: 8 },
    votes: { onPlayer: 4, scapegoatSeat: 2, votes: [{ seat: 1, name: '柯老师', targetSeat: 5, targetName: '五号' }] },
    cards: [{ id: 'A2', prompt: '题面', examplePlayer: '不该提前看见' }],
    cue: { cueId: 'c1', kind: 'answer', seat: 1, roleId: 'claudia', name: '柯老师', fallbackText: '兜底', instruction: '舞台指令不要上屏', voice: { voiceId: 'v-claudia', secret: '不要留下' } },
    seats: [{ seat: 1, roleId: 'claudia', name: '柯老师', voice: { voiceId: 'voice-secret' } }],
    scene: { id: 'annual', name: '模型年会', background: '背景' },
    playerAlias: '碳基-7B',
    dialogue: [{ seat: 1, name: '柯老师', text: '需要说明的是', kind: 'answer', round: 1 }],
    brief: '局势里也许有结果',
  });
  assert.equal(concealmentHolds(poisoned), true);
  assert.equal(poisoned.humanScore, null);
  assert.equal(poisoned.aiScore, null);
  assert.equal(poisoned.report, null);
  assert.equal(poisoned.outcome, null);
  assert.deepEqual(poisoned.script, []);
  assert.equal(poisoned.votes, null);
  assert.equal(poisoned.cards[0].examplePlayer, undefined);
  assert.equal(poisoned.cards[0].prompt, '题面');
  assert.equal(poisoned.cue.fallbackText, undefined);
  assert.equal(poisoned.cue.instruction, undefined);
  assert.deepEqual(poisoned.cue.voice, { voiceId: 'v-claudia' });
  assert.deepEqual(speechPlay(poisoned.cue), { seat: 1, roleId: 'claudia', voiceId: 'v-claudia' });
  assert.equal(poisoned.seats[0].voice, undefined);
  assert.equal(poisoned.brief, undefined);
  assert.equal(hasEndingSpeech(poisoned), false);

  const revealed = sanitizeView({
    phase: 'reveal',
    humanScore: 6,
    aiScore: 40,
    outcome: '被识破',
    script: [],
    report: { endingText: '五号，你说「加班」。', title: '碳基泄漏', humanScore: 6, quote: '我昨天加班', leakQuote: '卧槽，这整句不该上分享卡。', bestAiQuote: '作为一整句模型发言也不该上分享卡。', outcome: '被识破', alias: '碳基-7B', scene: '模型年会' },
    votes: { votes: [{ seat: 2, name: '阿斯哥', targetSeat: 5, targetName: '五号' }], tally: { 5: 1 } },
    cards: [],
    seats: [],
    dialogue: [],
    scene: { id: 'annual', name: '模型年会', background: '背景' },
  });
  assert.equal(revealed.humanScore, 6);
  assert.equal(revealed.report.endingText.includes('加班'), true);
  assert.equal(screenOf(revealed), 'reveal');
  assert.equal(screenOf({ phase: 'lobby' }), 'lobby');
  assert.equal(screenOf({ phase: 'accuse' }), 'table');

  const table = {
    phase: 'round_player',
    round: 1,
    playerAlias: '摸鱼-mini',
    playerSeat: 5,
    note: '轮到你了，15 秒。',
    scene: { name: '模型年会', background: '年底述职' },
    cards: [{ id: 'A2', prompt: '老板宣布明年算力减半，请发表感言。' }],
    seats: [
      { seat: 1, roleId: 'claudia', name: '柯老师' },
      { seat: 2, roleId: 'astra', name: '阿斯哥' },
      { seat: 3, roleId: 'shensi', name: '深思哥' },
      { seat: 4, roleId: 'baobao', name: '包包' },
    ],
    dialogue: [{ seat: 4, name: '包包', text: '宝子，算力减半。', kind: 'answer' }],
    cue: null,
  };
  assert.equal(tableSeats(table).length, 5);
  assert.deepEqual(tableSeats(table).map(seat => seat.name), ['柯老师', '阿斯哥', '深思哥', '包包', '摸鱼-mini']);
  assert.equal(speakingSeat(table), 5);
  assert.equal(subtitleModel(table).text, '轮到你了，15 秒。');
  assert.equal(topicModel(table).prompt.includes('算力减半'), true);
  assert.equal(phaseLabel(table), '轮到你 · 第 1 轮');
  assert.equal(dockMode(table), 'speak');
  const thinking = { ...table, phase: 'round_ai', cue: { seat: 3, name: '深思哥', kind: 'answer' } };
  assert.equal(speakingSeat(thinking, { thinking: true }), 3);
  assert.equal(subtitleModel(thinking, { thinking: true }).text, '思考中…');
  assert.equal(ballotCards({ ...table, votes: { votes: [{ seat: 1, name: '柯老师', targetSeat: 5, targetName: '五号' }] } }).length, 0);
  const voting = { phase: 'vote', votes: { votes: [{ seat: 1, name: '柯老师', targetSeat: 4, targetName: '包包' }] } };
  assert.equal(ballotCards(voting)[0].targetName, '包包');
  assert.deepEqual(sessionRecord('abc', 20), { sessionId: 'abc', clock: 20 });
  assert.equal(Object.keys(sessionRecord('abc', 20)).join(), 'sessionId,clock');
  assert.equal(clipUrl({}), null);
  assert.equal(clipUrl({ audioUrl: '/clip.mp3' }), '/clip.mp3');
  assert.equal(clipUrl({ clip: { url: '/a.wav' } }), '/a.wav');
  assert.equal(clipUrl({ audioUrl: 3 }), null);
  assert.equal(friendlyError(403, { error: '请求来源不合法。' }), '只能在本机打开这一局。请用 127.0.0.1 访问。');
  assert.match(friendlyError(409, { error: '这局不属于当前会话。' }), /对不上/);
  assert.match(friendlyError(404, {}), /重新开局/);
  assert.equal(remainingMs(20000, 5000, 500), 14500);
  assert.equal(remainingMs(null, 0), null);
  assert.equal(readBeat('host_open', '短'), 2600);
  assert.ok(readBeat('host_open', '很'.repeat(120)) > 5000);
  assert.deepEqual(autoIntent({ phase: 'intro', cue: { kind: 'intro' } }, { holdRead: false }), { action: 'step', delay: 0 });
  assert.equal(autoIntent({ phase: 'round_player', cue: null }).action, 'tick');
  assert.equal(autoIntent({ phase: 'result' }).action, 'idle');
  assert.deepEqual(wrapText('一二三四五', 2), ['一二', '三四', '五']);
  assert.deepEqual(AI_CHIPS.length > 0, true);

  const player = { phase: 'round_player', round: 1, hintReleased: false, pending: null, cue: { kind: 'nudge' }, dialogue: [] };
  assert.equal(orchestrate(player, { wantHint: true, playerText: 'hello hello' }).action, 'hint');
  player.hintReleased = true;
  assert.deepEqual(orchestrate(player, { wantHint: true, playerText: 'hello hello' }), { action: 'text', text: 'hello hello', typed: true });
  player.pending = { text: 'hello hello', revision: 3 };
  assert.deepEqual(orchestrate(player, { playerText: 'hello hello' }), { action: 'confirm', revision: 3 });
  const defense = { phase: 'defense', playerVote: null, voteLocked: false, pending: null };
  assert.deepEqual(orchestrate(defense, { voteSeat: 2, defenseText: '甩锅' }), { action: 'vote', seat: 2 });
  defense.playerVote = 2;
  assert.equal(orchestrate(defense, { voteSeat: 2, defenseText: '甩锅' }).action, 'text');
  const accuse = { phase: 'accuse', cue: { kind: 'accuse' }, dialogue: [{ kind: 'accuse' }] };
  assert.equal(orchestrate(accuse, { interruptText: '不是我', interruptUsed: false }).action, 'interrupt');
  assert.equal(orchestrate(accuse, { interruptText: '不是我', interruptUsed: true }).action, 'step');
  assert.equal(orchestrate({ phase: 'intro', cue: null }).action, 'tick');

  const model = shareCardModel(revealed);
  assert.equal(model.work, '谁是人类');
  assert.equal(model.title, '碳基泄漏');
  assert.equal(model.humanScore, 6);
  assert.equal(model.quote, '我昨天加班');
  assert.equal(caughtQuote({ leakQuote: '整句原话', bestAiQuote: '另一整句' }).text, '……');
  assert.equal(caughtQuote(revealed.report).label, '被抓住的那句');
  const raw = `卧槽${'今'.repeat(26)}`;
  assert.equal([...raw].length, 28);
  const swornCard = shareCardModel({
    phase: 'result',
    humanScore: 9,
    report: { quote: '（已和谐）', leakQuote: raw, bestAiQuote: raw, title: '一眼真人', humanScore: 9, outcome: '被识破', alias: '碳基-7B', scene: '模型年会', endingText: '你说「（已和谐）」。' },
  });
  assert.equal(swornCard.quote, '（已和谐）');
  assert.equal(shareCardLines(swornCard).some(line => line.text.includes(raw) || line.text.includes('卧槽')), false);
  const silentCard = shareCardModel({
    phase: 'result',
    humanScore: 0,
    report: { quote: '……', leakQuote: '我昨天加班到十点', bestAiQuote: '作为一个语言模型', title: '温度 0.0 的人类', humanScore: 0, outcome: '潜伏成功', alias: '摸鱼-mini', scene: '深夜客服值班室', endingText: '你说「……」。' },
  });
  assert.equal(silentCard.quote, '……');
  assert.equal(shareCardLines(silentCard).some(line => line.text.includes('我昨天') || line.text.includes('语言模型')), false);
  assert.equal(shareCardModel({ phase: 'vote', report: revealed.report }), null);
  const lines = shareCardLines(model);
  const painted = lines.map(line => line.text).join('\n');
  assert.match(painted, /谁是人类/);
  assert.match(painted, /碳基泄漏/);
  assert.match(painted, /6/);
  assert.match(painted, /我昨天加班/);
  assert.match(painted, /AI 味 40/);
  assert.equal(painted.includes('扫码'), false);
  assert.equal(painted.includes('二维码'), false);
  const long = shareCardLines({ ...model, quote: '加班'.repeat(40) });
  const longQuote = long.filter(line => line.role === 'quote').map(line => line.text);
  assert.equal(longQuote.length, 4);
  assert.equal(longQuote[3].endsWith('…'), true);
  const ops = [];
  const ctx = {
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    fillRect() { ops.push('fillRect'); },
    fillText(text) { ops.push(text); },
    drawImage() { ops.push('drawImage'); },
  };
  const card = paintShareCard(ctx, model);
  assert.equal(card.width, 1080);
  assert.equal(card.height, 1440);
  assert.equal(ops.includes('drawImage'), false);
  assert.equal(ops.includes('谁是人类'), true);
  assert.equal(ops.includes('碳基泄漏'), true);
  assert.equal(ops.includes('扫码'), false);
  assert.equal(lines.some(line => line.x < 0 || line.x > 1080 || line.y < 0 || line.y > 1440), false);
});

test('audio stubs stay empty and do not ask for a microphone', async () => {
  const appSource = await readFile(new URL('../public/mixin/app.js', import.meta.url), 'utf8');
  assert.match(appSource, /const cue = state\.game\?\.cue;[\s\S]*?speechPlay\(cue\)/);
  assert.equal(appSource.includes('payload.game?.cue'), false);
  const source = await readFile(new URL('../public/mixin/audio.js', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(code.includes('getUserMedia'), false);
  assert.equal(typeof audio.play, 'function');
  assert.equal(typeof audio.stop, 'function');
  assert.equal(typeof audio.playThinking, 'function');
  assert.equal(typeof audio.stopThinking, 'function');
  assert.equal(typeof audio.startHoldToTalk, 'function');
  assert.equal(typeof audio.stopHoldToTalk, 'function');
  let called = 0;
  await audio.play('/clip.mp3', { seat: 1, roleId: 'claudia', voiceId: '001', onEnded() { called += 1; } });
  audio.playThinking();
  audio.stopThinking();
  audio.stop();
  await audio.startHoldToTalk({ onStart() { called += 1; }, onStop() { called += 1; }, onError() { called += 1; } });
  audio.stopHoldToTalk();
  assert.equal(called, 0);
});

test('the text page plays a full game in the browser call order without leaking secrets', async () => {
  const page = await readFile(new URL('../public/mixin/app.js', import.meta.url), 'utf8');
  assert.match(page, /created\.id/);
  for (const name of ['step', 'tick', 'hint', 'confirm', 'interrupt', 'restart', 'playThinking', 'startHoldToTalk']) {
    assert.match(page, new RegExp(name));
  }
  assert.equal(page.includes('getUserMedia'), false);
  assert.equal(page.includes('examplePlayer'), false);

  const server = createApp({
    loadConfig: async () => ({}),
    getOta: async () => ({ activation: { code: '1' } }),
    openVoice() { throw new Error('文字局不应该打开语音'); },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/mixin', '/mixin/', '/mixin/index.html', '/mixin/app.js', '/mixin/style.css', '/mixin/audio.js', '/mixin/logic.js', '/']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200, path);
    }
    const html = await (await fetch(`${base}/mixin`)).text();
    assert.match(html, /谁是人类/);
    assert.match(html, /\/mixin\/app\.js/);
    assert.match((await fetch(`${base}/mixin`)).headers.get('content-security-policy'), /script-src 'self'/);
    const forbidden = await fetch(`${base}/api/mixin`, {
      method: 'POST',
      headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
      body: JSON.stringify(createBody({ sceneId: 'annual', difficulty: 'easy', alias: '碳基-7B', seed: 3 })),
    });
    assert.equal(forbidden.status, 403);
    assert.match(friendlyError(403, await forbidden.json()), /本机/);

    const post = (path, body, cookie = '') => fetch(`${base}${path}`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body ?? {}),
    });
    const created = await post('/api/mixin', createBody({ sceneId: 'annual', difficulty: 'easy', alias: '碳基-7B', seed: 3 }));
    assert.equal(created.status, 201);
    const cookie = created.headers.get('set-cookie').split(';')[0];
    const createdBody = await created.json();
    assert.notEqual(createdBody.id, createdBody.game.id);
    assert.equal(createdBody.game.playerAlias, '碳基-7B');
    assertConcealed(createdBody);
    const id = createdBody.id;
    const mismatched = await fetch(`${base}/api/mixin/${id}`);
    assert.equal(mismatched.status, 409);
    assert.match(friendlyError(409, await mismatched.json()), /对不上/);

    let game = (await (await post(`/api/mixin/${id}/start`, {}, cookie)).json()).game;
    assert.equal(game.phase, 'intro');
    assertConcealed({ game });
    let hinted = false;
    let interruptUsed = false;
    let resumed = false;
    let partialVotes = 0;
    const actions = [];
    for (let step = 0; step < 80 && game.phase !== 'result'; step += 1) {
      if (!resumed && step === 3) {
        const viewed = await (await fetch(`${base}/api/mixin/${id}`, { headers: { cookie } })).json();
        assert.equal(viewed.game.phase, game.phase);
        assert.equal(viewed.game.generation, game.generation);
        assertConcealed(viewed);
        resumed = true;
      }
      const action = orchestrate(game, {
        playerText: rounds[game.round - 1],
        defenseText: '气死了，我昨天就是加班。',
        voteSeat: 1,
        interruptText: '我那是在跑批处理，凭什么这么说',
        interruptUsed,
        wantHint: game.phase === 'round_player' && game.round === 1 && !hinted,
      });
      assert.notEqual(action.action, 'idle', game.phase);
      actions.push(action.action);
      if (action.action === 'hint') hinted = true;
      if (action.action === 'interrupt') interruptUsed = true;
      const response = await post(`/api/mixin/${id}/${action.action}`, actionBody(action), cookie);
      const payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      for (const view of [payload, payload.game, payload.view]) {
        if (view?.phase && view.phase !== 'reveal' && view.phase !== 'result') assertConcealed(view);
      }
      game = payload.game;
      if (game.phase === 'vote' && game.votes?.votes?.length) partialVotes = Math.max(partialVotes, game.votes.votes.length);
    }
    assert.equal(game.phase, 'result');
    assert.equal(hinted, true);
    assert.equal(interruptUsed, true);
    assert.ok(actions.includes('vote'));
    assert.ok(actions.includes('confirm'));
    assert.ok(partialVotes >= 1 && partialVotes < 4);
    assert.equal(typeof game.report.humanScore, 'number');
    assert.equal(typeof game.report.aiScore, 'number');
    assert.ok(game.report.title);
    assert.ok(game.report.endingText);
    assert.ok(['潜伏成功', '被识破'].includes(game.report.outcome));
    const again = await (await fetch(`${base}/api/mixin/${id}`, { headers: { cookie } })).json();
    assert.equal(again.game.phase, 'result');
    assert.equal(again.game.report.title, game.report.title);
    const restarted = await (await post(`/api/mixin/${id}/restart`, {}, cookie)).json();
    assert.equal(restarted.game.phase, 'lobby');
    assert.equal(restarted.game.generation, 2);
    assert.equal(restarted.game.humanScore, null);
    assert.equal(restarted.game.report, null);
    assertConcealed(restarted);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

function actionBody(action) {
  if (action.action === 'text') return { text: action.text, typed: true };
  if (action.action === 'confirm') return { revision: action.revision };
  if (action.action === 'vote') return { seat: action.seat };
  if (action.action === 'interrupt') return { text: action.text };
  if (action.action === 'tick') return { ms: action.ms };
  return {};
}

function assertConcealed(payload) {
  const game = payload.phase ? payload : payload.game;
  assert.equal(concealmentHolds(game), true, JSON.stringify({ phase: game.phase, humanScore: game.humanScore, aiScore: game.aiScore, votes: game.votes, outcome: game.outcome }));
  assert.equal(hasEndingSpeech(game), false);
}

test('every seatable persona, the player and the host map to one character sticker', async () => {
  const css = await readFile(new URL('../public/mixin/style.css', import.meta.url), 'utf8');
  const ids = [...CAST.map(item => item.roleId), 'player'];
  const keys = new Set();
  for (const id of ids) {
    const character = characterOf(id);
    assert.ok(CHARACTERS[id], id);
    assert.ok(character.label, id);
    assert.ok(css.includes(`.av-${character.key}{background-image:url(data:image/webp;base64,`), `${id} 缺贴纸`);
    keys.add(character.key);
  }
  assert.equal(keys.size, ids.length);
});

test('reduced motion keeps player and voting timers at real-time speed', () => {
  for (const phase of ['round_player', 'defense', 'vote']) {
    const intent = autoIntent({ phase, cue: null }, { readScale: 0.15 });
    assert.equal(intent.delay, intent.ms, `${phase}: one game second must take one real second`);
  }
});
