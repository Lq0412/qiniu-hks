// 文字对局。不申请麦克风，不连接灵矽，不读设备凭据。
// 说话只走座位调度接口；实现方失败时用兜底台词，局面继续。

import { TIMEOUTS, MixinError, confirmPlayer, createMixinGame, fulfillCue, interruptMixin, revealHint, restartMixin, castVote, startMixin, submitPlayerText, tickMixin, viewMixin } from './mixin-game.mjs';
import { createScriptedSpeaker, dispatchSeatSpeech } from './mixin-voice.mjs';

export function createTextSession(options = {}) {
  const game = createMixinGame(options);
  const implement = options.speak ?? createScriptedSpeaker();
  let now = options.now ?? 0;
  return {
    game,
    now: () => now,
    setNow(value) { now = value; },
    view() { return viewMixin(game); },
    start() { return startMixin(game, { mode: 'text', now, generation: game.generation }); },
    async step() {
      const cue = game.cue;
      if (!cue) return { fulfilled: false, view: viewMixin(game) };
      const spoken = await dispatchSeatSpeech(implement, {
        cueId: cue.cueId,
        generation: game.generation,
        phase: game.phase,
        seat: cue.seat,
        roleId: cue.roleId,
        voice: cue.voice,
        instruction: cue.instruction,
        fallbackText: cue.fallbackText,
      });
      fulfillCue(game, { generation: game.generation, cueId: cue.cueId, text: spoken.text, now, voiceUsed: spoken.voiceUsed, via: 'speech' });
      return { fulfilled: true, mode: spoken.mode, ok: spoken.ok, view: viewMixin(game) };
    },
    say(text, extra = {}) {
      return submitPlayerText(game, {
        generation: game.generation,
        text,
        typed: extra.typed !== false,
        durationMs: extra.durationMs ?? null,
        silenceMs: extra.silenceMs ?? null,
        now,
      });
    },
    confirm(revision = game.pending?.revision) {
      return confirmPlayer(game, { generation: game.generation, revision, now });
    },
    vote(seat) { return castVote(game, { generation: game.generation, seat, now }); },
    interrupt(text) { return interruptMixin(game, { generation: game.generation, text, now }); },
    hint() { return revealHint(game, { generation: game.generation }); },
    restart() { return restartMixin(game, { now }); },
    tick(ms = 0) {
      now += ms;
      return tickMixin(game, now);
    },
    tickTo(value) {
      now = value;
      return tickMixin(game, now);
    },
  };
}

export async function playScript(session, script) {
  const trace = [];
  const mark = () => {
    const view = session.view();
    trace.push({ phase: view.phase, stage: view.stage, round: view.round, kind: view.cue?.kind ?? null, note: view.note });
    return view;
  };
  session.start();
  mark();
  let interruptDone = !script.interrupt;
  for (let steps = 0; session.game.phase !== 'result'; steps += 1) {
    if (steps > 120) throw new MixinError('文字局超过步数上限，已中止。');
    const phase = session.game.phase;
    if (phase === 'error') throw new MixinError(session.game.error || '对局停在错误状态。');
    if (phase === 'round_player') {
      const line = script.rounds?.[session.game.round - 1];
      if (typeof line === 'string') {
        const said = session.say(line, script.say ?? {});
        if (!said.accepted) throw new MixinError(`玩家发言未被接受：${said.reason}`);
        session.confirm();
      } else session.tick(TIMEOUTS.playerHard);
      mark();
      continue;
    }
    if (phase === 'defense') {
      if (script.defense) {
        const said = session.say(script.defense);
        if (!said.accepted) throw new MixinError(`甩锅发言未被接受：${said.reason}`);
      }
      if (Number.isInteger(script.vote)) session.vote(script.vote);
      if (session.game.pending) session.confirm();
      else session.tick(TIMEOUTS.defense);
      mark();
      continue;
    }
    if (phase === 'accuse' && !interruptDone && session.game.cue?.kind === 'accuse' && session.game.script.some(item => item.done)) {
      const hit = session.interrupt(script.interrupt);
      if (!hit.accepted) throw new MixinError(`插嘴未被接受：${hit.reason}`);
      interruptDone = true;
      mark();
      continue;
    }
    if (session.game.cue) {
      await session.step();
      mark();
      continue;
    }
    session.tick(1000);
    mark();
  }
  return { trace, report: session.view().report, view: session.view() };
}

export async function runUntilResult(session) {
  session.start();
  let now = session.now();
  for (let step = 0; session.game.phase !== 'result' && step < 40; step += 1) {
    now += 60000;
    session.tickTo(now);
  }
  if (session.game.phase !== 'result') throw new MixinError('超时推进后仍未结束。');
  return session.view();
}
