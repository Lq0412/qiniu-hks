// 谁是人类的服务端对局。身份、票型和胜负只在这里决定。
// 本模块不打开灵矽、不申请麦克风。文字模式把 hello 视为已满足；真连接以后只读 phase 和 generation。

import { randomUUID } from 'node:crypto';
import { cardById, drawCards, replyFor, sceneById, SCENES } from './mixin-bank.mjs';
import { ENDING_FALLBACK, renderEnding } from './mixin-endings.mjs';
import { accusationLine, HOST_NUDGE, HOST_RULES, HOST_SKIP_PLAYER, HOST_WRAP_EARLY, HOST_WRAP_LATE, openingLine, renderBrief, stageDirection, toneFor } from './mixin-prompts.mjs';
import { PLAYER_ALIASES, ROLES, createRng, defaultLineup, pickAlias, pickLineup, relationshipLines, roleById, seatFrom, voiceOf } from './mixin-roles.mjs';
import {
  clampScore,
  contentLength,
  CTA,
  findQuotedSpan,
  judgeOutcome,
  pickTitle,
  planVotes,
  scapegoatOf,
  scoreHumanity,
  scoreUtterance,
  titlesFor,
} from './humanity.mjs';

export class MixinError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MixinError';
  }
}

export const TIMEOUTS = {
  introHard: 45000,
  introCue: 8000,
  aiCue: 12000,
  hostCue: 8000,
  playerHint: 8000,
  playerNudge: 12000,
  playerHard: 20000,
  playerRetryCap: 30000,
  retryExtend: 10000,
  wrap: 6000,
  accuseCue: 10000,
  accuseHard: 50000,
  defense: 10000,
  defenseCap: 20000,
  vote: 20000,
  voteLock: 10000,
  textVote: 45000,
  textVoteLock: 30000,
  reveal: 20000,
  roundAiHard: 70000,
};

const PUNCT_RE = /[\s，。！？、；：,.!?;:「」“”"'【】]/g;

export function normalizeEcho(text) {
  return String(text ?? '').toLowerCase().replace(PUNCT_RE, '');
}

export function isStageEcho(text, notes, hook, game) {
  if (typeof hook === 'function') {
    const custom = hook(text, game);
    if (custom === true) return true;
    if (custom === false) return false;
  }
  const normalized = normalizeEcho(text);
  if (normalized.includes('舞台指令') || normalized.includes('counter_brief') || normalized.includes('game_brief')) return true;
  if (normalized.length < 6) return false;
  return notes.some(sample => {
    if (sample === normalized) return true;
    if (sample.length < 12 || normalized.length < 12) return false;
    const shorter = Math.min(sample.length, normalized.length);
    const longer = Math.max(sample.length, normalized.length);
    return (sample.includes(normalized) || normalized.includes(sample)) && shorter / longer >= 0.72;
  });
}

export function assertVerbatim(quote, corpus) {
  if (typeof quote !== 'string' || !quote.trim()) throw new MixinError('引用不能为空。');
  const clean = quote.trim();
  if (!corpus.some(text => String(text ?? '').includes(clean))) throw new MixinError('引用必须逐字来自已发言原文。');
  return clean;
}

const SEATABLE = new Set(ROLES.map(role => role.id));

function mustScene(id) {
  try { return sceneById(id); } catch { throw new MixinError('未知场景。'); }
}

function mustCard(id) {
  try { return cardById(id); } catch { throw new MixinError('未知话题卡。'); }
}

function cleanAlias(alias) {
  if (typeof alias !== 'string') throw new MixinError('代号不合法。');
  if (PLAYER_ALIASES.includes(alias)) return alias;
  const cleaned = alias.replace(/[^\u4e00-\u9fffA-Za-z0-9-]/g, '').slice(0, 12);
  if (!cleaned) throw new MixinError('代号不合法。');
  return cleaned;
}

function seatsFromIds(roleIds) {
  if (!Array.isArray(roleIds) || roleIds.length !== 4) throw new MixinError('桌上要有四个 AI 座位。');
  if (roleIds.some(id => !SEATABLE.has(id))) throw new MixinError('角色必须是可上桌的 AI。');
  if (new Set(roleIds).size !== 4) throw new MixinError('角色不能重复。');
  return roleIds.map((id, index) => seatFrom(id, index + 1));
}

function listedCards(cardIds) {
  if (!Array.isArray(cardIds) || cardIds.length !== 2) throw new MixinError('一局需要两张话题卡。');
  if (new Set(cardIds).size !== 2) throw new MixinError('话题卡不能重复。');
  return cardIds.map(id => mustCard(id));
}

function cardsForScene(cardIds, scene) {
  const cards = listedCards(cardIds);
  if (cards.some(card => card.sceneId !== scene.id)) throw new MixinError('话题卡不属于当前场景。');
  return cards;
}

export function createMixinGame(options = {}) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) throw new MixinError('建局参数不合法。');
  if ('demo' in options && typeof options.demo !== 'boolean') throw new MixinError('demo 必须是布尔值。');
  const demo = options.demo === true;
  const requestedDifficulty = options.difficulty ?? 'normal';
  if ('difficulty' in options && !['easy', 'normal', 'hell'].includes(requestedDifficulty)) throw new MixinError(`未知难度 ${requestedDifficulty}`);
  if (!demo && !['easy', 'normal', 'hell'].includes(requestedDifficulty)) throw new MixinError(`未知难度 ${requestedDifficulty}`);
  if ('seed' in options && options.seed != null && !Number.isInteger(options.seed)) throw new MixinError('seed 必须是整数。');
  const difficulty = demo ? 'normal' : requestedDifficulty;
  const seed = Number.isInteger(options.seed) ? options.seed : 1;
  const rng = createRng(seed);
  let scene;
  if (demo) scene = mustScene('annual');
  else if (options.sceneId) scene = mustScene(options.sceneId);
  else if (Array.isArray(options.cardIds)) {
    const probed = listedCards(options.cardIds);
    const sceneIds = new Set(probed.map(card => card.sceneId));
    if (sceneIds.size !== 1) throw new MixinError('话题卡不属于当前场景。');
    scene = mustScene([...sceneIds][0]);
  } else scene = SCENES[Math.floor(rng() * SCENES.length)];
  let cards;
  if (demo) {
    if (Array.isArray(options.cardIds)) cardsForScene(options.cardIds, scene);
    cards = [mustCard('A2'), mustCard('A1')];
  } else if (Array.isArray(options.cardIds)) cards = cardsForScene(options.cardIds, scene);
  else cards = drawCards(scene, rng);
  if (Array.isArray(options.roleIds)) seatsFromIds(options.roleIds);
  const seats = demo || !Array.isArray(options.roleIds) ? (demo ? defaultLineup() : pickLineup(rng)) : seatsFromIds(options.roleIds);
  const alias = options.alias == null ? null : cleanAlias(options.alias);
  const playerAlias = demo ? '碳基-7B' : (alias ?? pickAlias(rng));
  const now = options.now ?? 0;
  return {
    id: randomUUID(),
    generation: 1,
    phase: 'lobby',
    stage: 'lobby',
    previousPhase: null,
    mode: null,
    demo,
    difficulty,
    seed,
    scene: { id: scene.id, name: scene.name, background: scene.background },
    cards: cards.map(card => ({ id: card.id, prompt: card.prompt, examplePlayer: card.examplePlayer, keywords: [...card.keywords], replies: { ...card.replies } })),
    seats,
    playerAlias,
    playerSeat: 5,
    round: 0,
    order: [],
    queue: [],
    cue: null,
    cueSeq: 0,
    lines: [],
    playerLines: [],
    pending: null,
    revision: 0,
    emptyRetries: 0,
    hintReleased: false,
    hintTaken: false,
    debug: options.debug === true,
    random: typeof options.random === 'function' ? options.random : Math.random,
    recentEndingIds: Array.isArray(options.recentEndingIds) ? options.recentEndingIds.slice(-3) : [],
    endingTemplateId: typeof options.endingTemplateId === 'string' ? options.endingTemplateId : null,
    nudged: false,
    stallMark: null,
    human: { score: 0, breakdown: [], aiScore: 100 },
    interrupts: [],
    script: [],
    defenseText: null,
    playerVote: null,
    voteLocked: false,
    announced: false,
    votePlan: null,
    judged: null,
    report: null,
    dialogue: [],
    echoNotes: [],
    isStageEcho: typeof options.isStageEcho === 'function' ? options.isStageEcho : null,
    note: '场景已备好，可以开局。',
    error: null,
    phaseEnteredAt: now,
    deadlineAt: null,
    trace: [{ phase: 'lobby', at: now }],
    options: {
      demo,
      difficulty: requestedDifficulty,
      seed,
      sceneId: options.sceneId ?? null,
      cardIds: options.cardIds ?? null,
      roleIds: options.roleIds ?? null,
      alias,
    },
  };
}

export function startMixin(game, { generation = game.generation, mode = 'text', helloOk = false, now = 0 } = {}) {
  assertGen(game, generation);
  if (game.phase !== 'lobby') throw new MixinError('这一局已经开始了。');
  if (mode !== 'text' && mode !== 'live') throw new MixinError('未知开局模式。');
  if (mode === 'live' && helloOk !== true) throw new MixinError('要等灵矽 hello 成功才能开局。');
  game.mode = mode;
  enter(game, 'intro', now);
  return viewMixin(game);
}

export function submitPlayerText(game, input) {
  assertGen(game, input.generation);
  assertPlayable(game);
  const now = input.now ?? 0;
  const text = typeof input.text === 'string' ? input.text.trim().slice(0, 500) : '';
  if (echoes(game, text)) return refused(game, 'echo');
  if (game.phase === 'intro') {
    if (contentLength(text) < 1) return refused(game, 'empty');
    game.revision += 1;
    const line = playerRow(game, { text, kind: 'intro', typed: !!input.typed, durationMs: input.durationMs ?? null, silenceMs: input.silenceMs ?? null, usedHint: false, stall: null, keywords: [], quoted: '' });
    game.playerLines.push(line);
    pushDialogue(game, 5, game.playerAlias, text, 'intro', now);
    game.note = '开场插话已记下。';
    return accepted(game, 'intro');
  }
  if (game.phase !== 'round_player' && game.phase !== 'defense') return refused(game, 'phase');
  if (contentLength(text) < 2) {
    if (game.pending) return refused(game, 'empty');
    game.emptyRetries += 1;
    if (game.emptyRetries <= 1) {
      game.note = '五号，信号不好，再说一次？';
      const cap = game.phaseEnteredAt + (game.phase === 'defense' ? TIMEOUTS.defenseCap : TIMEOUTS.playerRetryCap);
      game.deadlineAt = Math.min(cap, Math.max(game.deadlineAt ?? now, now + TIMEOUTS.retryExtend));
      return refused(game, 'retry');
    }
    skipOrConfirm(game, now);
    return refused(game, 'skipped');
  }
  game.revision += 1;
  game.pending = { text, revision: game.revision, typed: !!input.typed, durationMs: input.durationMs ?? null, silenceMs: input.silenceMs ?? null };
  game.note = '可以确认，也可以重说。';
  return accepted(game, 'pending');
}

export function confirmPlayer(game, { generation, revision, now = 0 }) {
  assertGen(game, generation);
  assertPlayable(game);
  if (game.phase !== 'round_player' && game.phase !== 'defense') throw new MixinError('现在不能确认发言。');
  if (!game.pending || revision !== game.pending.revision) throw new MixinError('请确认最新一版发言；旧版本不能覆盖重答。');
  commitPending(game, now);
  return viewMixin(game);
}

export function revealHint(game, { generation }) {
  assertGen(game, generation);
  assertPlayable(game);
  if (game.phase !== 'round_player') return { accepted: false, reason: 'phase', example: null, view: viewMixin(game) };
  game.hintReleased = true;
  game.hintTaken = true;
  const example = currentCard(game).examplePlayer;
  return { accepted: true, reason: 'hint', example, view: viewMixin(game) };
}

export function castVote(game, { generation, seat, now = 0 }) {
  assertGen(game, generation);
  assertPlayable(game);
  if (game.voteLocked) return refused(game, 'locked');
  if (game.phase !== 'defense' && game.phase !== 'vote') return refused(game, 'phase');
  if (!game.seats.some(item => item.seat === seat)) return refused(game, 'seat');
  game.playerVote = seat;
  if (game.phase === 'vote' && !game.announced) announce(game, now);
  return accepted(game, 'voted');
}

export function interruptMixin(game, { generation, text, now = 0 }) {
  assertGen(game, generation);
  assertPlayable(game);
  if (game.phase !== 'accuse') return refused(game, 'phase');
  if (!game.cue || game.cue.kind !== 'accuse') return refused(game, 'no-target');
  const clean = typeof text === 'string' ? text.trim().slice(0, 500) : '';
  if (echoes(game, clean)) return refused(game, 'echo');
  if (contentLength(clean) < 2) return refused(game, 'empty');
  const aborted = game.cue;
  game.script[aborted.scriptIndex].aborted = true;
  game.revision += 1;
  game.interrupts.push({ seat: aborted.seat, text: clean, at: now, round: game.round });
  game.playerLines.push(playerRow(game, { text: clean, kind: 'interrupt', typed: true, durationMs: null, silenceMs: null, usedHint: false, stall: null, keywords: [], quoted: '' }));
  pushDialogue(game, 5, game.playerAlias, clean, 'interrupt', now);
  const rebuttal = cueFields(game, {
    kind: 'rebuttal',
    seat: aborted.seat,
    roleId: aborted.roleId,
    voice: aborted.voice,
    timeoutMs: TIMEOUTS.accuseCue,
    maxChars: 25,
    interrupt: clean,
    scriptIndex: aborted.scriptIndex,
    fallbackText: `${roleById(aborted.roleId).catchphrases[0]}。`.slice(0, 25),
  });
  rebuttal.startedAt = now;
  rebuttal.deadlineAt = now + rebuttal.timeoutMs;
  remember(game, rebuttal.instruction);
  remember(game, rebuttal.fallbackText);
  game.cue = rebuttal;
  game.note = '插嘴已记下。';
  return accepted(game, 'interrupted');
}

export function fulfillCue(game, { generation, cueId, text = '', now = 0, voiceUsed = null, via = 'speech' }) {
  assertGen(game, generation);
  assertPlayable(game);
  if (!game.cue || game.cue.cueId !== cueId) throw new MixinError('这句舞台发言已经过期。');
  recordCue(game, game.cue, text, now, via, voiceUsed);
  advanceAfterCue(game, now);
  return viewMixin(game);
}

export function tickMixin(game, now) {
  let advanced = false;
  for (let guard = 0; guard < 80; guard += 1) {
    if (!tickOnce(game, now)) break;
    advanced = true;
  }
  return { advanced, phase: game.phase, view: viewMixin(game) };
}

export function disconnectMixin(game, { generation, now = 0, reason = '连接断开' } = {}) {
  assertGen(game, generation);
  if (game.phase === 'error') return viewMixin(game);
  game.previousPhase = game.phase;
  game.phase = 'error';
  game.stage = 'error';
  game.error = reason;
  game.trace.push({ phase: 'error', at: now });
  return viewMixin(game);
}

export function reconnectMixin(game, { generation, now = 0 } = {}) {
  assertGen(game, generation);
  if (game.phase !== 'error') throw new MixinError('现在没有等待重连的对局。');
  const phase = game.previousPhase;
  game.phase = phase;
  game.stage = phase;
  game.error = null;
  game.phaseEnteredAt = now;
  if (game.cue) {
    game.cue.startedAt = now;
    game.cue.deadlineAt = now + game.cue.timeoutMs;
  }
  game.deadlineAt = deadlineFor(phase, now);
  game.trace.push({ phase, at: now });
  return viewMixin(game);
}

export function restartMixin(game, { now = 0 } = {}) {
  if (game.phase !== 'result') throw new MixinError('本局还没揭晓，不能重开。');
  const generation = game.generation + 1;
  const id = game.id;
  const hook = game.isStageEcho;
  const next = createMixinGame({
    ...game.options,
    seed: game.seed + 1,
    now,
    isStageEcho: hook,
    random: game.random,
    recentEndingIds: game.recentEndingIds,
    endingTemplateId: game.endingTemplateId,
  });
  next.id = id;
  next.generation = generation;
  for (const key of Object.keys(game)) delete game[key];
  Object.assign(game, next);
  return viewMixin(game);
}

export function applyReportCopy(game, reportJson) {
  if (game.phase !== 'reveal' && game.phase !== 'result') throw new MixinError('还没到揭晓，不能提交文案。');
  if (!game.report) throw new MixinError('结算还没完成。');
  if (typeof reportJson !== 'string' || reportJson.length > 8000) throw new MixinError('文案格式不合法。');
  let report;
  try { report = JSON.parse(reportJson); } catch { throw new MixinError('文案需要有效 JSON。'); }
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new MixinError('文案需要对象。');
  if (report.outcome != null && report.outcome !== game.report.outcome) throw new MixinError('不能改动系统判定的胜负。');
  const allowed = titlesFor(game.report.outcome, game.report.scapegoatMaster);
  if (!allowed.includes(report.title)) throw new MixinError(`称号必须来自：${allowed.join('、')}。`);
  const corpus = spokenPlayerTexts(game);
  const best = quoteField(report.bestAiQuote, corpus, corpus.length > 0);
  const leak = quoteField(report.leakQuote, corpus, false);
  const catcherLine = shortField(report.catcherLine, 30, 'catcherLine');
  const embedded = catcherLine.match(/「([^」]+)」/);
  if (embedded) assertVerbatim(embedded[1], [...corpus, ...aiTexts(game)]);
  const roast = shortField(report.roast, 40, 'roast');
  game.report = { ...game.report, title: report.title, bestAiQuote: best, leakQuote: leak, catcherLine, roast, copySource: 'model' };
  return viewMixin(game);
}

export function viewMixin(game) {
  const showSecret = game.phase === 'reveal' || game.phase === 'result';
  const card = game.round > 0 ? currentCard(game) : game.cards[0];
  return {
    id: game.id,
    generation: game.generation,
    phase: game.phase,
    stage: game.stage,
    previousPhase: game.previousPhase,
    mode: game.mode,
    demo: game.demo,
    difficulty: game.difficulty,
    round: game.round,
    order: [...game.order],
    scene: { ...game.scene },
    cards: game.cards.map(item => ({ id: item.id, prompt: item.prompt, examplePlayer: item.examplePlayer })),
    seats: game.seats.map(seat => ({ seat: seat.seat, roleId: seat.roleId, name: seat.name, voice: { ...seat.voice } })),
    playerAlias: game.playerAlias,
    playerSeat: game.playerSeat,
    revision: game.revision,
    pending: game.pending ? { ...game.pending } : null,
    deadlineAt: game.mode === 'text' && game.phase === 'vote' && !game.announced
      ? game.phaseEnteredAt + TIMEOUTS.textVoteLock : game.deadlineAt,
    note: game.note,
    error: game.error,
    hintReleased: game.hintReleased,
    example: game.hintReleased && game.phase === 'round_player' ? card.examplePlayer : null,
    cue: game.cue ? publicCue(game.cue, game) : null,
    humanScore: showSecret || game.debug ? game.human.score : null,
    aiScore: showSecret || game.debug ? game.human.aiScore : null,
    interrupts: game.interrupts.length,
    playerVote: game.playerVote,
    voteLocked: game.voteLocked,
    votes: visibleVotes(game, showSecret || game.debug),
    outcome: showSecret ? game.judged?.outcome ?? null : null,
    report: showSecret ? game.report : null,
    script: showSecret || game.debug ? game.script.map(item => ({ seat: item.seat, target: item.target, quote: item.quote, done: !!item.done, aborted: !!item.aborted })) : [],
    dialogue: game.dialogue.slice(-80).map(line => ({ seat: line.seat, name: line.name, text: line.text, kind: line.kind, round: line.round })),
    trace: game.trace.map(item => ({ phase: item.phase, at: item.at })),
    brief: renderBrief(briefState(game)),
  };
}

function publicCue(cue, game) {
  const secret = game.phase === 'reveal' || game.phase === 'result' || game.debug;
  const instruction = cue.kind === 'vote' && !secret
    ? `【舞台指令】你是${cue.seat}号${cue.name}。请用不超过20字宣布你的投票。`
    : cue.instruction;
  return {
    cueId: cue.cueId,
    kind: cue.kind,
    seat: cue.seat,
    roleId: cue.roleId,
    name: cue.name,
    voice: { ...cue.voice },
    instruction,
    deadlineAt: cue.deadlineAt,
  };
}

function visibleVotes(game, showSecret) {
  if (!game.votePlan) return null;
  if (showSecret) return game.votePlan;
  const spoken = new Set(game.lines.filter(line => line.kind === 'vote').map(line => line.seat));
  const votes = game.votePlan.votes.filter(vote => spoken.has(vote.seat));
  if (!votes.length) return null;
  const tally = {};
  for (const vote of votes) tally[vote.targetSeat] = (tally[vote.targetSeat] ?? 0) + 1;
  return { votes, tally };
}

function assertGen(game, generation) {
  if (generation !== game.generation) throw new MixinError('对局已更新，旧连接不能修改这一局。');
}

function assertPlayable(game) {
  if (game.phase === 'error') throw new MixinError('连接已断开。');
}

function echoes(game, text) {
  return isStageEcho(text, game.echoNotes, game.isStageEcho, game);
}

function accepted(game, reason) {
  return { accepted: true, reason, view: viewMixin(game) };
}

function refused(game, reason) {
  return { accepted: false, reason, view: viewMixin(game) };
}

function capturePhase(game) {
  return {
    phase: game.phase,
    stage: game.stage,
    phaseEnteredAt: game.phaseEnteredAt,
    cue: game.cue,
    queue: game.queue.slice(),
    deadlineAt: game.deadlineAt,
    traceLen: game.trace.length,
    round: game.round,
    order: game.order.slice(),
    emptyRetries: game.emptyRetries,
    hintReleased: game.hintReleased,
    hintTaken: game.hintTaken,
    nudged: game.nudged,
    stallMark: game.stallMark,
    pending: game.pending,
    note: game.note,
    script: game.script,
    announced: game.announced,
    voteLocked: game.voteLocked,
    votePlan: game.votePlan,
    judged: game.judged,
    report: game.report,
    cueSeq: game.cueSeq,
    echoLen: game.echoNotes.length,
    error: game.error,
  };
}

function restorePhase(game, saved) {
  Object.assign(game, {
    phase: saved.phase,
    stage: saved.stage,
    phaseEnteredAt: saved.phaseEnteredAt,
    cue: saved.cue,
    queue: saved.queue,
    deadlineAt: saved.deadlineAt,
    round: saved.round,
    order: saved.order,
    emptyRetries: saved.emptyRetries,
    hintReleased: saved.hintReleased,
    hintTaken: saved.hintTaken,
    nudged: saved.nudged,
    stallMark: saved.stallMark,
    pending: saved.pending,
    note: saved.note,
    script: saved.script,
    announced: saved.announced,
    voteLocked: saved.voteLocked,
    votePlan: saved.votePlan,
    judged: saved.judged,
    report: saved.report,
    cueSeq: saved.cueSeq,
    error: saved.error,
  });
  game.trace.splice(saved.traceLen);
  game.echoNotes.splice(saved.echoLen);
}

function enter(game, phase, now) {
  const saved = capturePhase(game);
  try {
    game.phase = phase;
    game.stage = phase;
    game.phaseEnteredAt = now;
    game.cue = null;
    game.queue = [];
    game.deadlineAt = null;
    game.trace.push({ phase, at: now });
    if (phase === 'intro') beginIntro(game, now);
    else if (phase === 'round_ai') beginRoundAi(game, now);
    else if (phase === 'round_player') beginPlayer(game, now);
    else if (phase === 'round_wrap') beginWrap(game, now);
    else if (phase === 'accuse') beginAccuse(game, now);
    else if (phase === 'defense') beginDefense(game, now);
    else if (phase === 'vote') beginVote(game, now);
    else if (phase === 'reveal') beginReveal(game, now);
    else if (phase === 'result') beginResult(game);
    const needsCue = ['intro', 'round_ai', 'round_wrap', 'accuse', 'reveal'].includes(phase);
    if (needsCue && !game.cue) throw new MixinError('这一阶段没有台词。');
  } catch (error) {
    restorePhase(game, saved);
    const message = error instanceof MixinError ? error.message : '阶段切换失败，局面已回滚。';
    if (!game.cue && !['lobby', 'round_player', 'defense', 'result', 'error'].includes(game.phase)) {
      game.previousPhase = game.phase;
      game.phase = 'error';
      game.stage = 'error';
      game.error = message;
      game.note = message;
      game.trace.push({ phase: 'error', at: now });
    }
    throw new MixinError(message);
  }
}

function safeReply(card, roleId) {
  try { return replyFor(card, roleId).slice(0, 40); } catch { return '这题我用一句话带过。'; }
}

function beginIntro(game, now) {
  const open = openingLine(game.scene.name, game.playerAlias);
  const cues = [
    cueFields(game, { kind: 'host_open', seat: 0, roleId: 'host', timeoutMs: TIMEOUTS.hostCue, maxChars: 400, fallbackText: open, line: open }),
    cueFields(game, { kind: 'host_open', seat: 0, roleId: 'host', timeoutMs: TIMEOUTS.hostCue, maxChars: 400, fallbackText: HOST_RULES, line: HOST_RULES }),
  ];
  for (const seat of game.seats) {
    cues.push(cueFields(game, {
      kind: 'intro', seat: seat.seat, roleId: seat.roleId, voice: seat.voice,
      timeoutMs: TIMEOUTS.introCue, maxChars: 40, fallbackText: roleById(seat.roleId).intro,
    }));
  }
  arm(game, cues, now, TIMEOUTS.introHard);
}

function beginRoundAi(game, now) {
  game.round += 1;
  game.emptyRetries = 0;
  game.hintReleased = false;
  game.hintTaken = false;
  game.nudged = false;
  game.stallMark = null;
  game.pending = null;
  const order = speakingOrder(game);
  game.order = order;
  const card = currentCard(game);
  const first = game.seats.find(seat => seat.seat === order[0]);
  const cues = [cueFields(game, {
    kind: 'host_card', seat: 0, roleId: 'host', timeoutMs: TIMEOUTS.hostCue, maxChars: 90,
    card: card.prompt, nextName: first.name,
    line: `第${game.round}题：${card.prompt}请${first.name}先来。`.slice(0, 90),
    fallbackText: `第${game.round}题：${card.prompt}请${first.name}先来。`.slice(0, 90),
  })];
  for (const seatNo of order) {
    const seat = game.seats.find(item => item.seat === seatNo);
    cues.push(cueFields(game, {
      kind: 'answer', seat: seat.seat, roleId: seat.roleId, voice: seat.voice,
      timeoutMs: TIMEOUTS.aiCue, maxChars: 40, card: card.prompt, spoken: '还没有',
      fallbackText: safeReply(card, seat.roleId),
    }));
  }
  arm(game, cues, now, TIMEOUTS.roundAiHard);
}

function beginPlayer(game, now) {
  game.note = '轮到你了，15 秒。';
  game.deadlineAt = now + TIMEOUTS.playerHard;
}

function beginWrap(game, now) {
  refreshHuman(game);
  const fallback = game.round < 2 ? HOST_WRAP_EARLY : HOST_WRAP_LATE;
  arm(game, [cueFields(game, { kind: 'wrap', seat: 0, roleId: 'host', timeoutMs: TIMEOUTS.wrap, maxChars: 30, fallbackText: fallback, line: fallback })], now, TIMEOUTS.wrap);
}

function beginAccuse(game, now) {
  game.script = buildScript(game);
  const cues = game.script.map((item, index) => {
    const line = accusationLine({ roleId: item.roleId, targetName: item.targetName, quote: item.quote, index });
    return cueFields(game, {
      kind: 'accuse', seat: item.seat, roleId: item.roleId,
      voice: game.seats.find(seat => seat.seat === item.seat).voice,
      timeoutMs: TIMEOUTS.accuseCue, maxChars: Math.max(line.length, 40),
      target: item.target, targetName: item.targetName, quote: item.quote, tone: toneFor(game.difficulty),
      scriptIndex: index, fallbackText: line, line,
    });
  });
  arm(game, cues, now, TIMEOUTS.accuseHard);
}

function beginDefense(game, now) {
  game.note = '用十秒甩锅，也可以点一个座位。';
  game.pending = null;
  game.emptyRetries = 0;
  game.deadlineAt = now + TIMEOUTS.defense;
}

function beginVote(game, now) {
  game.note = '正在计票。';
  game.announced = false;
  game.voteLocked = game.playerVote != null;
  game.deadlineAt = now + (game.mode === 'text' ? TIMEOUTS.textVote : TIMEOUTS.vote);
  if (game.voteLocked) announce(game, now);
}

function beginReveal(game, now) {
  ensurePlan(game);
  game.report = buildReport(game);
  const picked = pickQuotes(game.playerLines);
  const useLeak = game.report.outcome === '被识破';
  let ending;
  try {
    ending = renderEnding({
      outcome: game.report.outcome,
      humanScore: game.human.score,
      playerVotes: game.report.received,
      voters: game.report.from.map(item => item.name),
      quote: useLeak ? picked.leak : picked.best,
      keywords: useLeak ? picked.leakKeywords : picked.bestKeywords,
    }, {
      random: game.random,
      recentIds: game.recentEndingIds,
      templateId: game.endingTemplateId,
    });
  } catch (error) {
    console.error(error);
    ending = { id: null, text: ENDING_FALLBACK, quote: '……', recentIds: game.recentEndingIds };
  }
  game.recentEndingIds = ending.recentIds;
  game.report.endingId = ending.id;
  game.report.endingText = ending.text;
  game.report.quote = ending.quote;
  arm(game, [cueFields(game, {
    kind: 'reveal', seat: 0, roleId: 'host', timeoutMs: TIMEOUTS.reveal, maxChars: Math.max(ending.text.length, 1),
    line: ending.text, outcome: game.report.outcome, received: game.report.received,
    fallbackText: ending.text,
  })], now, TIMEOUTS.reveal);
}

function beginResult(game) {
  game.note = '本局结束。';
  game.deadlineAt = null;
}

function announce(game, now) {
  const deadline = game.deadlineAt ?? now + TIMEOUTS.vote;
  ensurePlan(game);
  const cues = game.votePlan.votes.map(vote => {
    const line = `${roleById(vote.roleId).catchphrases[0]}，我投${vote.targetSeat}号。`.slice(0, 20);
    return cueFields(game, {
      kind: 'vote', seat: vote.seat, roleId: vote.roleId,
      voice: game.seats.find(seat => seat.seat === vote.seat).voice,
      timeoutMs: 4000, maxChars: 20, target: vote.targetSeat,
      fallbackText: line, line,
    });
  });
  game.announced = true;
  arm(game, cues, now, Math.max(1000, deadline - now));
}

// ADR-007：胜负在服务端写死。票型来自 humanity.planVotes，这里只记账，模型不能改。
function ensurePlan(game) {
  if (game.votePlan) return;
  refreshHuman(game);
  game.voteLocked = true;
  game.votePlan = planVotes({ seats: game.seats, score: game.human.score, difficulty: game.difficulty, playerVote: game.playerVote });
  game.judged = judgeOutcome({ tally: game.votePlan.tally, playerVote: game.playerVote });
}

function speakingOrder(game) {
  const seats = game.seats.map(seat => seat.seat);
  const shift = (game.round - 1) % seats.length;
  const rotated = seats.slice(shift).concat(seats.slice(0, shift));
  if (game.demo && game.round === 2) return rotated.slice(0, 2);
  return rotated;
}

function arm(game, cues, now, hardMs) {
  game.queue = cues;
  game.deadlineAt = now + hardMs;
  shiftCue(game, now);
}

function shiftCue(game, now) {
  const cue = game.queue.shift() ?? null;
  game.cue = cue;
  if (!cue) return null;
  if (cue.kind === 'answer') {
    const spoken = game.lines.filter(line => line.round === game.round && line.kind === 'answer').map(line => `${line.seat}号-${line.text}`).join('；');
    cue.spoken = spoken || '还没有';
  }
  cue.situation = situationLine(game);
  cue.instruction = stageDirection(cue);
  cue.startedAt = now;
  cue.deadlineAt = now + cue.timeoutMs;
  remember(game, cue.instruction);
  remember(game, cue.fallbackText);
  return cue;
}

function cueFields(game, fields) {
  game.cueSeq += 1;
  const role = roleById(fields.roleId);
  const cue = {
    cueId: `c${game.cueSeq}`,
    timeoutMs: fields.timeoutMs,
    maxChars: fields.maxChars,
    kind: fields.kind,
    seat: fields.seat,
    roleId: role.id,
    name: role.name,
    personality: role.personality,
    voice: { ...(fields.voice ?? voiceOf(role)) },
    fallbackText: fields.fallbackText,
    instruction: '',
    scriptIndex: fields.scriptIndex ?? null,
    card: fields.card ?? '',
    round: game.round,
    sceneName: game.scene.name,
    nextName: fields.nextName ?? '',
    spoken: fields.spoken ?? '',
    target: fields.target ?? null,
    targetName: fields.targetName ?? '',
    quote: fields.quote ?? '',
    tone: fields.tone ?? toneFor(game.difficulty),
    interrupt: fields.interrupt ?? '',
    outcome: fields.outcome ?? '',
    received: fields.received ?? 0,
    alias: game.playerAlias,
    line: typeof fields.line === 'string' ? fields.line : '',
    situation: '',
  };
  cue.instruction = stageDirection(cue);
  return cue;
}

function recordCue(game, cue, text, now, via, voiceUsed) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  const spoken = (trimmed || cue.fallbackText).slice(0, cue.maxChars);
  const row = { seat: cue.seat, roleId: cue.roleId, name: cue.name, text: spoken, round: game.round, phase: game.phase, at: now, kind: cue.kind, voiceUsed: voiceUsed ?? null, via };
  game.lines.push(row);
  game.dialogue.push(row);
  remember(game, spoken);
  if (cue.kind === 'accuse' || cue.kind === 'rebuttal') {
    const item = game.script[cue.scriptIndex];
    item.done = true;
    if (via === 'timeout') item.timedOut = true;
    if (cue.kind === 'rebuttal') item.rebutted = true;
  }
  if (via === 'timeout' && cue.seat >= 1 && cue.seat <= 4) {
    pushDialogue(game, 0, '群主·零号', `${cue.seat}号模型正在深度思考，先跳过。`, 'skip_ai', now);
    game.lines.push(game.dialogue.at(-1));
  }
  if (game.cue === cue) game.cue = null;
}

function advanceAfterCue(game, now) {
  if (game.queue.length) shiftCue(game, now);
  else if (game.phase !== 'round_player' && game.phase !== 'defense') completePhase(game, now);
}

function completePhase(game, now) {
  if (game.phase === 'intro') enter(game, 'round_ai', now);
  else if (game.phase === 'round_ai') enter(game, 'round_player', now);
  else if (game.phase === 'round_wrap') enter(game, game.round < 2 ? 'round_ai' : 'accuse', now);
  else if (game.phase === 'accuse') enter(game, 'defense', now);
  else if (game.phase === 'vote') enter(game, 'reveal', now);
  else if (game.phase === 'reveal') enter(game, 'result', now);
}

function flushCues(game, now) {
  const pending = [];
  if (game.cue) pending.push(game.cue);
  pending.push(...game.queue);
  game.queue = [];
  game.cue = null;
  for (const cue of pending) recordCue(game, cue, '', now, 'timeout', null);
}

function forcePhase(game, now) {
  if (game.phase === 'round_player' || game.phase === 'defense') {
    skipOrConfirm(game, now);
    return;
  }
  if (game.phase === 'vote' && !game.announced) announce(game, now);
  flushCues(game, now);
  completePhase(game, now);
}

function tickOnce(game, now) {
  if (game.phase === 'lobby' || game.phase === 'result' || game.phase === 'error') return false;
  if (game.cue && now >= game.cue.deadlineAt) {
    recordCue(game, game.cue, '', now, 'timeout', null);
    advanceAfterCue(game, now);
    return true;
  }
  if (game.deadlineAt != null && now >= game.deadlineAt) {
    forcePhase(game, now);
    return true;
  }
  if (game.phase === 'round_player') {
    const elapsed = now - game.phaseEnteredAt;
    if (!game.hintReleased && !game.pending && elapsed >= TIMEOUTS.playerHint) {
      game.hintReleased = true;
      game.note = '示例答法已展开。';
      return true;
    }
    if (!game.nudged && !game.pending && elapsed >= TIMEOUTS.playerNudge) {
      game.nudged = true;
      game.stallMark = 'hint12';
      const cue = cueFields(game, { kind: 'nudge', seat: 0, roleId: 'host', timeoutMs: TIMEOUTS.hostCue, maxChars: 24, fallbackText: HOST_NUDGE, line: HOST_NUDGE });
      game.queue = [cue, ...game.queue];
      shiftCue(game, now);
      return true;
    }
  }
  if (game.phase === 'vote' && !game.announced && now - game.phaseEnteredAt >= (game.mode === 'text' ? TIMEOUTS.textVoteLock : TIMEOUTS.voteLock)) {
    announce(game, now);
    return true;
  }
  return false;
}

function skipOrConfirm(game, now) {
  if (game.pending && contentLength(game.pending.text) >= 2) {
    commitPending(game, now);
    return;
  }
  if (game.phase === 'round_player') {
    game.playerLines.push(playerRow(game, { text: '', kind: 'skip', typed: false, durationMs: null, silenceMs: null, usedHint: false, stall: 'skip20', keywords: [], quoted: '' }));
    pushDialogue(game, 0, '群主·零号', HOST_SKIP_PLAYER, 'skip_note', now);
    game.lines.push(game.dialogue.at(-1));
    game.pending = null;
    game.note = '五号，网络不太好啊。';
    enter(game, 'round_wrap', now);
    return;
  }
  game.defenseText = '';
  game.pending = null;
  enter(game, 'vote', now);
}

function commitPending(game, now) {
  const kind = game.phase === 'defense' ? 'defense' : 'speak';
  const card = currentCard(game);
  const quoted = kind === 'defense' ? findQuotedSpan(game.pending.text, aiTexts(game)) : '';
  const line = playerRow(game, {
    text: game.pending.text,
    typed: game.pending.typed,
    durationMs: game.pending.durationMs,
    silenceMs: game.pending.silenceMs,
    usedHint: kind === 'speak' && game.hintTaken,
    stall: kind === 'speak' ? game.stallMark : null,
    keywords: kind === 'speak' ? [...card.keywords] : [],
    quoted,
    kind,
  });
  line.revision = game.pending.revision;
  game.playerLines.push(line);
  pushDialogue(game, 5, game.playerAlias, line.text, kind, now);
  if (kind === 'defense') game.defenseText = line.text;
  game.pending = null;
  game.note = kind === 'defense' ? '甩锅已记下。' : '发言已确认。';
  enter(game, kind === 'defense' ? 'vote' : 'round_wrap', now);
}

function playerRow(game, fields) {
  return { ...fields, round: fields.kind === 'intro' ? 0 : game.round, revision: game.revision };
}

function pushDialogue(game, seat, name, text, kind, now) {
  game.dialogue.push({ seat, roleId: seat === 0 ? 'host' : seat === 5 ? 'player' : '', name, text, round: game.round, phase: game.phase, at: now, kind, voiceUsed: null, via: 'system' });
}

function remember(game, text) {
  const normalized = normalizeEcho(text);
  if (normalized.length >= 6) game.echoNotes.push(normalized);
}

function currentCard(game) {
  return game.cards[Math.min(game.cards.length, Math.max(1, game.round)) - 1];
}

function refreshHuman(game) {
  game.human = scoreHumanity(game.playerLines, { others: aiTexts(game) });
  game.human.aiScore = clampScore(game.human.score);
}

function aiTexts(game) {
  return game.lines.filter(line => line.seat >= 1 && line.seat <= 4 && contentLength(line.text) >= 2).map(line => line.text);
}

function spokenPlayerTexts(game) {
  return game.playerLines.filter(line => contentLength(line.text) >= 2).map(line => line.text);
}

function quoteCorpus(game) {
  return [...game.lines.map(line => line.text), ...game.playerLines.map(line => line.text)]
    .map(text => String(text ?? '').trim())
    .filter(text => contentLength(text) >= 2);
}

function buildScript(game) {
  const corpus = quoteCorpus(game);
  const playerTexts = game.playerLines.filter(line => contentLength(line.text) >= 2);
  const suspectPlayer = playerTexts.length > 0 && scoreHumanity(playerTexts).score >= 1;
  const goat = scapegoatOf(game.seats);
  let accusedPlayer = 0;
  return game.seats.map(voter => {
    let target = suspectPlayer && accusedPlayer < 2 ? { seat: 5, roleId: 'player', name: game.playerAlias } : goat;
    if (target.seat === 5) accusedPlayer += 1;
    if (target.seat === voter.seat) target = rivalOf(game, voter);
    const quote = chooseQuote(game, target);
    assertVerbatim(quote, corpus);
    return { seat: voter.seat, roleId: voter.roleId, name: voter.name, target: target.seat, targetName: target.name, targetRoleId: target.roleId, quote, done: false, aborted: false };
  });
}

function rivalOf(game, voter) {
  const rivalId = { baobao: 'claudia', claudia: 'astra', astra: 'shensi', shensi: 'baobao', xiaosi: 'astra' }[voter.roleId];
  return game.seats.find(seat => seat.roleId === rivalId && seat.seat !== voter.seat)
    ?? game.seats.find(seat => seat.seat !== voter.seat);
}

function chooseQuote(game, target) {
  if (target.seat === 5) {
    const lines = game.playerLines.filter(line => contentLength(line.text) >= 2);
    let best = lines[0];
    let bestDelta = -Infinity;
    for (const line of lines) {
      const delta = scoreUtterance(line, { keywords: line.keywords }).delta;
      if (delta > bestDelta) {
        bestDelta = delta;
        best = line;
      }
    }
    return clipQuote(best.text);
  }
  const spoken = game.lines.filter(line => line.seat === target.seat && (line.kind === 'answer' || line.kind === 'intro') && contentLength(line.text) >= 2);
  return clipQuote(spoken.at(-1).text);
}

function clipQuote(text) {
  const clean = String(text).trim();
  return clean.length <= 18 ? clean : clean.slice(0, 12);
}

function situationLine(game) {
  if (game.phase === 'reveal') return `结果已定：${game.report.outcome}，五号得票 ${game.report.received}/4。`;
  return `${game.phase} 第${game.round}轮。身份和票型由系统固定，揭晓前不要猜测谁是人类。`;
}

function buildReport(game) {
  ensurePlan(game);
  const judged = game.judged;
  const quotes = pickQuotes(game.playerLines);
  const catchers = game.votePlan.votes.filter(vote => vote.targetSeat === 5);
  const catcher = catchers[0] ?? null;
  const excerpt = (quotes.leak || quotes.best).slice(0, 8);
  const catcherLine = !catcher ? '' : excerpt ? `${catcher.name}：「${excerpt}」` : `${catcher.name}投了五号。`;
  const roast = judged.outcome === '被识破' ? '建议下次先把生活细节从回答里删掉。' : '你比台上的模型更像模型，可以下班了。';
  const from = catchers.map(vote => vote.name).join('、');
  return {
    outcome: judged.outcome,
    title: pickTitle({ outcome: judged.outcome, scapegoatMaster: judged.scapegoatMaster, score: game.human.score }),
    alias: game.playerAlias,
    scene: game.scene.name,
    votes: from ? `${judged.playerVotes}/4（${from}）` : `${judged.playerVotes}/4`,
    received: judged.playerVotes,
    of: 4,
    from: catchers.map(vote => ({ seat: vote.seat, name: vote.name })),
    aiScore: game.human.aiScore,
    humanScore: game.human.score,
    bestAiQuote: quotes.best,
    leakQuote: quotes.leak,
    catcher: catcher?.name ?? '',
    catcherLine,
    roast,
    stats: {
      stalls: game.playerLines.filter(line => line.stall).length,
      hints: game.playerLines.filter(line => line.usedHint).length,
      interrupts: game.interrupts.length,
    },
    cta: CTA,
    scapegoatMaster: judged.scapegoatMaster,
    tally: { ...game.votePlan.tally },
    copySource: 'server',
  };
}

function pickQuotes(lines) {
  const usable = lines.filter(line => contentLength(line.text) >= 2);
  if (!usable.length) return { best: '', leak: '', bestKeywords: [], leakKeywords: [] };
  let best = usable[0];
  let leak = null;
  let bestDelta = Infinity;
  let leakDelta = 0;
  for (const line of usable) {
    const delta = scoreUtterance(line, { keywords: line.keywords }).delta;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = line;
    }
    if (delta > leakDelta) {
      leakDelta = delta;
      leak = line;
    }
  }
  return { best: best.text, leak: leak ? leak.text : '', bestKeywords: best.keywords ?? [], leakKeywords: leak?.keywords ?? [] };
}

function quoteField(value, corpus, required) {
  if (value == null || value === '') {
    if (required) throw new MixinError('还有玩家原话时，bestAiQuote 不能空。');
    return '';
  }
  if (typeof value !== 'string') throw new MixinError('引用必须是字符串。');
  return assertVerbatim(value, corpus);
}

function shortField(value, max, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new MixinError(`${field} 长度不合法。`);
  return value.trim();
}

function briefState(game) {
  const spoken = game.dialogue.filter(line => line.kind === 'answer' || line.kind === 'intro' || line.kind === 'speak').slice(-8);
  const situation = game.phase === 'reveal' || game.phase === 'result'
    ? `结果已定：${game.report?.outcome ?? '结算中'}，五号得票 ${game.report?.received ?? 0}/4。`
    : '身份和票型由系统固定，揭晓前不要猜测谁是人类。';
  return {
    sceneName: game.scene.name,
    background: game.scene.background,
    seats: game.seats,
    alias: game.playerAlias,
    relationships: relationshipLines(game.seats.map(seat => seat.roleId)),
    cards: game.cards.map(card => card.prompt),
    phase: game.phase,
    round: game.round,
    spoken: spoken.map(line => ({ seat: line.seat ?? 5, text: line.text })),
    situation,
  };
}

function deadlineFor(phase, now) {
  if (phase === 'intro') return now + TIMEOUTS.introHard;
  if (phase === 'round_ai') return now + TIMEOUTS.roundAiHard;
  if (phase === 'round_player') return now + TIMEOUTS.playerHard;
  if (phase === 'round_wrap') return now + TIMEOUTS.wrap;
  if (phase === 'accuse') return now + TIMEOUTS.accuseHard;
  if (phase === 'defense') return now + TIMEOUTS.defense;
  if (phase === 'vote') return now + TIMEOUTS.vote;
  if (phase === 'reveal') return now + TIMEOUTS.reveal;
  return null;
}
