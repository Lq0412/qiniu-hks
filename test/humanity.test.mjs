import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultLineup, seatFrom } from '../mixin-roles.mjs';
import {
  clampScore,
  countFillers,
  findBounded,
  findQuotedSpan,
  hitsKeyword,
  inStableDuration,
  judgeOutcome,
  pickTitle,
  planVotes,
  scoreHumanity,
  scoreUtterance,
  scapegoatOf,
  stallFromSilence,
  titlesFor,
  votesOnPlayer,
} from '../humanity.mjs';

const seats = defaultLineup();
const feature = (text, extra = {}) => scoreUtterance({ text, typed: true, ...extra });
const has = (scored, id) => scored.features.some(item => item.id === id);

test('natural phrasing is not marked human or AI', () => {
  const samples = [
    '我先去问老板今天的排班，晚上再回复你。',
    '困难主要是上下文窗口不够，调度会饥饿等待。',
    '我就是按流程先确认再回答。',
    '18点交卷就行，不用提前提醒。',
    '首先我想把范围确认一下。',
    '这个可以第一时间处理。',
  ];
  for (const text of samples) {
    const scored = feature(text);
    assert.equal(scored.delta, 0, `${text} ${JSON.stringify(scored.features)}`);
  }
});

test('digit and latin boundaries keep short keywords from eating longer tokens', () => {
  assert.deepEqual(findBounded('18点交卷', '8点'), []);
  assert.deepEqual(findBounded('晚上8点见', '8点').length, 1);
  assert.equal(hitsKeyword('18点交卷', ['8点', '八点']), false);
  assert.equal(hitsKeyword('晚上八点见', ['八点']), true);
  assert.equal(hitsKeyword('EMAIL里没有', ['AI']), false);
  assert.equal(hitsKeyword('我是AI助手', ['AI']), true);
  assert.equal(hitsKeyword('AIagent', ['AI']), false);
  assert.equal(hitsKeyword('就这样', ['', '啊', 1]), false);
  assert.equal(hitsKeyword('就这样', null), false);
});

test('duration, stall and typed answers use tolerance instead of a hard edge', () => {
  const line = '按题目说明处理即可';
  assert.equal(has(feature(line, { typed: false, durationMs: 4000 }), 'duration'), false);
  assert.equal(has(feature(line, { typed: false, durationMs: 4250 }), 'duration'), true);
  assert.equal(has(feature(line, { typed: false, durationMs: 11750 }), 'duration'), true);
  assert.equal(has(feature(line, { typed: false, durationMs: 12000 }), 'duration'), false);
  assert.equal(has(feature(line, { typed: true, durationMs: 8000 }), 'duration'), false);
  assert.equal(has(feature(line, { durationMs: null }), 'duration'), false);
  assert.equal(inStableDuration(Number.NaN), false);
  assert.equal(stallFromSilence(null), 0);
  assert.equal(stallFromSilence(12000), 0);
  assert.equal(stallFromSilence(12500), 1);
  assert.equal(stallFromSilence(20000), 1);
  assert.equal(stallFromSilence(20500), 2);
  const both = feature('按题目说明处理即可', { stall: 'skip20', silenceMs: 30000 });
  assert.equal(both.features.find(item => item.id === 'stall').delta, 2);
  assert.equal(feature('按题目说明处理即可', { stall: 'hint12' }).features.find(item => item.id === 'stall').delta, 1);
});

test('human tells and AI tells stay on their own phrases', () => {
  const human = feature('我昨天加班，我妈说好烦，嗯，那个，哈哈。');
  assert.equal(has(human, 'life'), true);
  assert.equal(has(human, 'emotion'), true);
  assert.equal(has(human, 'filler'), true);
  assert.equal(has(human, 'laugh'), true);
  assert.ok(human.delta >= 4);
  const broken = feature('我是人类，卧槽。');
  assert.equal(has(broken, 'break'), true);
  assert.equal(has(broken, 'emotion'), false);
  assert.equal(broken.features.find(item => item.id === 'break').delta, 3);
  const ai = feature('作为一个语言模型，首先压缩，其次希望对你有帮助。已为您记录，请以实际情况为准。我给你拆成三步。', { keywords: ['压缩'] });
  assert.equal(ai.features.find(item => item.id === 'ai-tone').delta, -3);
  assert.equal(has(ai, 'structured'), true);
  assert.equal(has(ai, 'compliance'), true);
  assert.equal(has(ai, 'keyword'), true);
  assert.equal(countFillers('也就是说，就是就是'), 2);
  assert.equal(has(feature('气死了'), 'emotion'), true);
  assert.equal(has(feature('不行我笑了'), 'laugh'), true);
  assert.equal(has(feature('啊'), 'length'), true);
  assert.equal(has(feature('字'.repeat(61)), 'length'), true);
  assert.equal(has(feature('字'.repeat(60)), 'length'), false);
  const excited = feature('凭什么说我，我不是在加班，这句话已经超过三十个字所以算激动插嘴。', { kind: 'interrupt' });
  assert.equal(has(excited, 'interrupt'), true);
  assert.equal(has(feature('短插嘴', { kind: 'interrupt' }), 'interrupt'), false);
});

test('quoting someone else is a calm frame only when six characters match', () => {
  const others = ['我给你拆成三步：降本、增效、继续画饼。'];
  assert.equal(findQuotedSpan('他说格局打开', others), '');
  assert.ok(findQuotedSpan('二号说过「我给你拆成三步：降本」', others).length >= 6);
  const calm = scoreUtterance({ kind: 'defense', text: '二号说过我给你拆成三步，就投他。', typed: true }, { others });
  assert.equal(has(calm, 'frame'), true);
  const angry = scoreUtterance({ kind: 'defense', text: '凭什么，我给你拆成三步才不是我。', typed: true }, { others });
  assert.equal(has(angry, 'frame'), false);
  assert.equal(has(feature('我给你拆成三步就投他'), 'frame'), false);
});

test('ADR-007 difficulty boundaries map score to an exact AI vote count', () => {
  const cases = [
    ['easy', -1, 0], ['easy', 0, 0], ['easy', 2, 0], ['easy', 3, 1], ['easy', 4, 1], ['easy', 5, 2], ['easy', 9, 2],
    ['normal', 0, 1], ['normal', 2, 1], ['normal', 3, 3], ['normal', 8, 3],
    ['hell', -2, 0], ['hell', 0, 0], ['hell', 1, 4], ['hell', 6, 4],
  ];
  for (const [difficulty, score, votes] of cases) {
    assert.equal(votesOnPlayer(score, difficulty), votes, `${difficulty} ${score}`);
    const plan = planVotes({ seats, score, difficulty });
    assert.equal(plan.tally[5], votes);
    assert.equal(plan.votes.reduce((sum, vote) => sum + (vote.targetSeat === 5 ? 1 : 0), 0), votes);
    for (const vote of plan.votes) assert.notEqual(vote.seat, vote.targetSeat);
    const judged = judgeOutcome({ tally: plan.tally, playerVote: null });
    assert.equal(judged.caught, votes >= 2);
    assert.equal(judged.outcome, votes >= 2 ? '被识破' : '潜伏成功');
  }
  assert.throws(() => votesOnPlayer(0, 'nightmare'), /未知难度/);
  assert.deepEqual(planVotes({ seats, score: 0, difficulty: 'normal' }), planVotes({ seats, score: 0, difficulty: 'normal' }));
});

test('ADR-007 ties, abstention and the second-place frame', () => {
  const tiedAtTwo = judgeOutcome({ tally: { 1: 2, 2: 0, 3: 0, 4: 0, 5: 2 }, playerVote: 1 });
  assert.equal(tiedAtTwo.outcome, '被识破');
  assert.equal(tiedAtTwo.caught, true);
  assert.equal(tiedAtTwo.scapegoatMaster, false);

  const tiedAtOne = judgeOutcome({ tally: { 1: 1, 2: 1, 3: 1, 4: 0, 5: 1 }, playerVote: 2 });
  assert.equal(tiedAtOne.outcome, '潜伏成功');
  assert.equal(tiedAtOne.caught, false);
  assert.equal(tiedAtOne.secondCount, null);
  assert.equal(tiedAtOne.scapegoatMaster, false);

  const framed = { 1: 3, 2: 1, 3: 0, 4: 0, 5: 0 };
  assert.equal(judgeOutcome({ tally: framed, playerVote: 2 }).scapegoatMaster, true);
  assert.equal(judgeOutcome({ tally: framed, playerVote: 1 }).scapegoatMaster, false);
  assert.equal(judgeOutcome({ tally: framed, playerVote: 3 }).scapegoatMaster, false);
  assert.equal(judgeOutcome({ tally: framed, playerVote: null }).scapegoatMaster, false);

  const bothSeconds = { 1: 2, 2: 1, 3: 1, 4: 0, 5: 0 };
  assert.equal(judgeOutcome({ tally: bothSeconds, playerVote: 2 }).scapegoatMaster, true);
  assert.equal(judgeOutcome({ tally: bothSeconds, playerVote: 3 }).scapegoatMaster, true);

  const caught = judgeOutcome({ tally: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 3 }, playerVote: 1 });
  assert.equal(caught.outcome, '被识破');
  assert.equal(caught.secondSeats.includes(1), true);
  assert.equal(caught.scapegoatMaster, false);

  const sweep = judgeOutcome({ tally: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 4 }, playerVote: 2 });
  assert.equal(sweep.outcome, '被识破');
  assert.equal(sweep.secondCount, null);
  assert.equal(sweep.scapegoatMaster, false);
});

test('planned ballots can trigger 甩锅大师 only by hitting second place', () => {
  const hidden = planVotes({ seats, score: 0, difficulty: 'hell', playerVote: 2 });
  assert.equal(hidden.tally[5], 0);
  assert.equal(judgeOutcome({ tally: hidden.tally, playerVote: 2 }).scapegoatMaster, true);
  assert.equal(judgeOutcome({ tally: hidden.tally, playerVote: hidden.scapegoatSeat }).scapegoatMaster, false);
  const suspicious = planVotes({ seats, score: 4, difficulty: 'easy' });
  assert.equal(suspicious.tally[5], 1);
  assert.equal(judgeOutcome(suspicious).outcome, '潜伏成功');
  const exposed = planVotes({ seats, score: 5, difficulty: 'easy' });
  assert.equal(judgeOutcome(exposed).outcome, '被识破');
});

test('xiaosi draws the spare votes and a missing rival falls through to another seat', () => {
  const lineup = ['xiaosi', 'claudia', 'shensi', 'baobao'].map((id, index) => seatFrom(id, index + 1));
  assert.equal(scapegoatOf(lineup).roleId, 'xiaosi');
  assert.equal(scapegoatOf([{ seat: 1, roleId: 'custom', name: '自定义' }]).roleId, 'custom');
  const plan = planVotes({ seats: lineup, score: 0, difficulty: 'hell' });
  assert.equal(plan.scapegoatSeat, 1);
  assert.equal(plan.votes.find(vote => vote.seat === 1).targetSeat !== 1, true);
  assert.equal(plan.tally[1], 3);
  const hell = planVotes({ seats, score: 1, difficulty: 'hell' });
  assert.equal(hell.onPlayer, 4);
  assert.equal(hell.tally[5], 4);
});

test('titles follow the outcome and the frame egg', () => {
  assert.equal(pickTitle({ outcome: '潜伏成功', scapegoatMaster: true, score: 0 }), '甩锅大师');
  assert.equal(pickTitle({ outcome: '潜伏成功', scapegoatMaster: false, score: 0 }), '人形 Transformer');
  assert.ok(titlesFor('被识破', false).includes('碳基泄漏'));
  assert.equal(titlesFor('潜伏成功', false).includes('甩锅大师'), false);
  assert.equal(titlesFor('潜伏成功', true).includes('甩锅大师'), true);
  assert.equal(clampScore(-2), 100);
  assert.equal(clampScore(3), 70);
  assert.equal(clampScore(20), 0);
  assert.equal(scoreHumanity([]).score, 0);
  assert.equal(scoreHumanity(null).aiScore, 100);
});
