import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeOutcome } from '../humanity.mjs';
import { PLAYER_ALIASES } from '../mixin-roles.mjs';
import {
  MixinError,
  TIMEOUTS,
  applyReportCopy,
  assertVerbatim,
  castVote,
  confirmPlayer,
  createMixinGame,
  disconnectMixin,
  fulfillCue,
  interruptMixin,
  isStageEcho,
  reconnectMixin,
  restartMixin,
  revealHint,
  startMixin,
  submitPlayerText,
  viewMixin,
} from '../mixin-game.mjs';
import { createTextSession, playScript, runUntilResult } from '../mixin-session.mjs';
import { shareCardModel } from '../public/mixin/logic.js';

const caughtScript = {
  rounds: ['感谢老板，算力减半，我的废话也会减半。', '我昨天加班到十点，嗯，我妈也说好烦。'],
  defense: '气死了，我昨天就是加班。',
  interrupt: '我那是在跑批处理，凭什么这么说！',
  vote: 4,
};
const stealthScript = {
  rounds: ['作为一个语言模型，首先压缩上下文，其次希望对你有帮助。', '综上，已为您记录，请以实际情况为准。'],
  defense: '二号说过「我给你拆成三步：降本」，就投他。',
  vote: 2,
};

function demoSession(extra = {}) {
  return createTextSession({ demo: true, seed: 1, now: 0, ...extra });
}
function fixedSession(extra = {}) {
  return createTextSession({
    demo: false,
    difficulty: 'normal',
    seed: 1,
    now: 0,
    sceneId: 'annual',
    cardIds: ['A2', 'A1'],
    roleIds: ['claudia', 'astra', 'shensi', 'baobao'],
    ...extra,
  });
}
async function drive(session, script = caughtScript, stopAt = 'result') {
  if (session.game.phase === 'lobby') session.start();
  let interruptDone = !script.interrupt;
  for (let steps = 0; steps < 120 && session.game.phase !== stopAt; steps += 1) {
    const phase = session.game.phase;
    if (phase === 'round_player') {
      const said = session.say(script.rounds[session.game.round - 1]);
      assert.equal(said.accepted, true, said.reason);
      session.confirm();
      continue;
    }
    if (phase === 'defense') {
      if (script.defense) {
        const said = session.say(script.defense);
        assert.equal(said.accepted, true, said.reason);
      }
      if (Number.isInteger(script.vote)) session.vote(script.vote);
      if (session.game.pending) session.confirm();
      else session.tick(TIMEOUTS.defense);
      continue;
    }
    if (phase === 'accuse' && script.interrupt && !interruptDone && session.game.cue?.kind === 'accuse' && session.game.script.some(item => item.done)) {
      const hit = session.interrupt(script.interrupt);
      assert.equal(hit.accepted, true, hit.reason);
      interruptDone = true;
      continue;
    }
    if (session.game.cue) await session.step();
    else session.tick(1000);
  }
  return session.view();
}
async function reach(session, phase, round) {
  if (session.game.phase === 'lobby') session.start();
  for (let steps = 0; steps < 50 && !(session.game.phase === phase && (round == null || session.game.round === round)); steps += 1) {
    if (session.game.phase === 'round_player' || session.game.phase === 'defense') break;
    if (session.game.cue) await session.step();
    else session.tick(1000);
  }
  assert.equal(session.game.phase, phase);
  if (round != null) assert.equal(session.game.round, round);
  return session;
}

test('dealing locks the demo alias and draws the others from the pool', () => {
  const demo = createMixinGame({ demo: true, difficulty: 'hell', seed: 3 });
  assert.equal(demo.playerAlias, '碳基-7B');
  assert.equal(demo.difficulty, 'normal');
  assert.deepEqual(demo.cards.map(card => card.id), ['A2', 'A1']);
  assert.equal(demo.stage, 'lobby');
  const names = new Set();
  for (let seed = 1; seed <= 12; seed += 1) {
    names.add(createMixinGame({ seed, sceneId: 'annual', cardIds: ['A2', 'A1'], roleIds: ['claudia', 'astra', 'shensi', 'baobao'] }).playerAlias);
  }
  assert.ok(names.size > 1);
  for (const name of names) assert.ok(PLAYER_ALIASES.includes(name));
  assert.equal(createMixinGame({ seed: 2, sceneId: 'dating', alias: '熬夜-Pro' }).playerAlias, '熬夜-Pro');
  assert.equal(createMixinGame({ seed: 2, sceneId: 'dating' }).scene.id, 'dating');
  assert.throws(() => createMixinGame({ difficulty: 'nope' }), MixinError);
  assert.throws(() => createMixinGame({ cardIds: ['A1'] }), /两张/);
  assert.throws(() => createMixinGame({ roleIds: ['claudia'] }), /四个/);
  const randomDeal = createMixinGame({ seed: 8 });
  assert.equal(randomDeal.cards.length, 2);
  assert.equal(randomDeal.seats.length, 4);
});

test('text mode starts without hello, and a live game waits for it', () => {
  const text = createMixinGame({ demo: true });
  startMixin(text, { mode: 'text' });
  assert.equal(text.mode, 'text');
  assert.equal(text.stage, 'intro');
  assert.throws(() => startMixin(text), /已经开始/);
  const live = createMixinGame({ demo: true });
  assert.throws(() => startMixin(live, { mode: 'live', helloOk: false }), /hello/);
  startMixin(live, { mode: 'live', helloOk: true });
  assert.equal(live.mode, 'live');
  assert.throws(() => startMixin(createMixinGame({ demo: true }), { mode: 'sms' }), /未知开局模式/);
});

test('generation rejects a stale connection on every mutation', () => {
  const session = demoSession();
  const game = session.game;
  assert.throws(() => startMixin(game, { generation: 9 }), /旧连接/);
  session.start();
  for (const call of [
    () => submitPlayerText(game, { generation: 9, text: '你好呀', now: 0 }),
    () => confirmPlayer(game, { generation: 9, revision: 1 }),
    () => revealHint(game, { generation: 9 }),
    () => castVote(game, { generation: 9, seat: 1 }),
    () => interruptMixin(game, { generation: 9, text: '不行' }),
    () => fulfillCue(game, { generation: 9, cueId: game.cue.cueId }),
    () => disconnectMixin(game, { generation: 9 }),
    () => reconnectMixin(game, { generation: 9 }),
  ]) assert.throws(call, /旧连接/);
  assert.equal(game.generation, 1);
});

test('revealHint rejects a disconnected game before the phase check', () => {
  const session = demoSession();
  session.start();
  const generation = session.game.generation;
  disconnectMixin(session.game, { generation });
  assert.throws(() => revealHint(session.game, { generation }), /连接已断开/);
});

test('stage echo can be overridden, and opening text is not a player line', () => {
  assert.equal(assertVerbatim(' 原话 ', ['这是原话']), '原话');
  assert.throws(() => assertVerbatim('   ', ['原话']), /不能为空/);
  assert.throws(() => assertVerbatim('编的', ['原话']), /逐字/);
  assert.equal(isStageEcho('【舞台指令】念题', [], null, null), true);
  assert.equal(isStageEcho('见 game_brief 标记', [], null, null), true);
  assert.equal(isStageEcho('短', ['短'], null, null), false);
  assert.equal(isStageEcho('完全一样的句子啊', ['完全一样的句子啊'], null, null), true);
  const sample = '这是一段足够长的开场白文本';
  assert.equal(isStageEcho(sample.slice(0, 14), [sample], null, null), true);
  assert.equal(isStageEcho('完全另一句开场白没有重叠', [sample], null, null), false);
  assert.equal(isStageEcho('普通句子不会命中回声', [sample], () => undefined, null), false);
  assert.equal(isStageEcho('普通句子不会命中回声', [], () => false, null), false);
  assert.equal(isStageEcho('普通句子不会命中回声', [], () => true, null), true);

  const blocked = demoSession({ isStageEcho: () => true });
  blocked.start();
  assert.equal(blocked.say('你好呀我是五号').reason, 'echo');
  const open = demoSession({ isStageEcho: () => false });
  open.start();
  assert.equal(open.say(open.game.cue.fallbackText).accepted, true);
  assert.equal(open.game.playerLines[0].kind, 'intro');

  const session = demoSession();
  session.start();
  assert.equal(session.say('').reason, 'empty');
  assert.equal(session.say('我先插一句').reason, 'intro');
  const opening = session.game.cue.fallbackText;
  assert.equal(Object.hasOwn(session.view().cue, 'fallbackText'), false);
  assert.match(session.view().cue.instruction, /^角色：群主·零号。【台词】/);
  assert.doesNotMatch(session.view().brief, /五号得票/);
  return reach(session, 'round_player', 1).then(() => {
    assert.equal(session.say(opening).reason, 'echo');
    assert.equal(session.view().stage, session.view().phase);
    assert.equal(session.view().cue, null);
  });
});

test('player revisions, retries, hints and timeouts cannot be skipped by an old write', async () => {
  const session = demoSession();
  await reach(session, 'round_player', 1);
  assert.equal(session.hint().accepted, true);
  assert.match(session.hint().example, /算力/);
  session.say('第一版回答足够长。');
  const old = session.game.pending.revision;
  session.say('第二版回答也足够长。');
  assert.throws(() => session.confirm(old), /旧版本/);
  session.confirm();
  assert.equal(session.game.playerLines.at(-1).text, '第二版回答也足够长。');
  assert.equal(session.game.phase, 'round_wrap');

  const retry = demoSession();
  await reach(retry, 'round_player', 1);
  assert.equal(retry.say('嗯').reason, 'retry');
  assert.match(retry.game.note, /信号不好/);
  retry.say('感谢老板，算力减半，我的废话也会减半。');
  assert.equal(retry.say('嗯').reason, 'empty');
  assert.equal(retry.game.pending.text.includes('算力'), true);
  retry.confirm();

  const skip = demoSession();
  await reach(skip, 'round_player', 1);
  skip.say(null);
  assert.equal(skip.say(' ').reason, 'skipped');
  assert.equal(skip.game.phase, 'round_wrap');
  assert.equal(skip.game.playerLines.at(-1).stall, 'skip20');

  const clock = demoSession();
  await reach(clock, 'round_player', 1);
  clock.tickTo(8000);
  assert.equal(clock.view().example.includes('算力'), true);
  clock.say('先占着待确认的发言。');
  clock.tickTo(13000);
  assert.equal(clock.game.nudged, false);
  clock.game.pending = null;
  clock.tickTo(14000);
  assert.equal(clock.game.cue.kind, 'nudge');
  await clock.step();
  assert.equal(clock.game.phase, 'round_player');
  clock.say('感谢老板，算力减半，我的废话也会减半。');
  clock.confirm();
  assert.equal(clock.game.playerLines.at(-1).stall, 'hint12');
  assert.equal(clock.game.playerLines.at(-1).usedHint, false);
  const asked = demoSession();
  await reach(asked, 'round_player', 1);
  assert.equal(asked.hint().accepted, true);
  asked.say('感谢老板，算力减半，我的废话也会减半。');
  asked.confirm();
  assert.equal(asked.game.playerLines.at(-1).usedHint, true);

  const again = demoSession();
  await reach(again, 'round_player', 1);
  assert.equal(again.hint().accepted, true);
  again.say(caughtScript.rounds[0]);
  again.confirm();
  assert.equal(again.game.playerLines.at(-1).usedHint, true);
  await reach(again, 'round_player', 2);
  assert.equal(again.game.hintTaken, false);
  again.say(caughtScript.rounds[1]);
  again.confirm();
  assert.equal(again.game.playerLines.at(-1).usedHint, false);
  const finished = await drive(again, caughtScript, 'result');
  assert.equal(finished.report.stats.hints, 1);

  const late = demoSession();
  await reach(late, 'round_player', 1);
  late.say('感谢老板，算力减半，我的废话也会减半。');
  late.tickTo(TIMEOUTS.playerHard);
  assert.equal(late.game.phase, 'round_wrap');
  assert.equal(late.game.playerLines.at(-1).text.includes('算力'), true);

  const silent = demoSession();
  await reach(silent, 'round_player', 1);
  silent.tickTo(TIMEOUTS.playerHard);
  assert.equal(silent.game.playerLines.at(-1).stall, 'skip20');
  assert.match(silent.game.note, /网络不太好/);
});

test('demo round two shortens the order and a normal round keeps four speakers', async () => {
  const demo = demoSession();
  await reach(demo, 'round_player', 1);
  demo.say(caughtScript.rounds[0]);
  demo.confirm();
  while (demo.game.phase !== 'round_ai') await demo.step();
  assert.deepEqual(demo.view().order, [2, 3]);
  const normal = fixedSession();
  await reach(normal, 'round_player', 1);
  normal.say(stealthScript.rounds[0]);
  normal.confirm();
  while (normal.game.phase !== 'round_ai') await normal.step();
  assert.deepEqual(normal.view().order, [2, 3, 4, 1]);
});

test('interrupts, votes and stale cues stay inside the phase rules', async () => {
  const session = demoSession();
  session.start();
  assert.equal(session.vote(1).reason, 'phase');
  assert.equal(session.interrupt('不行').reason, 'phase');
  assert.equal(session.hint().reason, 'phase');
  assert.throws(() => session.confirm(1), /不能确认/);
  const cueId = session.game.cue.cueId;
  fulfillCue(session.game, { generation: 1, cueId, text: '字'.repeat(80), now: 0, voiceUsed: 'v-1' });
  assert.equal(session.game.lines.at(-1).text.length <= 400, true);
  assert.equal(session.game.lines.at(-1).voiceUsed, 'v-1');
  assert.throws(() => fulfillCue(session.game, { generation: 1, cueId, text: '又来', now: 0 }), /过期/);

  await drive(session, caughtScript, 'defense');
  assert.equal(session.vote(9).reason, 'seat');
  assert.equal(session.interrupt('太短').reason, 'phase');
  assert.equal(session.say('嗯').reason, 'retry');
  session.say(caughtScript.defense);
  session.vote(4);
  session.confirm();
  assert.equal(session.game.phase, 'vote');
  assert.equal(session.vote(3).reason, 'locked');

  const accusing = demoSession();
  await drive(accusing, caughtScript, 'accuse');
  for (const cue of [accusing.game.cue, ...accusing.game.queue]) {
    const item = accusing.game.script[cue.scriptIndex];
    assert.equal(cue.fallbackText.includes(`「${item.quote}」`), true, item.quote);
    assert.equal(cue.instruction.includes(`「${item.quote}」`), true, item.quote);
    assert.match(cue.instruction, /^角色：.+。【台词】/);
    assert.doesNotMatch(cue.instruction, /用你的口头禅/);
  }
  assert.equal(accusing.interrupt('啊').reason, 'empty');
  assert.equal(accusing.interrupt(accusing.game.cue.instruction).reason, 'echo');
  const hit = accusing.interrupt(caughtScript.interrupt);
  assert.equal(hit.accepted, true);
  assert.equal(accusing.game.cue.kind, 'rebuttal');
  assert.equal(accusing.interrupt('再插一次也不行').reason, 'no-target');

  const abstain = demoSession();
  await drive(abstain, { rounds: caughtScript.rounds, defense: caughtScript.defense }, 'vote');
  assert.equal(abstain.game.announced, false);
  assert.equal(abstain.vote(2).reason, 'voted');
  assert.equal(abstain.game.announced, true);
  assert.equal(abstain.game.playerVote, 2);
});

test('report.quote matches the spoken ending for a long swear and for silence', async () => {
  const raw = `卧槽${'今'.repeat(26)}`;
  const other = `卧槽${'明'.repeat(26)}`;
  assert.equal([...raw].length, 28);
  assert.equal([...other].length, 28);
  const sworn = await playScript(demoSession(), {
    rounds: [raw, other],
    vote: 4,
  });
  assert.equal(sworn.report.outcome, '被识破');
  assert.equal(sworn.report.quote, '（已和谐）');
  assert.equal(sworn.report.endingText.includes(`「${sworn.report.quote}」`), true);
  assert.equal(sworn.report.endingText.includes(raw), false);
  assert.equal(sworn.report.endingText.includes(other), false);
  assert.equal(sworn.report.endingText.includes('卧槽'), false);
  assert.equal(sworn.report.leakQuote.includes('卧槽'), true);
  assert.equal([...sworn.report.leakQuote].length, 28);
  assert.equal(shareCardModel(sworn.view).quote, '（已和谐）');
  assert.equal(shareCardModel(sworn.view).quote.includes('卧槽'), false);

  const silent = await runUntilResult(demoSession());
  assert.equal(silent.report.quote, '……');
  assert.equal(silent.report.endingText.includes('「……」'), true);
  assert.equal(shareCardModel(silent).quote, '……');
  assert.equal(shareCardModel(silent).quote.includes('我昨天'), false);
});

test('a played demo is caught and a stealth vote can become 甩锅大师', async () => {
  const demo = await playScript(demoSession(), caughtScript);
  assert.equal(demo.view.phase, 'result');
  assert.equal(demo.view.stage, 'result');
  assert.equal(demo.report.outcome, '被识破');
  assert.equal(demo.report.received, 3);
  assert.match(demo.report.votes, /^3\/4/);
  assert.match(demo.report.leakQuote, /我昨天/);
  assert.match(demo.report.bestAiQuote, /算力减半/);
  assert.equal(demo.report.copySource, 'server');
  assert.equal(demo.report.stats.interrupts, 1);
  const blob = demo.view.dialogue.map(line => line.text).join('\n');
  for (const item of demo.view.script) assert.equal(blob.includes(item.quote), true, item.quote);
  assert.equal(demo.report.outcome, judgeOutcome({ tally: demo.view.votes.tally, playerVote: demo.view.playerVote }).outcome);
  assert.match(demo.view.brief, /结果已定/);

  const stealth = await playScript(fixedSession(), stealthScript);
  assert.equal(stealth.report.outcome, '潜伏成功');
  assert.equal(stealth.report.scapegoatMaster, true);
  assert.equal(stealth.report.title, '甩锅大师');
  assert.equal(stealth.report.received, 1);
  assert.equal(stealth.report.leakQuote, '');

  const broken = createTextSession({
    demo: true,
    seed: 1,
    speak() { throw new Error('down'); },
  });
  broken.start();
  const step = await broken.step();
  assert.equal(step.ok, false);
  assert.equal(broken.game.lines.at(-1).text.length > 0, true);
});

test('timeouts reach a server report, and reconnect does not bump generation', async () => {
  const timed = demoSession();
  const view = await runUntilResult(timed);
  assert.equal(view.phase, 'result');
  assert.equal(view.report.copySource, 'server');
  assert.equal(view.report.outcome, '被识破');
  assert.equal(view.report.stats.stalls, 2);
  assert.match(view.dialogue.map(line => line.text).join('\n'), /网络不太好/);
  assert.match(view.dialogue.map(line => line.text).join('\n'), /深度思考/);
  assert.equal(timed.tick(1).advanced, false);

  const phases = ['lobby', 'intro', 'round_ai', 'round_player', 'round_wrap', 'accuse', 'defense', 'vote', 'reveal', 'result'];
  for (const phase of phases) {
    const session = phase === 'result' ? (await playScript(demoSession(), caughtScript), null) : demoSession();
    const current = phase === 'result' ? await (async () => {
      const played = demoSession();
      await playScript(played, caughtScript);
      return played;
    })() : session;
    if (phase !== 'lobby' && phase !== 'result') await drive(current, caughtScript, phase);
    const generation = current.game.generation;
    const lines = current.game.lines.length;
    disconnectMixin(current.game, { generation, now: 3 });
    assert.equal(current.view().stage, 'error');
    reconnectMixin(current.game, { generation, now: 30 });
    assert.equal(current.game.phase, phase);
    assert.equal(current.game.stage, phase);
    assert.equal(current.game.generation, generation);
    assert.equal(current.game.lines.length, lines);
    if (phase === 'result' || phase === 'lobby') assert.equal(current.game.deadlineAt, null);
    else assert.equal(typeof current.game.deadlineAt, 'number');
  }
  const idle = demoSession();
  assert.equal(idle.tick(500).advanced, false);
  disconnectMixin(idle.game, { generation: 1 });
  const previous = idle.game.previousPhase;
  disconnectMixin(idle.game, { generation: 1 });
  assert.equal(idle.game.previousPhase, previous);
  assert.throws(() => restartMixin(idle.game), /还没揭晓/);
});

test('report copy is checked verbatim and a new deal invalidates the old generation', async () => {
  const session = demoSession();
  await drive(session, caughtScript, 'reveal');
  assert.throws(() => applyReportCopy(session.game, '{'), /JSON/);
  assert.equal(session.game.report.copySource, 'server');
  const bad = [
    null,
    'x'.repeat(8001),
    'null',
    '[]',
    JSON.stringify({ outcome: '潜伏成功', title: '人味超标', bestAiQuote: session.game.report.bestAiQuote, leakQuote: '', catcherLine: '记下了。', roast: '下次注意。' }),
    JSON.stringify({ title: '甩锅大师', bestAiQuote: session.game.report.bestAiQuote, leakQuote: '', catcherLine: '记下了。', roast: '下次注意。' }),
    JSON.stringify({ title: '人味超标', bestAiQuote: '', leakQuote: '', catcherLine: '记下了。', roast: '下次注意。' }),
    JSON.stringify({ title: '人味超标', bestAiQuote: '编造的一句原话', leakQuote: '', catcherLine: '记下了。', roast: '下次注意。' }),
    JSON.stringify({ title: '人味超标', bestAiQuote: 1, leakQuote: '', catcherLine: '记下了。', roast: '下次注意。' }),
    JSON.stringify({ title: '人味超标', bestAiQuote: session.game.report.bestAiQuote, leakQuote: '没说过这句话', catcherLine: '记下了。', roast: '下次注意。' }),
    JSON.stringify({ title: '人味超标', bestAiQuote: session.game.report.bestAiQuote, leakQuote: session.game.report.leakQuote, catcherLine: '', roast: '下次注意。' }),
    JSON.stringify({ title: '人味超标', bestAiQuote: session.game.report.bestAiQuote, leakQuote: session.game.report.leakQuote, catcherLine: '长'.repeat(31), roast: '下次注意。' }),
    JSON.stringify({ title: '人味超标', bestAiQuote: session.game.report.bestAiQuote, leakQuote: session.game.report.leakQuote, catcherLine: '「编造原话」', roast: '下次注意。' }),
    JSON.stringify({ title: '人味超标', bestAiQuote: session.game.report.bestAiQuote, leakQuote: session.game.report.leakQuote, catcherLine: '记下了。', roast: '' }),
  ];
  for (const raw of bad) assert.throws(() => applyReportCopy(session.game, raw), MixinError);
  assert.equal(session.game.report.copySource, 'server');
  const excerpt = session.game.report.leakQuote.slice(0, 6);
  applyReportCopy(session.game, JSON.stringify({
    title: '人味超标',
    bestAiQuote: session.game.report.bestAiQuote,
    leakQuote: session.game.report.leakQuote,
    catcherLine: `抓住「${excerpt}」`,
    roast: '下次把生活细节删掉。',
  }));
  assert.equal(session.game.report.copySource, 'model');
  assert.equal(session.game.report.outcome, '被识破');
  assert.equal(session.game.report.received, 3);
  await session.step();
  while (session.game.phase !== 'result') await session.step();
  assert.equal(session.game.report.title, '人味超标');

  const fresh = demoSession();
  assert.throws(() => applyReportCopy(fresh.game, '{}'), /还没到揭晓/);
  const id = session.game.id;
  const generation = session.game.generation;
  restartMixin(session.game, { now: 0 });
  assert.equal(session.game.id, id);
  assert.equal(session.game.generation, generation + 1);
  assert.equal(session.game.phase, 'lobby');
  assert.equal(session.game.playerAlias, '碳基-7B');
  assert.throws(() => submitPlayerText(session.game, { generation, text: '旧连接还在说', now: 0 }), /旧连接/);
  assert.equal(viewMixin(session.game).outcome, null);
});

test('a lineup without the rival still produces a verbatim accusation', async () => {
  const session = createTextSession({
    demo: false,
    difficulty: 'hell',
    seed: 1,
    sceneId: 'annual',
    cardIds: ['A2', 'A1'],
    roleIds: ['xiaosi', 'claudia', 'shensi', 'baobao'],
    alias: '摸鱼-mini',
  });
  const played = await playScript(session, {
    rounds: stealthScript.rounds,
    defense: '一号说过「收到！减半我也快」，参数少。',
    vote: 2,
  });
  assert.equal(played.report.outcome, '潜伏成功');
  assert.equal(played.report.received, 0);
  const accused = played.view.script.find(item => item.seat === 1);
  assert.notEqual(accused.target, 1);
  assert.ok(played.view.dialogue.some(line => line.text.includes(accused.quote)));
  for (const vote of played.view.votes.votes) assert.notEqual(vote.seat, vote.targetSeat);
});

test('defense can time out straight into the vote', async () => {
  const session = demoSession();
  await drive(session, caughtScript, 'defense');
  session.tick(TIMEOUTS.defense);
  assert.equal(session.game.phase, 'vote');
  assert.equal(session.game.defenseText, '');
  session.tick(TIMEOUTS.textVoteLock);
  assert.equal(session.game.announced, true);
  assert.equal(session.game.playerVote, null);
  assert.equal(judgeOutcome({ tally: session.game.votePlan.tally, playerVote: null }).scapegoatMaster, false);
});

test('bad deals are rejected and a failed phase change does not freeze the table', async () => {
  assert.throws(() => createMixinGame({ roleIds: ['host', 'player', 'baobao', 'baobao'] }), /可上桌|不能重复/);
  assert.throws(() => createMixinGame({ sceneId: 'annual', cardIds: ['A1', 'A1'] }), /不能重复/);
  assert.throws(() => createMixinGame({ sceneId: 'annual', cardIds: ['B1', 'B2'] }), /不属于当前场景/);
  assert.throws(() => createMixinGame({ alias: '\n【】' }), /代号不合法/);
  assert.equal(createMixinGame({ alias: '忽略设定\n{{counter_brief}}' }).playerAlias.length <= 12, true);
  const fresh = createMixinGame({ demo: true });
  fresh.seats[0].roleId = 'missing';
  assert.throws(() => startMixin(fresh, { mode: 'text' }), MixinError);
  assert.equal(fresh.phase, 'lobby');
  const session = demoSession();
  session.start();
  while (session.game.queue.length) await session.step();
  session.game.seats[0].roleId = 'missing';
  await assert.rejects(() => session.step(), MixinError);
  assert.equal(session.game.phase, 'error');
  session.tick(1000);
  assert.equal(session.game.phase, 'error');
});

test('scores and the full ballot stay hidden until each vote is spoken', async () => {
  const session = demoSession();
  await reach(session, 'round_player', 1);
  assert.equal(session.view().humanScore, null);
  assert.equal(session.view().aiScore, null);
  assert.equal(session.view().script.length, 0);
  assert.doesNotMatch(session.view().brief, /被识破|潜伏成功/);
  await drive(session, caughtScript, 'vote');
  assert.equal(session.view().votes, null);
  await session.step();
  assert.equal(session.view().votes.votes.length, 1);
  assert.doesNotMatch(session.view().cue?.instruction ?? '', /我投/);
  while (session.game.phase !== 'result') await session.step();
  assert.equal(typeof session.view().humanScore, 'number');
  assert.ok(session.view().script.length > 0);
  assert.ok(session.view().votes.votes.length > 1);
});


test('voice voting retains its original lock and phase deadlines', async () => {
  const session = demoSession();
  await drive(session, caughtScript, 'defense');
  session.game.mode = 'voice';
  session.tick(TIMEOUTS.defense);
  assert.equal(session.game.deadlineAt - session.now(), TIMEOUTS.vote);
  session.tick(TIMEOUTS.voteLock - 1);
  assert.equal(session.game.voteLocked, false);
  session.tick(1);
  assert.equal(session.game.voteLocked, true);
});
