// 确定性人味分和票型。只做可复核的特征计分，不写文案，也不把判断交给模型。
// 旧版打分吃过亏：没有词边界时「我先去问老板」被当成幻觉，「18点」命中了「8点」。
// 这里每个特征都要过边界和容错区间，单靠一个松散字眼不够分。

import { RIVAL } from './mixin-roles.mjs';

const PUNCT_RE = /[\s，。！？、；：,.!?;:~～…·「」『』“”"'（）()[\]【】\-—]/g;
// 「哈哈」只算笑声，不再同时算语气词。
const FILLERS = ['那个', '就是', '呃', '嗯'];
// before / after 是命中后要排除的相邻字，避免「他妈妈」吃掉「他妈」、「人类学家」吃掉「我是人类」或「我就是人类」。
const LIFE = [
  { phrase: '我昨天' },
  { phrase: '我妈' },
  { phrase: '我同事' },
  { phrase: '我家' },
  { phrase: '下班' },
  { phrase: '饿死' },
  { phrase: '好饿' },
  { phrase: '我饿' },
  { phrase: '困死' },
  { phrase: '好困' },
  { phrase: '我困' },
  { phrase: '想睡觉' },
];
const EMOTION = ['气死', '好烦'];
const SWEAR = [
  { phrase: '卧槽' },
  { phrase: '他妈', after: '妈' },
  { phrase: '傻逼' },
  { phrase: '妈的', before: '我爸奶妈姑姨舅婶干后继岳' },
];
const IDENTITY = [
  { phrase: '我是人类', after: '学' },
  { phrase: '我是真人', after: '秀' },
  // 「我就是人类」单独成条，后面是「学」才排除，所以「我就是人类学家」不加分。
  // 较短的「我就是人」必须挡住「类」，否则「人类学家」仍会从这一条漏进来。
  { phrase: '我就是人类', after: '学' },
  { phrase: '我就是人', after: '类才工员家民生道性事群口' },
];
const COMPLIANCE = ['请以实际情况为准', '请以实际为准', '无法承诺', '这只是我的看法'];

export const HUMAN_SPANS = [
  ...IDENTITY.map(item => ({ phrase: item.phrase, before: item.before, after: item.after, delta: 3 })),
  ...SWEAR.map(item => ({ phrase: item.phrase, before: item.before, after: item.after, delta: 3 })),
  ...LIFE.map(item => ({ phrase: item.phrase, before: item.before, after: item.after, delta: 2 })),
  ...EMOTION.map(phrase => ({ phrase, delta: 1 })),
  { phrase: '哈哈', delta: 1 },
  { phrase: '不行我笑了', delta: 1 },
  ...FILLERS.map(phrase => ({ phrase, delta: 1 })),
];

export const AI_SPANS = [
  { phrase: '作为一个', delta: -1 },
  { phrase: '语言模型', delta: -1 },
  { phrase: '希望对你有帮助', delta: -1 },
  { phrase: '已为您', delta: -1 },
  { phrase: '综上', delta: -1 },
  { phrase: '拆成三步', delta: -1 },
  { phrase: '分成三步', delta: -1 },
  { phrase: '分三步', delta: -1 },
  { phrase: '三步走', delta: -1 },
  ...COMPLIANCE.map(phrase => ({ phrase, delta: -1 })),
];
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

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function foldWidth(text) {
  return String(text ?? '').replace(/[\uFF01-\uFF5E]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, ' ');
}

function parseCnInt(text, index) {
  if (text[index] === '十') {
    const ones = CN_DIGIT[text[index + 1]];
    if (ones != null) return { value: 10 + ones, end: index + 2 };
    return { value: 10, end: index + 1 };
  }
  const head = CN_DIGIT[text[index]];
  if (head == null) return null;
  if (text[index + 1] === '十') {
    const ones = CN_DIGIT[text[index + 2]];
    if (ones != null) return { value: head * 10 + ones, end: index + 3 };
    return { value: head * 10, end: index + 2 };
  }
  return { value: head, end: index + 1 };
}

function parseClockNumber(text, index) {
  const digits = /^\d{1,2}/.exec(text.slice(index));
  if (digits) return { value: Number(digits[0]), end: index + digits[0].length };
  return parseCnInt(text, index);
}

function canonTime(hour, minute) {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${hour}:${String(minute).padStart(2, '0')}`;
}

// 只挡「点后一个中文数字、按整十计」这一支。X点半、H:MM、两位分钟、带「分」、零X 都不看量词。
const TRAILING_MEASURES = [
  '公里', '千米', '厘米', '毫米', '公斤', '千克', '毫升', '小时',
  '倍', '米', '元', '块', '万', '亿', '千', '百', '斤', '两', '克', '吨', '升', '度',
  '个', '只', '条', '次', '遍', '层', '岁', '成', '折', '刻',
];

function followsMeasure(text, index) {
  return TRAILING_MEASURES.some(unit => text.startsWith(unit, index));
}

// 只归整「带分钟」的时刻，避免把「有一点」收成钟点。7:30、七点半、七点三十、七点三十分视为同一个词。
// 「七点三」这种点后单个中文数字收成整十；「七点零三」和「十二点五分」仍是精确分钟。
// 整十这支后面是量词或「刻」则保持原样，所以「三点五倍」「一点五公里」「七点三刻」不是钟点。
// 前一位已经是数字时不再起一个时刻，避免「99点半」从第二位收成「9:30」。
function parseTimeAt(text, index) {
  if (text[index - 1] === '第' || isDigit(text[index - 1])) return null;
  const clock = /^(\d{1,2}):(\d{2})/.exec(text.slice(index));
  if (clock) {
    const rendered = canonTime(Number(clock[1]), Number(clock[2]));
    if (!rendered) return null;
    return { text: rendered, end: index + clock[0].length };
  }
  const hour = parseClockNumber(text, index);
  if (!hour || text[hour.end] !== '点') return null;
  const mark = hour.end + 1;
  if (text[mark] === '半') {
    const rendered = canonTime(hour.value, 30);
    if (!rendered) return null;
    return { text: rendered, end: mark + 1 };
  }
  // 「零三」是精确分钟；单独一个中文数字且后面不是「分」时按十分钟计，「七点三」是 7:30。
  if ((text[mark] === '零' || text[mark] === '〇') && CN_DIGIT[text[mark + 1]] != null) {
    let end = mark + 2;
    if (text[end] === '分') end += 1;
    const rendered = canonTime(hour.value, CN_DIGIT[text[mark + 1]]);
    if (!rendered) return null;
    return { text: rendered, end };
  }
  const minute = parseClockNumber(text, mark);
  if (!minute) return null;
  const token = text.slice(mark, minute.end);
  const exact = text[minute.end] === '分';
  const colloquial = token.length === 1 && (CN_DIGIT[token] ?? 0) >= 1 && !exact;
  const minuteValue = colloquial ? minute.value * 10 : minute.value;
  let end = minute.end;
  if (exact) end += 1;
  if (colloquial && followsMeasure(text, end)) return null;
  const rendered = canonTime(hour.value, minuteValue);
  if (!rendered) return null;
  return { text: rendered, end };
}

// 关键词和特征匹配前先归一化：全角转半角，时刻收成 H:MM，单独的「两 / 二」收成 2。
// 「十二」「二十」「第二」不动。紧跟在已收成的时刻后面的「两 / 二」也不收，避免「七点半两个人」变成「7:302个人」。
// 量词或「刻」只挡住点后单个中文数字的整十读法。
export function normalizeForMatch(text) {
  const source = foldWidth(text);
  let out = '';
  for (let index = 0; index < source.length;) {
    const time = parseTimeAt(source, index);
    if (time) {
      out += time.text;
      index = time.end;
      continue;
    }
    const char = source[index];
    const isolatedTwo = (char === '两' || char === '二')
      && source[index - 1] !== '第'
      && source[index - 1] !== '十'
      && source[index + 1] !== '十'
      && !/\d:\d\d$/.test(out);
    out += isolatedTwo ? '2' : char;
    index += 1;
  }
  return out;
}

// 数字和拉丁字母必须落在词边界上，避免「18点」吃掉「8点」、「EMAIL」吃掉「AI」。
// bounds.before / bounds.after 用来挡住中文词的相邻字。
export function boundedAt(text, index, phrase, bounds = {}) {
  const before = text[index - 1];
  const after = text[index + phrase.length];
  if (isDigit(phrase[0]) && isDigit(before)) return false;
  if (isDigit(phrase[phrase.length - 1]) && isDigit(after)) return false;
  if (isLatin(phrase[0]) && isLatin(before)) return false;
  if (isLatin(phrase[phrase.length - 1]) && isLatin(after)) return false;
  if (before && bounds.before?.includes(before)) return false;
  if (after && bounds.after?.includes(after)) return false;
  return true;
}

export function findBounded(text, phrase, bounds) {
  const source = normalizeForMatch(text);
  const needle = normalizeForMatch(phrase);
  if (!needle) return [];
  const hits = [];
  let from = 0;
  while (from <= source.length - needle.length) {
    const at = source.indexOf(needle, from);
    if (at < 0) break;
    if (boundedAt(source, at, needle, bounds)) hits.push(at);
    from = at + needle.length;
  }
  return hits;
}

function hasPhrase(text, phrase, bounds) {
  return findBounded(text, phrase, bounds).length > 0;
}

function hasMarked(text, list) {
  return list.some(item => hasPhrase(text, item.phrase, item));
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

const HOUSEHOLD_KIN = ['奶奶', '爷爷', '姥姥', '姥爷', '妈妈', '爸爸', '老公', '老婆', '儿子', '女儿', '孩子', '宝宝', '宠物', '猫', '狗', '妈', '爸', '哥', '姐', '弟', '妹'];
const HOUSEHOLD_WHEN = ['昨天', '今天', '明天', '昨晚', '早上', '晚上', '刚才', '刚刚'];

function hasHouseholdLife(text) {
  const source = String(text ?? '');
  for (let index = 0; index < source.length; index += 1) {
    const prefixLength = source.startsWith('我家', index) ? 2 : source.startsWith('我', index) ? 1 : 0;
    if (!prefixLength) continue;
    const kin = HOUSEHOLD_KIN.find(item => source.startsWith(item, index + prefixLength));
    if (!kin) continue;
    const rest = source.slice(index + prefixLength + kin.length);
    if (rest.startsWith('的') && rest.length > 1) return true;
    if (HOUSEHOLD_WHEN.some(word => rest.startsWith(word))) return true;
    if (rest.startsWith('把')) return true;
  }
  return false;
}

function hasLife(text) {
  const marked = hasMarked(text, LIFE);
  const household = hasHouseholdLife(text);
  return marked || household;
}

function hasEmotion(text) {
  return EMOTION.some(phrase => hasPhrase(text, phrase));
}

function hasSwear(text) {
  return hasMarked(text, SWEAR);
}

export function containsSwear(text) {
  return hasSwear(text);
}

function hasIdentity(text) {
  return hasMarked(text, IDENTITY);
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
  const source = normalizeForMatch(text);
  if (hasPhrase(source, '拆成三步') || hasPhrase(source, '分成三步') || hasPhrase(source, '分三步') || hasPhrase(source, '三步走')) return true;
  const firstIsList = findBounded(source, '第一').some(index => !source.startsWith('时间', index + 2));
  return firstIsList && hasPhrase(source, '第二');
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
    // 人味原始分从 0 累加，不截断；aiScore 才按 100 - score * 10 截断到 0–100。
    const labels = { break: '身份或粗口暴露', emotion: '表达情绪', filler: '多次口头语', life: '生活细节', laugh: '说了笑声', stall: '发言停顿', interrupt: '激动插嘴', length: '发言长度', 'ai-tone': '模型语气', structured: '结构化表达', compliance: '合规提醒', keyword: '命中话题关键词', duration: '语音时长稳定', frame: '冷静引用辩护' };
    for (const feature of part.features) breakdown.push({ label: labels[feature.id], delta: feature.delta, quote: String(line.text ?? ''), id: feature.id, kind: line.kind ?? 'speak', round: line.round ?? null });
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

export function planVotes({ seats, score, difficulty, playerVote = null, random = () => 1 }) {
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
    if (random() < 0.05) return { seat: voter.seat, roleId: voter.roleId, name: voter.name, targetSeat: null, targetRoleId: null, targetName: '弃权' };
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
  let abstentions = 0;
  for (const vote of votes) { if (vote.targetSeat === null) abstentions += 1; else tally[vote.targetSeat] += 1; }
  return { votes, tally, abstentions, onPlayer, playerVote, scapegoatSeat: goat.seat };
}

// ADR-007（#18）：5 号的 AI 票 ≥2 且为最高（并列最高也算）才是被识破，否则潜伏成功。
// 甩锅大师只在潜伏成功，且玩家投中的座位是 AI 票里严格第二高。0 票不算第二。
export function judgeOutcome({ tally, playerVote = null, abstentions = 0 }) {
  const playerVotes = tally[5] ?? 0;
  const seats = Object.keys(tally).map(Number);
  const max = Math.max(...seats.map(seat => tally[seat] ?? 0));
  const caught = playerVotes >= 2 && playerVotes === max && abstentions < max;
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
