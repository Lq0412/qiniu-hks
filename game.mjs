import { randomUUID } from 'node:crypto';
import { counters } from './counters.mjs';

export class GameError extends Error {}

export function createGame() {
  return { id: randomUUID(), stage: 0, score: 30, turn: 0, reviewed: 0, stamps: [], dialogue: [], history: [], startedAt: null, status: 'playing' };
}

export function addSpeech(game, text, now = Date.now()) {
  if (game.status !== 'playing' || game.stamps.includes(game.stage)) return false;
  if (!text?.trim()) return false;
  if (!game.startedAt) game.startedAt = now;
  game.turn++;
  game.dialogue.push({ who: 'player', text: text.slice(0, 1000), stage: game.stage });
  return true;
}

export function checkTime(game, now = Date.now()) {
  if (game.status === 'playing' && !game.stamps.includes(game.stage) && game.startedAt && now - game.startedAt >= 180000) game.status = 'timeout';
}

export function review(game, stage, { turn, delta, reason }) {
  checkTime(game);
  if (stage !== game.stage || game.status !== 'playing') throw new GameError('窗口或游戏已更新，不再接受旧评价。');
  if (!Number.isInteger(turn) || turn !== game.turn || turn < 1) throw new GameError('请先读取当前有效轮次。');
  if (game.reviewed === turn) return { ...view(game), duplicate: true };
  if (typeof delta !== 'number' || !Number.isInteger(delta) || delta < -10 || delta > 25 || typeof reason !== 'string' || !reason.trim() || reason.length > 200) throw new GameError('评价参数不合法。');
  if (game.stamps.includes(stage)) throw new GameError('此窗口已盖章。');
  game.reviewed = turn;
  game.score = Math.min(100, Math.max(0, game.score + delta));
  game.history.push({ stage, turn, delta, reason });
  if (game.score >= 75 && turn >= 2) game.stamps.push(stage);
  if (game.score === 0) game.status = 'rejected';
  if (game.stamps.length === counters.length) game.status = 'won';
  return view(game);
}

export function advance(game) {
  if (game.status !== 'playing' || !game.stamps.includes(game.stage)) throw new GameError('当前窗口尚未放行。');
  game.stage++;
  game.score = 30; game.turn = 0; game.reviewed = 0; game.startedAt = null;
  return view(game);
}

export function view(game) {
  checkTime(game);
  return structuredClone({ id: game.id, stage: game.stage, score: game.score, turn: game.turn,
    stamped: game.stamps.includes(game.stage), stamps: game.stamps, status: game.status,
    counter: counters[game.stage], dialogue: game.dialogue.slice(-60), history: game.history,
    secondsLeft: game.startedAt ? Math.max(0, 180 - Math.floor((Date.now() - game.startedAt) / 1000)) : 180 });
}
