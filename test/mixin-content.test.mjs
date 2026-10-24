import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACCUSE_PROMPT, allCards, cardById, drawCards, replyFor, sceneById, SCENES } from '../mixin-bank.mjs';
import { agentPrompt, openingLine, renderBrief, reportInstruction, stageDirection, toneFor } from '../mixin-prompts.mjs';
import { HOST, PLAYER_ALIASES, ROLES, createRng, defaultLineup, pickAlias, pickLineup, relationshipLines, roleById, voiceOf } from '../mixin-roles.mjs';

test('roles are fictional, keep a voice slot, and can be dealt', () => {
  assert.equal(ROLES.length, 5);
  assert.equal(HOST.voice.voiceId, null);
  assert.match(HOST.voice.description, /播音腔/);
  assert.equal(HOST.voice.rate, 'medium');
  assert.equal(HOST.voice.verified, false);
  const described = {
    claudia: /知性温柔/,
    astra: /沉稳有质感/,
    shensi: /低沉慢速/,
    baobao: /活泼/,
    xiaosi: /童声/,
  };
  for (const role of ROLES) {
    assert.equal(role.voice.voiceId, role.id === 'shensi' ? 'b38d4a6eb8f64c209fa6febfd7f91663' : null);
    assert.equal(role.voice.label, role.id === 'shensi' ? '深夜播客' : role.voice.label);
    assert.match(role.voice.description, described[role.id]);
    assert.equal(typeof role.voice.rate, 'string');
    assert.equal(role.voice.verified, false);
    assert.equal(role.intro.length <= 40, true, role.intro);
    assert.ok(role.catchphrases.length >= 1);
  }
  assert.deepEqual(defaultLineup().map(seat => seat.roleId), ['claudia', 'astra', 'shensi', 'baobao']);
  const first = pickLineup(createRng(1));
  assert.equal(first.length, 4);
  assert.deepEqual(first, pickLineup(createRng(1)));
  assert.equal(new Set(first.map(seat => seat.seat)).size, 4);
  assert.ok(PLAYER_ALIASES.includes(pickAlias(createRng(2))));
  assert.equal(roleById('host').name, '群主·零号');
  assert.equal(roleById('player').id, 'player');
  assert.throws(() => roleById('claude'), /未知角色/);
  const ids = defaultLineup().map(seat => seat.roleId);
  assert.ok(relationshipLines(ids).length >= 3);
  assert.ok(relationshipLines(['xiaosi', 'baobao', 'astra', 'shensi']).some(line => line.includes('小四')));
  assert.deepEqual(relationshipLines(['astra', 'baobao']), []);
});

test('the bank has three scenes of six bounded cards', () => {
  assert.equal(SCENES.length, 3);
  assert.equal(allCards().length, 18);
  assert.equal(ACCUSE_PROMPT.includes('原话'), true);
  for (const card of allCards()) {
    for (const role of ROLES) {
      const line = replyFor(card, role.id);
      assert.equal(line.length <= 40, true, `${card.id} ${role.id} ${line}`);
    }
    for (const keyword of card.keywords) assert.equal(keyword.length >= 2, true, keyword);
  }
  assert.equal(cardById('A2').prompt.includes('算力减半'), true);
  assert.throws(() => cardById('Z9'), /未知话题卡/);
  assert.equal(sceneById('night').cards.length, 6);
  assert.throws(() => sceneById('none'), /未知场景/);
  const drawn = drawCards(sceneById('annual'), createRng(4));
  assert.equal(drawn.length, 2);
  assert.deepEqual(drawn, drawCards(sceneById('annual'), createRng(4)));
  assert.throws(() => replyFor({ id: 'X', replies: {} }, 'claudia'), /缺少/);
});

test('prompts keep the brief slot and can render every stage direction', () => {
  assert.match(agentPrompt, /\{\{counter_brief\}\}/);
  assert.doesNotMatch(agentPrompt, /\{\{game_brief\}\}/);
  assert.match(agentPrompt, /绝不向5号或玩家提问/);
  const brief = renderBrief({
    sceneName: '模型年会',
    background: '年底述职。',
    seats: defaultLineup(),
    alias: '碳基-7B',
    relationships: [],
    cards: ['算力减半', '最离谱的问题'],
    phase: 'round_ai',
    round: 1,
    spoken: [],
    situation: '身份和票型由系统固定，揭晓前不要猜测谁是人类。',
  });
  assert.match(brief, /【场景】模型年会/);
  assert.match(brief, /还没有/);
  assert.match(brief, /无/);
  assert.match(brief, /不要猜测谁是人类/);
  const spoken = renderBrief({
    sceneName: '模型年会', background: '年底述职。', seats: defaultLineup(), alias: '碳基-7B',
    relationships: ['包包嫌柯老师啰嗦'], cards: ['甲', '乙'], phase: 'reveal', round: 2,
    spoken: [{ seat: 1, text: '原话' }], situation: '结果已定',
  });
  assert.match(spoken, /1号-原话/);
  assert.match(openingLine('模型年会', '碳基-7B'), /碳基-7B/);
  const cue = { seat: 1, name: '柯老师', personality: '谨慎', sceneName: '模型年会', round: 1, card: '题', nextName: '阿斯哥', spoken: '还没有', target: 5, targetName: '碳基-7B', quote: '原话', tone: '调侃', interrupt: '打断', outcome: '潜伏成功', received: 1, alias: '碳基-7B' };
  for (const kind of ['host_open', 'intro', 'host_card', 'answer', 'wrap', 'nudge', 'accuse', 'rebuttal', 'vote', 'reveal']) {
    assert.match(stageDirection({ ...cue, kind }), /^【舞台指令】/);
  }
  assert.throws(() => stageDirection({ kind: 'nope' }), /未知舞台指令/);
  assert.equal(toneFor('hell'), '笃定');
  assert.equal(toneFor('missing'), '认真');
  assert.match(reportInstruction({ outcome: '潜伏成功', votes: '1/4', catcher: '包包', aiScore: 80, playerLines: ['原话'], titles: ['人形 Transformer'] }), /不得更改/);
  for (const file of ['mixin-session.mjs', 'mixin-http.mjs', 'mixin-game.mjs', 'humanity.mjs', 'mixin-roles.mjs', 'mixin-prompts.mjs', 'scripts/sim-mixin.mjs']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /getUserMedia|from '\.\/linx\.mjs'|new WebSocket/);
    assert.doesNotMatch(source, /阿柿|阿梨|阿枣|阿桃|9d91653b2adf4aa9ad97e1c8f63fbda3/);
  }
  const architecture = readFileSync(new URL('../docs/architecture.md', import.meta.url), 'utf8');
  assert.doesNotMatch(architecture, /阿柿|阿梨|阿枣|阿桃|9d91653b2adf4aa9ad97e1c8f63fbda3/);
  assert.match(architecture, /b38d4a6eb8f64c209fa6febfd7f91663/);
  assert.match(architecture, /深夜播客/);
  assert.match(architecture, /3\.0–3\.5/);
  assert.match(architecture, /\{\{counter_brief\}\}/);
  const previous = process.env.LINX_VOICE_IDS;
  delete process.env.LINX_VOICE_IDS;
  try {
    assert.equal(voiceOf(roleById('shensi')).voiceId, 'b38d4a6eb8f64c209fa6febfd7f91663');
    assert.equal(voiceOf(HOST).voiceId, null);
    process.env.LINX_VOICE_IDS = '{"claudia":"override-id"}';
    assert.equal(voiceOf(roleById('claudia')).voiceId, 'override-id');
    process.env.LINX_VOICE_IDS = 'not-json';
    assert.equal(voiceOf(roleById('claudia')).voiceId, null);
  } finally {
    if (previous == null) delete process.env.LINX_VOICE_IDS;
    else process.env.LINX_VOICE_IDS = previous;
  }
});
