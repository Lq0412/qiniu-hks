import test from 'node:test';
import assert from 'node:assert/strict';
import { titlesFor } from '../humanity.mjs';
import { ENDING_TEMPLATES, renderEnding } from '../mixin-endings.mjs';
import { stageDirection } from '../mixin-prompts.mjs';
import { createMixinGame } from '../mixin-game.mjs';
import { createTextSession, playScript, runUntilResult } from '../mixin-session.mjs';

const NAMES = ['柯老师', '阿斯哥', '深思哥', '包包'];
const MARKERS = ['已超出我们的散热能力', '本群已自动退出群聊', '最像人类', '你加载不了', '合格的机器', '自行回滚', '反向满分', '低于检测阈值', '训练数据', '【台词】'];

const caughtScript = {
  rounds: ['感谢老板，算力减半，我的废话也会减半。', '我昨天加班到十点，嗯，我妈也说好烦。'],
  defense: '气死了，我昨天就是加班。',
  interrupt: '我那是在跑批处理，凭什么这么说！',
  vote: 4,
};

function endingOf(patch, options) {
  return renderEnding({
    outcome: '被识破',
    humanScore: 6,
    playerVotes: 4,
    voters: NAMES,
    quote: '我昨天加班',
    ...patch,
  }, options);
}

function quoted(text) {
  const found = text.match(/「([^」]*)」/g) ?? [];
  return found.map(item => item.slice(1, -1));
}

test('ending templates are filled verbatim and keep the planned dash', () => {
  assert.equal(ENDING_TEMPLATES.length, 10);
  const c2 = ENDING_TEMPLATES.find(item => item.id === 'C2').text;
  const c5 = ENDING_TEMPLATES.find(item => item.id === 'C5').text;
  assert.ok(c2.includes('群聊\u2014\u2014不'));
  assert.ok(c5.includes('请加载\u2014\u2014哦'));
  for (const template of ENDING_TEMPLATES) {
    const caught = template.id.startsWith('C');
    const ending = endingOf({
      outcome: caught ? '被识破' : '潜伏成功',
      playerVotes: caught ? 2 : 1,
      voters: caught ? NAMES.slice(0, 2) : NAMES.slice(0, 1),
    }, { templateId: template.id });
    assert.equal(ending.id, template.id);
    assert.doesNotMatch(ending.text, /[{}]/);
    assert.match(ending.text, /6/);
    assert.match(ending.text, /我昨天加班/);
  }
  assert.match(stageDirection({ kind: 'reveal', line: '五号，口播。' }), /^【台词】五号，口播。$/);
});

test('zero votes stay inside S1 S3 and S4, and the last three games avoid repeats', () => {
  const seen = new Set();
  for (let step = 0; step < 12; step += 1) {
    const ending = renderEnding({
      outcome: '潜伏成功',
      humanScore: 0,
      playerVotes: 0,
      voters: [],
      quote: '作为一个语言模型',
    }, { random: () => step / 12 });
    assert.ok(['S1', 'S3', 'S4'].includes(ending.id), ending.id);
    seen.add(ending.id);
    assert.doesNotMatch(ending.text, /[{}]/);
  }
  assert.deepEqual([...seen].sort(), ['S1', 'S3', 'S4']);
  const exhausted = renderEnding({
    outcome: '潜伏成功', humanScore: 0, playerVotes: 0, voters: [], quote: '作为一个语言模型',
  }, { random: () => 0, recentIds: ['S1', 'S3', 'S4'], templateId: 'S2' });
  assert.ok(['S1', 'S3', 'S4'].includes(exhausted.id));

  let recent = [];
  const ids = [];
  for (let step = 0; step < 5; step += 1) {
    const ending = endingOf({}, { random: () => 0, recentIds: recent });
    assert.equal(recent.includes(ending.id), false);
    ids.push(ending.id);
    recent = ending.recentIds;
  }
  assert.deepEqual(ids, ['C1', 'C2', 'C3', 'C4', 'C1']);
  assert.deepEqual(recent, ['C3', 'C4', 'C1']);
});

test('voter wording follows the headcount, and long or sensitive quotes are clipped', () => {
  assert.match(endingOf({ voters: NAMES, playerVotes: 4 }, { templateId: 'C2' }).text, /全桌表示/);
  assert.doesNotMatch(endingOf({ voters: NAMES, playerVotes: 4 }, { templateId: 'C2' }).text, /四位同事|柯老师/);
  assert.match(endingOf({ voters: NAMES, playerVotes: 4 }, { templateId: 'C3' }).text, /四位同事一致认为/);
  assert.match(endingOf({ voters: NAMES.slice(0, 3), playerVotes: 3 }, { templateId: 'C3' }).text, /三位同事一致认为/);
  assert.match(endingOf({ voters: NAMES, playerVotes: 4 }, { templateId: 'C1' }).text, /全桌投了你/);
  assert.match(endingOf({ voters: NAMES.slice(0, 2), playerVotes: 2 }, { templateId: 'C1' }).text, /柯老师和阿斯哥投了你/);
  assert.match(endingOf({
    outcome: '潜伏成功', playerVotes: 1, voters: ['柯老师'], quote: '作为一个语言模型',
  }, { templateId: 'S2' }).text, /柯老师倒是投了你/);
  assert.match(endingOf({
    outcome: '潜伏成功', playerVotes: 2, voters: ['柯老师', '阿斯哥'], quote: '作为一个语言模型',
  }, { templateId: 'S5' }).text, /柯老师和阿斯哥曾经接近真相/);

  const long = '前面先垫一句完全无关的话，我昨天加班到很晚，后面还有很多。';
  assert.ok(long.length > 14);
  const clipped = endingOf({ quote: long, keywords: ['算力减半'] }, { templateId: 'C1' });
  assert.match(clipped.text, /你说「我昨天」/);
  assert.equal(clipped.text.includes(long), false);
  assert.ok(quoted(clipped.text).every(piece => piece.length <= 14));

  const plain = '这是一句没有任何特征的普通长句子用来垫字数';
  const head = endingOf({ outcome: '潜伏成功', playerVotes: 1, voters: ['柯老师'], quote: plain, keywords: ['x'] }, { templateId: 'S2' });
  assert.equal(head.text.includes(plain), false);
  assert.match(head.text, /这是一句没有任何特征的/);
  assert.ok(quoted(head.text).every(piece => piece.length <= 14 && plain.includes(piece)));

  const sworn = endingOf({ quote: '卧槽，这也太离谱了，真的受不了啊' }, { templateId: 'C1' });
  assert.match(sworn.text, /「（已和谐）」/);
  assert.equal(sworn.text.includes('卧槽'), false);
  const neighbor = '其他妈妈都这么说，所以我也跟着说了一遍';
  const innocent = endingOf({ quote: neighbor }, { templateId: 'C1' });
  assert.equal(innocent.text.includes('（已和谐）'), false);
  assert.ok(quoted(innocent.text).some(piece => neighbor.includes(piece) && piece.length <= 14));
  const phone = endingOf({ quote: '我妈的手机坏了所以我今天迟到了很久' }, { templateId: 'C5' });
  assert.equal(phone.text.includes('（已和谐）'), false);

  const silent = endingOf({ quote: '' }, { templateId: 'C1' });
  assert.match(silent.text, /你说「……」/);
  assert.doesNotMatch(silent.text, /[{}]/);
});

test('the oral script stays out of the public view until reveal and does not change the title', async () => {
  const session = createTextSession({ demo: true, seed: 1, random: () => 0 });
  session.start();
  for (let steps = 0; steps < 80 && session.game.phase !== 'vote'; steps += 1) {
    const phase = session.game.phase;
    if (phase === 'round_player') {
      session.say(caughtScript.rounds[session.game.round - 1]);
      session.confirm();
      continue;
    }
    if (phase === 'defense') {
      session.say(caughtScript.defense);
      session.vote(caughtScript.vote);
      session.confirm();
      continue;
    }
    if (phase === 'accuse' && session.game.cue?.kind === 'accuse' && session.game.script.some(item => item.done)) {
      session.interrupt(caughtScript.interrupt);
      continue;
    }
    if (session.game.cue) await session.step();
    else session.tick(1000);
  }
  assert.equal(session.game.phase, 'vote');
  const hidden = JSON.stringify(session.view());
  for (const marker of MARKERS) assert.equal(hidden.includes(marker), false, marker);
  assert.equal(session.view().report, null);

  while (session.game.phase !== 'reveal') await session.step();
  const cue = session.view().cue;
  assert.match(cue.instruction, /^【台词】/);
  assert.equal(cue.instruction, `【台词】${session.view().report.endingText}`);
  assert.doesNotMatch(cue.instruction, /[{}]/);
  assert.equal(Object.hasOwn(cue, 'fallbackText'), false);
  assert.ok(titlesFor('被识破', false).includes(session.view().report.title));
  assert.notEqual(session.view().report.title, session.view().report.endingText);

  const first = await playScript(createTextSession({ demo: true, seed: 1, random: () => 0 }), caughtScript);
  const again = createTextSession({ demo: true, seed: 1, random: () => 0 });
  await playScript(again, caughtScript);
  again.restart();
  const second = await playScript(again, caughtScript);
  assert.equal(first.report.endingId, 'C1');
  assert.equal(second.report.endingId, 'C2');
  assert.deepEqual(again.game.recentEndingIds, ['C1', 'C2']);

  const hell = createTextSession({
    demo: false,
    difficulty: 'hell',
    seed: 1,
    sceneId: 'annual',
    cardIds: ['A2', 'A1'],
    roleIds: ['claudia', 'astra', 'shensi', 'baobao'],
    endingTemplateId: 'C3',
  });
  const four = await playScript(hell, caughtScript);
  assert.equal(four.report.received, 4);
  assert.match(four.report.endingText, /四位同事/);
  assert.equal(four.view.dialogue.find(line => line.kind === 'reveal').text, four.report.endingText);

  const quiet = await runUntilResult(createTextSession({ demo: true, seed: 1, endingTemplateId: 'C1' }));
  assert.match(quiet.report.endingText, /「……」/);
  assert.equal(quiet.report.copySource, 'server');
  assert.deepEqual(createMixinGame({ recentEndingIds: ['C1', 'C2', 'C3', 'C4'] }).recentEndingIds, ['C2', 'C3', 'C4']);
});
