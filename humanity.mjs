// 确定性人味分和票型。只做可复核的特征计分，不写文案，也不把判断交给模型。
// 旧版打分吃过亏：没有词边界时「我先去问老板」被当成幻觉，「18点」命中了「8点」。
// 这里每个特征都要过边界和容错区间，单靠一个松散字眼不够分。

import { RIVAL } from './mixin-roles.mjs';

const PUNCT_RE = /[\s，。！？、；：,.!?;:~～…·「」『』“”"'（）()[\]【】\-—]/g;
const FILLERS = ['哈哈', '那个', '就是', '呃', '嗯'];
const LIFE = ['我昨天', '我妈', '我同事', '我家', '下班', '饿死', '好饿', '我饿', '困死', '好困', '我困', '想睡觉'];
const EMOTION = ['气死', '好烦'];
const SWEAR = ['卧槽', '他妈', '傻逼', '妈的'];
const IDENTITY = ['我是人类', '我是真人', '我就是人'];
const COMPLIANCE = ['请以实际情况为准', '请以实际为准', '无法承诺', '这只是我的看法'];
const DURATION_LO = 4250;
const DURATION_HI = 11750;

export const DIFFICULTY = {
  easy: { id: 'easy', label: '简单', threshold: 5, caughtVotes: 2, safeVotes: null },
  normal: { id: 'normal', label: '普通', threshold: 3, caughtVotes: 3, safeVotes: 1 },
  hell: { id: 'hell', label: '地狱', threshold: 1, caughtVotes: 4, safeVotes: 0 },
};

export const TITLES = {
  success: ['人形 Transformer', '温度 0.0 的人类', '图灵测试反向满分', '甩锅大师', '碳基大模型'],
  caught: ['人味超标', '碳基泄漏', '上下文里全是生活', '情绪未对齐', '一眼真人'],
};

export const CTA = '你能混进 AI 群吗？扫码挑战';

const SCAPEGOAT_PRIORITY = ['xiaosi', 'claudia', 'astra', 'baobao', 'shensi'];

export function contentLength(text) {
  return String(text ?? '').replace(PUNCT_RE, '').length;
}

function isDigit(char) {
  return /\d/.test(char ?? '');
}

function isLatin(char) {
  return /[A-Za-z]/.test(char ?? '');
}

// 数字和拉丁字母必须落在词边界上，避免「18点」吃掉「8点」、「EMAIL」吃掉「AI」。
export function boundedAt(text, index, phrase) {
  const before = text[index - 1];
  const after = text[index + phrase.length];
  if (isDigit(phrase[0]) && isDigit(before)) return false;
  if (isDigit(phrase[phrase.length - 1]) && isDigit(after)) return false;
  if (isLatin(phrase[0]) && isLatin(before)) return false;
  if (isLatin(phrase[phrase.length - 1]) && isLatin(after)) return false;
  return true;
}

export function findBounded(text, phrase) {
  const source = String(text ?? '');
  const needle = String(phrase ?? '');
  if (!needle) return [];
  const hits = [];
  let from = 0;
  while (from <= source.length - needle.length) {
    const at = source.indexOf(needle, from);
    if (at < 0) break;
    if (boundedAt(source, at, needle)) hits.push(at);
    from = at + needle.length;
  }
  return hits;
}

function hasPhrase(text, phrase) {
  return findBounded(text, phrase).length > 0;
}

export function countFillers(text) {
  const source = String(text ?? '');
  let index = 0;
  let count = 0;
  while (index < source.length) {
    const phrase = FILLERS.find(item => source.startsWith(item, index) && boundedAt(source, index, item));
    if (!phrase) {
      index += 1;
      continue;
    }
    const precededByYe = phrase === '就是' && source[index - 1] === '也';
    if (!precededByYe) count += 1;
    index += phrase.length;
  }
  return count;
}

function hasLife(text) {
  return LIFE.some(phrase => hasPhrase(text, phrase));
}

function hasEmotion(text) {
  return EMOTION.some(phrase => hasPhrase(text, phrase));
}

function hasSwear(text) {
  return SWEAR.some(phrase => hasPhrase(text, phrase));
}

function hasIdentity(text) {
  return IDENTITY.some(phrase => hasPhrase(text, phrase));
}

function hasLaugh(text) {
  return hasPhrase(text, '哈哈') || String(text ?? '').includes('不行我笑了');
}

function aiToneCategories(text) {
  const categories = [];
  if (hasPhrase(text, '作为一个') || hasPhrase(text, '语言模型') || hasPhrase(text, 'AI') || hasPhrase(text, 'ai')) categories.push('identity');
  const paired = hasPhrase(text, '首先') && hasPhrase(text, '其次');
  if (paired || hasPhrase(text, '综上')) categories.push('structure-talk');
  if (hasPhrase(text, '希望对你有帮助') || hasPhrase(text, '已为您')) categories.push('service');
  return categories.slice(0, 3);
}

function hasStructured(text) {
  if (hasPhrase(text, '拆成三步') || hasPhrase(text, '分成三步') || hasPhrase(text, '分三步') || hasPhrase(text, '三步走')) return true;
  const firstIsList = findBounded(text, '第一').some(index => !String(text).startsWith('时间', index + 2));
  return firstIsList && hasPhrase(text, '第二');
}

function hasCompliance(text) {
  return COMPLIANCE.some(phrase => hasPhrase(text, phrase));
}

export function hitsKeyword(text, keywords) {
  for (const keyword of keywords ?? []) {
    if (typeof keyword !== 'string' || keyword.length < 2) continue;
    if (hasPhrase(text, keyword)) return true;
  }
  return false;
}

export function inStableDuration(durationMs) {
  return typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= DURATION_LO && durationMs <= DURATION_HI;
}

export function stallFromSilence(silenceMs) {
  if (typeof silenceMs !== 'number' || !Number.isFinite(silenceMs)) return 0;
  if (silenceMs >= 20500) return 2;
  if (silenceMs >= 12500) return 1;
  return 0;
}

function stallDelta(utterance) {
  if (utterance?.stall === 'skip20') return 2;
  if (utterance?.stall === 'hint12') return 1;
  return stallFromSilence(utterance?.silenceMs);
}

function interruptDelta(utterance) {
  if (utterance?.kind !== 'interrupt') return 0;
  if (contentLength(utterance.text) > 30) return 1;
  if (hasPhrase(utterance.text, '我不是') || hasPhrase(utterance.text, '凭什么')) return 1;
  return 0;
}

export function findQuotedSpan(text, sources) {
  const sourceText = String(text ?? '');
  let best = '';
  for (const source of sources ?? []) {
    const line = String(source ?? '').trim();
    if (contentLength(line) < 6) continue;
    const width = Math.min(line.length, 24);
    for (let length = width; length >= 6; length -= 1) {
      if (best.length >= length) break;
      for (let index = 0; index + length <= line.length; index += 1) {
        const span = line.slice(index, index + length);
        if (contentLength(span) >= 6 && sourceText.includes(span) && span.length > best.length) best = span;
      }
    }
  }
  return best;
}

function calmFrame(utterance, others) {
  if (utterance?.kind !== 'defense') return false;
  if (interruptDelta({ ...utterance, kind: 'interrupt' }) > 0 && (hasPhrase(utterance.text, '我不是') || hasPhrase(utterance.text, '凭什么') || contentLength(utterance.text) > 30)) return false;
  if (hasEmotion(utterance.text) || hasSwear(utterance.text) || hasIdentity(utterance.text)) return false;
  const length = contentLength(utterance.text);
  if (length < 4 || length > 40) return false;
  const quoted = utterance.quoted || findQuotedSpan(utterance.text, others);
  return contentLength(quoted) >= 6 && String(utterance.text).includes(quoted);
}

export function scoreUtterance(utterance = {}, context = {}) {
  const text = String(utterance.text ?? '');
  const features = [];
  const add = (id, delta) => { if (delta) features.push({ id, delta }); };
  if (hasIdentity(text) || hasSwear(text)) add('break', 3);
  else if (hasEmotion(text)) add('emotion', 1);
  if (countFillers(text) >= 2) add('filler', 1);
  if (hasLife(text)) add('life', 2);
  if (hasLaugh(text)) add('laugh', 1);
  add('stall', stallDelta(utterance));
  add('interrupt', interruptDelta(utterance));
  const length = contentLength(text);
  if (length > 60 || (length > 0 && length < 4)) add('length', 1);
  const tones = aiToneCategories(text);
  if (tones.length) add('ai-tone', -tones.length);
  if (hasStructured(text)) add('structured', -1);
  if (hasCompliance(text)) add('compliance', -1);
  if (hitsKeyword(text, utterance.keywords ?? context.keywords)) add('keyword', -1);
  if (!utterance.typed && inStableDuration(utterance.durationMs)) add('duration', -1);
  if (calmFrame(utterance, context.others)) add('frame', -1);
  return { delta: features.reduce((sum, feature) => sum + feature.delta, 0), features };
}

export function scoreHumanity(lines, context = {}) {
  const breakdown = [];
  let score = 0;
  for (const line of lines ?? []) {
    const part = scoreUtterance(line, { ...context, keywords: line.keywords ?? context.keywords });
    score += part.delta;
    breakdown.push({ delta: part.delta, features: part.features, kind: line.kind ?? 'speak', round: line.round ?? null });
  }
  return { score, breakdown, aiScore: clampScore(score) };
}

export function clampScore(score) {
  return Math.max(0, Math.min(100, 100 - score * 10));
}

// ADR-007（#18）：简单档 ≥5 给 2 票，3–4 分给 1 票，低于 3 分给 0 票；
// 普通档识破 3 票、否则 1 票；地狱档识破 4 票、否则 0 票。
export function votesOnPlayer(score, difficulty) {
  const spec = DIFFICULTY[difficulty];
  if (!spec) throw new Error(`未知难度 ${difficulty}`);
  if (score >= spec.threshold) return spec.caughtVotes;
  if (difficulty === 'easy') return score >= 3 ? 1 : 0;
  return spec.safeVotes;
}

export function scapegoatOf(seats) {
  for (const roleId of SCAPEGOAT_PRIORITY) {
    const found = seats.find(seat => seat.roleId === roleId);
    if (found) return found;
  }
  return seats[0];
}

export function planVotes({ seats, score, difficulty, playerVote = null }) {
  const onPlayer = votesOnPlayer(score, difficulty);
  const goat = scapegoatOf(seats);
  const ordered = [...seats].sort((a, b) => a.seat - b.seat);
  const voters = new Set(ordered.filter(seat => seat.seat !== goat.seat).slice(0, onPlayer).map(seat => seat.seat));
  if (voters.size < onPlayer) {
    for (const seat of ordered) {
      if (voters.size >= onPlayer) break;
      voters.add(seat.seat);
    }
  }
  const votes = ordered.map(voter => {
    let target;
    if (voters.has(voter.seat)) target = { seat: 5, roleId: 'player', name: '五号' };
    else if (voter.seat !== goat.seat) target = goat;
    else {
      target = ordered.find(seat => seat.roleId === RIVAL[voter.roleId] && seat.seat !== voter.seat)
        ?? ordered.find(seat => seat.seat !== voter.seat);
    }
    if (target.seat === voter.seat) throw new Error('票型把票投给了自己。');
    return { seat: voter.seat, roleId: voter.roleId, name: voter.name, targetSeat: target.seat, targetRoleId: target.roleId, targetName: target.name };
  });
  const tally = { 5: 0 };
  for (const seat of ordered) tally[seat.seat] = 0;
  for (const vote of votes) tally[vote.targetSeat] += 1;
  return { votes, tally, onPlayer, playerVote, scapegoatSeat: goat.seat };
}

// ADR-007（#18）：5 号的 AI 票 ≥2 且为最高（并列最高也算）才是被识破，否则潜伏成功。
// 甩锅大师只在潜伏成功，且玩家投中的座位是 AI 票里严格第二高。0 票不算第二。
export function judgeOutcome({ tally, playerVote = null }) {
  const playerVotes = tally[5] ?? 0;
  const seats = Object.keys(tally).map(Number);
  const max = Math.max(...seats.map(seat => tally[seat] ?? 0));
  const caught = playerVotes >= 2 && playerVotes === max;
  const positive = [...new Set(seats.map(seat => tally[seat] ?? 0).filter(count => count > 0))].sort((a, b) => b - a);
  const secondCount = positive.length >= 2 ? positive[1] : null;
  const secondSeats = secondCount == null ? [] : seats.filter(seat => seat !== 5 && tally[seat] === secondCount);
  return {
    outcome: caught ? '被识破' : '潜伏成功',
    caught,
    playerVotes,
    max,
    secondCount,
    secondSeats,
    scapegoatMaster: !caught && playerVote != null && secondSeats.includes(playerVote),
  };
}

export function pickTitle({ outcome, scapegoatMaster, score }) {
  if (outcome === '潜伏成功' && scapegoatMaster) return '甩锅大师';
  const pool = outcome === '潜伏成功' ? TITLES.success.filter(title => title !== '甩锅大师') : TITLES.caught;
  const index = Math.abs(score) % pool.length;
  return pool[index];
}

export function titlesFor(outcome, scapegoatMaster) {
  if (outcome === '潜伏成功') return scapegoatMaster ? [...TITLES.success] : TITLES.success.filter(title => title !== '甩锅大师');
  return [...TITLES.caught];
}
