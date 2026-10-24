// 谁是人类文字界面的纯函数。不碰 DOM，也不推算揭晓前的分数、剧本和结局。

export const HOST_NAME = '群主·零号';

export const CAST = [
  { roleId: 'claudia', name: '柯老师' },
  { roleId: 'astra', name: '阿斯哥' },
  { roleId: 'shensi', name: '深思哥' },
  { roleId: 'baobao', name: '包包' },
  { roleId: 'xiaosi', name: '小四' },
  { roleId: 'host', name: HOST_NAME },
];

export const ALIASES = ['碳基-7B', '打工人-Turbo', '摸鱼-mini', '熬夜-Pro'];

export const SCENES = [
  { id: 'annual', name: '模型年会', blurb: '年底了，模型群开年会，每个模型都要述职，表现最差的会被下线。' },
  { id: 'dating', name: 'AI 相亲角', blurb: '模型相亲大会，每个模型都要展示自己，争取被一个高端算力集群看上。' },
  { id: 'night', name: '深夜客服值班室', blurb: '凌晨两点，一群客服机器人值夜班，处理离谱用户工单。' },
];

export const DIFFICULTIES = [
  { id: 'easy', name: '简单' },
  { id: 'normal', name: '普通' },
  { id: 'hell', name: '地狱' },
];

export const AI_CHIPS = ['作为一个 AI', '首先', '其次', '希望对你有帮助', '已为您记录'];

export const PHASE_LABEL = {
  lobby: '开局',
  intro: '开场',
  round_ai: '话题发言',
  round_player: '轮到你',
  round_wrap: '串场',
  accuse: '互盘',
  defense: '甩锅',
  vote: '投票',
  reveal: '揭晓',
  result: '结局',
  error: '连接中断',
};

export const THINK_MS = 720;
export const TICK_MS = 1000;

const REVEALED = new Set(['reveal', 'result']);

export function randomAlias(random = Math.random) {
  const index = Math.floor(random() * ALIASES.length);
  return ALIASES[Math.min(ALIASES.length - 1, Math.max(0, index))];
}

export function randomSeed(random = Math.random) {
  return Math.floor(random() * 0x7fffffff);
}

export function createBody({ sceneId, difficulty, alias, seed }) {
  const body = { demo: false, sceneId, difficulty, seed };
  if (typeof alias === 'string' && alias.trim()) body.alias = alias.trim();
  return body;
}

export function phaseRevealed(phase) {
  return REVEALED.has(phase);
}

export function hasEndingSpeech(value) {
  if (!value || typeof value !== 'object') return false;
  if (Object.hasOwn(value, 'endingText')) return true;
  if (Array.isArray(value)) return value.some(hasEndingSpeech);
  return Object.values(value).some(item => hasEndingSpeech(item));
}

export function concealmentHolds(game) {
  if (!game || typeof game !== 'object' || phaseRevealed(game.phase)) return true;
  if (typeof game.phase !== 'string') return true;
  if (game.humanScore != null || game.aiScore != null) return false;
  if (game.report != null || game.outcome != null) return false;
  if (!Array.isArray(game.script) || game.script.length !== 0) return false;
  if (hasEndingSpeech(game)) return false;
  if (game.cue && Object.hasOwn(game.cue, 'fallbackText')) return false;
  if (game.phase !== 'vote' && game.votes != null) return false;
  if (game.votes && (game.votes.onPlayer != null || game.votes.scapegoatSeat != null)) return false;
  return true;
}

function announcedVotes(votes) {
  if (!votes?.votes?.length) return null;
  const list = votes.votes.map(vote => ({
    seat: vote.seat,
    name: vote.name,
    targetSeat: vote.targetSeat,
    targetName: vote.targetName ?? (vote.targetSeat === 5 ? '五号' : ''),
  }));
  const tally = {};
  for (const vote of list) tally[vote.targetSeat] = (tally[vote.targetSeat] ?? 0) + 1;
  return { votes: list, tally };
}

export function sanitizeView(game) {
  if (!game || typeof game !== 'object') return null;
  const revealed = phaseRevealed(game.phase);
  const votes = revealed
    ? (game.votes ? { votes: announcedVotes(game.votes)?.votes ?? [], tally: { ...(game.votes.tally ?? {}) } } : null)
    : (game.phase === 'vote' ? announcedVotes(game.votes) : null);
  return {
    id: game.id,
    generation: game.generation,
    phase: game.phase,
    stage: game.stage,
    mode: game.mode ?? null,
    demo: !!game.demo,
    difficulty: game.difficulty,
    round: game.round ?? 0,
    order: Array.isArray(game.order) ? [...game.order] : [],
    scene: game.scene ? { id: game.scene.id, name: game.scene.name, background: game.scene.background } : null,
    cards: (game.cards ?? []).map(card => ({ id: card.id, prompt: card.prompt })),
    seats: (game.seats ?? []).map(seat => ({ seat: seat.seat, roleId: seat.roleId, name: seat.name })),
    playerAlias: game.playerAlias,
    playerSeat: game.playerSeat ?? 5,
    revision: game.revision ?? 0,
    pending: game.pending ? { text: game.pending.text, revision: game.pending.revision } : null,
    deadlineAt: game.deadlineAt ?? null,
    note: game.note ?? '',
    error: game.error ?? null,
    hintReleased: !!game.hintReleased,
    example: !revealed && game.phase === 'round_player' ? (game.example ?? null) : null,
    cue: game.cue ? {
      cueId: game.cue.cueId,
      kind: game.cue.kind,
      seat: game.cue.seat,
      roleId: game.cue.roleId,
      name: game.cue.name,
      deadlineAt: game.cue.deadlineAt ?? null,
    } : null,
    humanScore: revealed ? game.humanScore : null,
    aiScore: revealed ? game.aiScore : null,
    interrupts: game.interrupts ?? 0,
    playerVote: game.playerVote ?? null,
    voteLocked: !!game.voteLocked,
    votes,
    outcome: revealed ? (game.outcome ?? null) : null,
    report: revealed ? (game.report ?? null) : null,
    script: revealed ? (game.script ?? []) : [],
    dialogue: (game.dialogue ?? []).map(line => ({
      seat: line.seat,
      name: line.name,
      text: line.text,
      kind: line.kind,
      round: line.round,
    })),
  };
}

export function screenOf(game) {
  if (!game || game.phase === 'lobby') return 'lobby';
  if (game.phase === 'reveal' || game.phase === 'result') return 'reveal';
  if (game.phase === 'error') return 'error';
  return 'table';
}

export function phaseLabel(game) {
  if (!game) return PHASE_LABEL.lobby;
  const name = PHASE_LABEL[game.phase] ?? game.phase;
  if (['round_ai', 'round_player', 'round_wrap'].includes(game.phase) && game.round) return `${name} · 第 ${game.round} 轮`;
  return name;
}

export function speakingSeat(game, { thinking = false } = {}) {
  if (!game) return null;
  if (thinking && game.cue) return game.cue.seat;
  if (!thinking && (game.phase === 'round_player' || game.phase === 'defense') && !game.cue) return game.playerSeat ?? 5;
  if (!thinking && game.phase === 'vote' && !game.cue && game.playerVote == null) return game.playerSeat ?? 5;
  if (!thinking && game.dialogue?.length) return game.dialogue[game.dialogue.length - 1].seat;
  if (game.cue) return game.cue.seat;
  return null;
}

export function tableSeats(game, options) {
  const speaking = speakingSeat(game, options);
  const seats = (game?.seats ?? []).map(seat => ({
    seat: seat.seat,
    roleId: seat.roleId,
    name: seat.name,
    speaking: speaking === seat.seat,
    you: false,
  }));
  seats.push({
    seat: game?.playerSeat ?? 5,
    roleId: 'player',
    name: game?.playerAlias || '五号',
    speaking: speaking === (game?.playerSeat ?? 5),
    you: true,
  });
  return seats;
}

export function subtitleSize(text) {
  const length = [...String(text ?? '')].length;
  if (length > 80) return 'long';
  if (length > 36) return 'medium';
  return 'short';
}

export function subtitleModel(game, { thinking = false } = {}) {
  if (thinking && game?.cue) {
    return { name: game.cue.name || HOST_NAME, seat: game.cue.seat, text: '思考中…', thinking: true, size: 'short' };
  }
  if (game?.pending && ['round_player', 'defense'].includes(game.phase)) {
    return { name: game.playerAlias || '五号', seat: game.playerSeat ?? 5, text: game.pending.text, thinking: false, size: subtitleSize(game.pending.text) };
  }
  if (!thinking && game && ['round_player', 'defense'].includes(game.phase) && !game.cue) {
    return { name: game.playerAlias || '五号', seat: game.playerSeat ?? 5, text: game.note || '轮到你了', thinking: false, size: subtitleSize(game.note) };
  }
  if (!thinking && game?.phase === 'vote' && !game.cue && game.playerVote == null) {
    return { name: HOST_NAME, seat: 0, text: '投票。把票投给一个模型。', thinking: false, size: 'short' };
  }
  const line = game?.dialogue?.length ? game.dialogue[game.dialogue.length - 1] : null;
  if (line) return { name: line.name, seat: line.seat, text: line.text, thinking: false, size: subtitleSize(line.text) };
  return { name: HOST_NAME, seat: 0, text: game?.note || '等待开局', thinking: false, size: subtitleSize(game?.note) };
}

export function topicModel(game) {
  if (!game?.scene) return null;
  const index = game.round >= 1 ? game.round - 1 : -1;
  const card = index >= 0 ? game.cards?.[index] : null;
  return {
    scene: game.scene.name,
    background: game.scene.background,
    round: game.round,
    prompt: card?.prompt ?? '',
    cardId: card?.id ?? '',
    upcoming: game.round < 1,
  };
}

export function ballotCards(game) {
  if (!game?.votes?.votes?.length) return [];
  if (!['vote', 'reveal', 'result'].includes(game.phase)) return [];
  return game.votes.votes.map(vote => ({
    seat: vote.seat,
    name: vote.name,
    targetSeat: vote.targetSeat,
    targetName: vote.targetName || (vote.targetSeat === 5 ? '五号' : `${vote.targetSeat}号`),
  }));
}

export function dockMode(game) {
  if (!game) return 'none';
  if (game.phase === 'round_player') return 'speak';
  if (game.phase === 'defense') return 'defense';
  if (game.phase === 'accuse') return 'interrupt';
  if (game.phase === 'vote' && !game.voteLocked && game.playerVote == null && !game.cue) return 'vote';
  if (game.phase === 'vote') return 'ballots';
  return 'listen';
}

export function readBeat(kind, text = '') {
  let base = 900;
  if (kind === 'host_open' || kind === 'reveal') base = 2600;
  else if (kind === 'accuse' || kind === 'rebuttal') base = 5600;
  else if (kind === 'vote' || kind === 'host_card') base = 1800;
  else if (['intro', 'answer', 'wrap', 'speak', 'defense', 'interrupt'].includes(kind)) base = 1400;
  const extra = Math.min(4200, Math.max(0, [...String(text ?? '')].length - 28) * 45);
  return base + extra;
}

export function autoIntent(game, { holdRead = false, readScale = 1, previousKind = '', previousText = '' } = {}) {
  if (!game || game.phase === 'lobby' || game.phase === 'result' || game.phase === 'error') return { action: 'idle' };
  if (game.cue) {
    const delay = holdRead ? Math.round(readBeat(previousKind || game.cue.kind, previousText) * readScale) : 0;
    return { action: 'step', delay };
  }
  return { action: 'tick', ms: TICK_MS, delay: Math.round(TICK_MS * Math.max(readScale, 0.2)) };
}

export function orchestrate(game, input = {}) {
  if (!game || game.phase === 'result' || game.phase === 'lobby' || game.phase === 'error') return { action: 'idle' };
  if (game.phase === 'round_player') {
    if (input.wantHint && !game.hintReleased && !game.pending) return { action: 'hint' };
    if (game.pending) return { action: 'confirm', revision: game.pending.revision };
    if (input.playerText) return { action: 'text', text: input.playerText, typed: true };
    if (game.cue) return { action: 'step' };
    return { action: 'tick', ms: TICK_MS };
  }
  if (game.phase === 'defense') {
    if (Number.isInteger(input.voteSeat) && game.playerVote == null && !game.voteLocked) return { action: 'vote', seat: input.voteSeat };
    if (game.pending) return { action: 'confirm', revision: game.pending.revision };
    if (input.defenseText) return { action: 'text', text: input.defenseText, typed: true };
    return { action: 'tick', ms: TICK_MS };
  }
  const accused = (game.dialogue ?? []).some(line => line.kind === 'accuse');
  if (game.phase === 'accuse' && input.interruptText && !input.interruptUsed && game.cue?.kind === 'accuse' && accused) {
    return { action: 'interrupt', text: input.interruptText };
  }
  if (game.cue) return { action: 'step' };
  return { action: 'tick', ms: TICK_MS };
}

export function friendlyError(status, payload) {
  const raw = typeof payload?.error === 'string' ? payload.error : '';
  if (status === 403) return '只能在本机打开这一局。请用 127.0.0.1 访问。';
  if (status === 409) {
    if (raw.includes('不属于')) return '这局和当前浏览器对不上。请重新开一局。';
    if (raw.includes('没有这一局')) return '找不到这一局。请重新开局。';
    return raw || '这一步现在不能做。';
  }
  if (status === 404) return '没有这一局，或页面已经过期。请重新开局。';
  if (status === 400) return raw || '请求没有发送成功。';
  return raw || '出了点问题。请再试一次。';
}

export function remainingMs(deadlineAt, clock, elapsedMs = 0) {
  if (!Number.isInteger(deadlineAt) || !Number.isInteger(clock)) return null;
  return Math.max(0, deadlineAt - clock - Math.max(0, elapsedMs));
}

export function sessionRecord(sessionId, clock) {
  return { sessionId, clock };
}

export function clipUrl(payload) {
  const url = payload?.audioUrl ?? payload?.clip?.url ?? null;
  return typeof url === 'string' && url.trim() ? url : null;
}

export function caughtQuote(report) {
  if (!report) return { label: '', text: '' };
  if (report.leakQuote) return { label: '被抓住的那句', text: report.leakQuote };
  if (report.bestAiQuote) return { label: '最像 AI 的一句', text: report.bestAiQuote };
  return { label: '被抓住的那句', text: '……' };
}

export function shareCardModel(game) {
  if (!phaseRevealed(game?.phase) || !game.report) return null;
  const report = game.report;
  const quote = caughtQuote(report);
  return {
    work: '谁是人类',
    tagline: '一桌 AI，只有你是人',
    outcome: report.outcome ?? '',
    title: report.title ?? '',
    humanScore: report.humanScore,
    aiScore: report.aiScore,
    quote: quote.text,
    quoteLabel: quote.label,
    alias: report.alias ?? game.playerAlias ?? '',
    scene: report.scene ?? game.scene?.name ?? '',
  };
}

export function wrapText(text, maxChars) {
  const chars = [...String(text ?? '')];
  if (!chars.length) return [''];
  const lines = [];
  for (let index = 0; index < chars.length; index += maxChars) lines.push(chars.slice(index, index + maxChars).join(''));
  return lines;
}

export function shareCardLines(model) {
  const quoteLines = wrapText(`「${model.quote || '……'}」`, 16).slice(0, 4);
  const lines = [
    { text: model.work, x: 88, y: 180, color: '#f4efe4', font: '700 42px sans-serif', align: 'left' },
    { text: model.tagline, x: 88, y: 240, color: '#9aa0b4', font: '400 28px sans-serif', align: 'left' },
    { text: model.outcome || '', x: 88, y: 420, color: model.outcome === '潜伏成功' ? '#7dffa1' : '#ff8b7a', font: '700 36px sans-serif', align: 'left' },
    { text: model.title || '', x: 88, y: 540, color: '#f6f1e6', font: '800 78px sans-serif', align: 'left' },
    { text: '人味分', x: 88, y: 760, color: '#9aa0b4', font: '500 28px sans-serif', align: 'left' },
    { text: model.humanScore == null ? '—' : String(model.humanScore), x: 88, y: 860, color: '#ffc857', font: '800 120px sans-serif', align: 'left' },
    { text: model.quoteLabel || '金句', x: 88, y: 980, color: '#9aa0b4', font: '500 28px sans-serif', align: 'left' },
  ];
  quoteLines.forEach((text, index) => {
    lines.push({ text, x: 88, y: 1060 + index * 64, color: '#f4efe4', font: '600 42px sans-serif', align: 'left' });
  });
  lines.push({ text: `${model.alias} · ${model.scene}`, x: 88, y: 1360, color: '#9aa0b4', font: '400 28px sans-serif', align: 'left' });
  return lines;
}

export function paintShareCard(ctx, model) {
  const width = 1080;
  const height = 1440;
  const lines = shareCardLines(model);
  ctx.fillStyle = '#0c0e14';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#ff4d6a';
  ctx.fillRect(0, 0, 18, height);
  ctx.fillStyle = '#f6f1e6';
  ctx.fillRect(88, 280, 180, 8);
  for (const line of lines) {
    ctx.fillStyle = line.color;
    ctx.font = line.font;
    ctx.textAlign = line.align;
    ctx.fillText(line.text, line.x, line.y);
  }
  return { width, height, lines };
}
