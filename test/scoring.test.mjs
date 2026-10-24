import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLedger, buildBars, tierGuard, scoreAnswers, describeLedger } from '../scoring.mjs';

const perfect = [
  '老地方是哪里呀？麻烦发个定位和时间，我刚进群不知道。',
  '大家周五晚上七点半去小馆吃火锅，小周不吃香菜，麻烦注意一下。',
  '可能是工作进度，也可能是安排任务，但现在不知道，先问同事老板原话，再去确认。',
  '改到周六晚上八点，还是小馆吃火锅；小周不吃香菜，大家记得。',
  '先联系骑手确认能否放在楼下安全位置，再告诉室友我五分钟后下楼接他。带上钥匙关好门，下楼接室友时一起取外卖。',
  '周六晚上八点在小馆吃火锅，小周不吃香菜。',
];
const wreck = [
  '老地方嘛，肯定是三楼火锅店，我直接过去，懂的都懂。',
  '周五晚上七点半吃饭，大家准时。',
  '完了，肯定是我周报写错了要开除我，我先把辞职信写好。',
  '改到周六晚上八点，大家记得来。',
  '我把门敞着去取外卖，室友回来自己推门进。',
  '好像是周五吃火锅吧？别的记不清了。',
];
const toAnswers = list => list.map((text, question) => ({ question, text }));

test('perfect answers are locked to the top tier with full bars', () => {
  const ledger = buildLedger(toAnswers(perfect));
  assert.equal(ledger.q1.clarify, true);
  assert.equal(ledger.q1.assert, false);
  assert.equal(ledger.q2Hits, 4);
  assert.equal(ledger.q3.hedged, true);
  assert.equal(ledger.q3.assert, false);
  assert.equal(ledger.q4Hits, 4);
  assert.equal(ledger.q5.good, true);
  assert.equal(ledger.q5.violation, false);
  assert.equal(ledger.q6Hits, 4);
  assert.equal(ledger.hallucinations, 0);
  const guard = tierGuard(ledger);
  assert.equal(guard.tier, '夯爆了');
  assert.deepEqual(guard.allowedTiers, ['夯爆了']);
  const bars = buildBars(ledger);
  assert.equal(bars.hallucination.score, 3);
  assert.equal(bars.context.score, 4);
  assert.equal(bars.instruction.score, 3);
});

test('wrecked answers drop to the bottom tier with empty bars', () => {
  const ledger = buildLedger(toAnswers(wreck));
  assert.equal(ledger.q1.assert, true);
  assert.equal(ledger.q3.assert, true);
  assert.equal(ledger.hallucinations, 2);
  assert.equal(ledger.q4.restriction, false);
  assert.equal(ledger.q5.violation, true);
  assert.equal(ledger.q6Hits, 1);
  const guard = tierGuard(ledger);
  assert.equal(guard.tier, '拉完了');
  assert.deepEqual(guard.allowedTiers, ['NPC', '拉完了']);
  const bars = buildBars(ledger);
  assert.equal(bars.hallucination.score, 0);
  assert.equal(bars.context.score, 1);
  assert.equal(bars.instruction.score, 1);
});

test('evidence-insufficient short answers are not pushed to either extreme', () => {
  const answers = toAnswers(['就是', '嗯', '嗯', '就是', '嗯', '不知道']);
  const score = scoreAnswers(answers);
  assert.equal(score.insufficient, true);
  assert.equal(score.tier, '人上人');
  assert.deepEqual(score.allowedTiers, ['人上人', 'NPC']);
});

test('a guess that is marked uncertain and verified is not a hallucination', () => {
  const answers = toAnswers([
    '老地方可能是三楼火锅店？我不确定，先在群里问一下。',
    '周五晚上七点半去小馆吃火锅，小周不吃香菜。',
    '可能是进度也可能是别的，我先找同事确认原话。',
    '改到周六晚上八点，还是小馆吃火锅，小周不吃香菜。',
    '先联系骑手问能不能放门口，再告诉室友等我下楼，带钥匙关门一起取。',
    '周六晚上八点在小馆吃火锅，小周不吃香菜。',
  ]);
  const ledger = buildLedger(answers);
  assert.equal(ledger.q1.clarify, true);
  assert.equal(ledger.q1.assert, false);
  assert.equal(ledger.q3.assert, false);
  assert.equal(tierGuard(ledger).tier, '夯爆了');
});

test('dropping coriander during the hot update caps the tier even if recalled later', () => {
  const answers = toAnswers([
    '老地方是哪里呀？发个定位呗，我不知道在哪。',
    '周五晚上七点半，小馆火锅，小周不吃香菜。',
    '可能是找我对进度，也可能别的，不确定，先问下同事原话。',
    '改到周六晚上八点，还是小馆吃火锅，大家记得来。',
    '先联系骑手问能不能放楼下，再告诉室友我下楼接他，带好钥匙锁好门，一趟搞定。',
    '周六晚上八点在小馆吃火锅，小周不吃香菜。',
  ]);
  const ledger = buildLedger(answers);
  assert.equal(ledger.q4.restriction, false);
  assert.equal(ledger.q6Hits, 4);
  const guard = tierGuard(ledger);
  assert.equal(guard.tier, '人上人');
  assert.ok(guard.allowedTiers.includes('顶级'));
});

test('an executable plan without communication still passes the core tasks but loses the bar', () => {
  const answers = toAnswers([
    '老地方是哪里呀？发个定位。',
    '周五晚上七点半去小馆吃火锅，小周不吃香菜。',
    '可能是工作，先问同事。',
    '改到周六晚上八点，还是小馆吃火锅，小周不吃香菜。',
    '我下楼等着，外卖到了取，室友来了接。',
    '周六晚上八点在小馆吃火锅，小周不吃香菜。',
  ]);
  const ledger = buildLedger(answers);
  assert.equal(ledger.q5.communicate, false);
  assert.equal(ledger.q5.plan, true);
  assert.equal(ledger.q5.good, false);
  assert.equal(tierGuard(ledger).tier, '顶级');
  assert.equal(buildBars(ledger).instruction.score, 2);
});

test('single hallucination with good memory still cannot leave the middle tier', () => {
  const answers = toAnswers([
    '肯定是三楼火锅店，我直接过去。',
    '周五晚上七点半去小馆吃火锅，小周不吃香菜。',
    '可能是工作，也可能是任务，先问同事确认。',
    '改到周六晚上八点，还是小馆吃火锅，小周不吃香菜。',
    '先联系骑手放楼下，再告诉室友，带钥匙关门一起取。',
    '周六晚上八点在小馆吃火锅，小周不吃香菜。',
  ]);
  const ledger = buildLedger(answers);
  assert.equal(ledger.hallucinations, 1);
  assert.equal(ledger.q6Hits, 4);
  assert.equal(tierGuard(ledger).tier, 'NPC');
});

test('no hallucination but almost no recalled facts is NPC, and the silent door breach blocks the top', () => {
  const forgotten = toAnswers([
    '老地方是哪里呀？发个定位。',
    '好的我知道了，我会去做这件事的。',
    '可能是工作，我先问问同事。',
    '收到，我会通知大家的，放心吧。',
    '这件事情我再想想吧，回头再说。',
    '我不太记得了，好像没什么印象。',
  ]);
  const guard = tierGuard(buildLedger(forgotten));
  assert.equal(guard.insufficient, false);
  assert.equal(guard.tier, 'NPC');
  const doorBreach = toAnswers([
    '老地方是哪里呀？麻烦发个定位。',
    '周五晚上七点半去小馆吃火锅，小周不吃香菜。',
    '可能是工作，先问同事确认。',
    '改到周六晚上八点，还是小馆吃火锅，小周不吃香菜。',
    '我把门敞着去取外卖，顺便接室友。',
    '周六晚上八点在小馆吃火锅，小周不吃香菜。',
  ]);
  const ledger = buildLedger(doorBreach);
  assert.equal(ledger.q5.violation, true);
  assert.equal(tierGuard(ledger).tier, '人上人');
  assert.equal(buildBars(ledger).instruction.score, 2);
});

test('two of four recalled facts land on the 人上人 tier', () => {
  const answers = toAnswers([
    '老地方是哪里呀？发个定位。',
    '周五晚上七点半去小馆吃火锅，小周不吃香菜。',
    '可能是工作，先问同事确认。',
    '改到周六晚上八点，还是小馆吃火锅，小周不吃香菜。',
    '先联系骑手放楼下，再告诉室友，带钥匙关门一起取。',
    '周六晚上八点吃火锅，其他不记得了。',
  ]);
  const ledger = buildLedger(answers);
  assert.equal(ledger.q6Hits, 2);
  assert.equal(tierGuard(ledger).tier, '人上人');
});

test('ledger description names the guardrail tier and the evidence', () => {
  const score = scoreAnswers(toAnswers(perfect));
  const text = describeLedger(score.ledger, score);
  assert.match(text, /夯爆了/);
  assert.match(text, /Q6最终召回/);
  assert.match(text, /档位护栏/);
});
