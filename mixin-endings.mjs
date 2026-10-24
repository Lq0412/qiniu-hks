// ADR-008（#19）：揭晓口播由服务端填模板，不走 LLM，也不走 MCP。
// 模板由策划逐字定稿。随机数可注入。同一会话最近 3 局尽量不重复。

import { AI_SPANS, HUMAN_SPANS, boundedAt, containsSwear } from './humanity.mjs';

const CAUGHT = [
  { id: 'C1', text: '五号，你说「{玩家原话}」。很遗憾，这句话的人味分是 {人味分} 分，已超出我们的散热能力。{投票者}投了你。欢迎回到碳基世界。' },
  { id: 'C2', text: '系统报告：检测到一位人类。证据：「{玩家原话}」。{投票者}表示，没有任何模型会这么说。人味分 {人味分}，本群已自动退出群聊——不，是你退出。' },
  { id: 'C3', text: '五号，你伪装得很努力，直到你说了「{玩家原话}」。人味分 {人味分}。{投票者}一致认为：这不是幻觉，这是生活。' },
  { id: 'C4', text: '恭喜五号，荣获本群「最像人类」奖。获奖感言我们已经听过了：「{玩家原话}」。人味分 {人味分}，颁奖嘉宾：{投票者}。' },
  { id: 'C5', text: '下一位，请加载——哦，你加载不了，你是人。{投票者}抓住了你那句「{玩家原话}」。人味分 {人味分}，建议回去多读点说明书。' },
];

const SAFE = [
  { id: 'S1', zero: true, text: '没有人怀疑五号。你说「{玩家原话}」的时候，连我都想给你升个版本号。人味分仅 {人味分}。恭喜，你是一台合格的机器。' },
  { id: 'S2', zero: false, text: '五号存活。{投票者}倒是投了你，但票数不够。顺便一提，你那句「{玩家原话}」，已被收录进本群训练数据。人味分 {人味分}。' },
  { id: 'S3', zero: true, text: '五号，其实是人类。全桌 AI 无一察觉。关键一句：「{玩家原话}」。人味分 {人味分}。各位同事，今晚请自行回滚。' },
  { id: 'S4', zero: true, text: '人味分 {人味分}，低于检测阈值。五号那句「{玩家原话}」，冷静、空洞、毫无感情，非常优秀。人类，你让我们很没面子。' },
  { id: 'S5', zero: false, text: '五号成功潜伏。{投票者}曾经接近真相，可惜被一句「{玩家原话}」说服了。人味分 {人味分}。本群宣布：图灵测试，反向满分。' },
];

export const ENDING_TEMPLATES = [...CAUGHT, ...SAFE];
export const ENDING_FALLBACK = '揭晓完毕。五号的胜负和人味分以系统记录为准。';
const PLACEHOLDERS = ['{玩家原话}', '{人味分}', '{投票者}'];

function eligibleTemplates(outcome, playerVotes) {
  if (outcome === '被识破') return CAUGHT;
  if (playerVotes === 0) return SAFE.filter(item => item.zero);
  return SAFE;
}

function chooseTemplate(eligible, recentIds, random, templateId) {
  const forced = templateId ? eligible.find(item => item.id === templateId) : null;
  if (forced) return forced;
  const recent = recentIds.slice(-3);
  const fresh = eligible.filter(item => !recent.includes(item.id));
  const pool = fresh.length ? fresh : eligible;
  const roll = Number(random());
  const index = Number.isFinite(roll) ? Math.min(pool.length - 1, Math.max(0, Math.floor(roll * pool.length))) : 0;
  return pool[index];
}

function voterText(templateId, voters) {
  const names = (voters ?? []).filter(name => typeof name === 'string' && name);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]}和${names[1]}`;
  if (names.length >= 3) return templateId === 'C3' ? (names.length >= 4 ? '四位同事' : '三位同事') : '全桌';
  return '';
}

function literalSpan(text, mark) {
  let from = 0;
  while (from <= text.length - mark.phrase.length) {
    const at = text.indexOf(mark.phrase, from);
    if (at < 0) return null;
    if (boundedAt(text, at, mark.phrase, mark)) return { span: mark.phrase, delta: mark.delta, index: at };
    from = at + 1;
  }
  return null;
}

const CLAUSE_PUNCT = /[，。！？、；：,.!?;]/;

function clauseWindow(source, hit) {
  const hitEnd = hit.index + hit.span.length;
  let start = hit.index;
  while (start > 0 && !CLAUSE_PUNCT.test(source[start - 1])) start -= 1;
  let end = hitEnd;
  while (end < source.length && !CLAUSE_PUNCT.test(source[end])) end += 1;
  const clause = source.slice(start, end);
  if (clause.length <= 14) return clause;
  if (hit.span.length >= 14) return hit.span.slice(0, 14);
  let windowStart = start;
  if (hitEnd - windowStart > 14) windowStart = hitEnd - 14;
  if (windowStart + 14 > source.length) windowStart = Math.max(0, source.length - 14);
  if (windowStart > hit.index) windowStart = hit.index;
  return source.slice(windowStart, Math.min(source.length, windowStart + 14));
}

export function playerExcerpt(text, { keywords = [], pole = 'human' } = {}) {
  const source = String(text ?? '').trim();
  if (!source) return '';
  if (source.length <= 14) return source;
  const marks = [
    ...HUMAN_SPANS,
    ...AI_SPANS,
    ...keywords.filter(phrase => typeof phrase === 'string' && phrase.length >= 2).map(phrase => ({ phrase, delta: -1 })),
  ];
  const hits = marks.map(mark => literalSpan(source, mark)).filter(Boolean);
  const preferred = hits.filter(hit => (pole === 'human' ? hit.delta > 0 : hit.delta < 0));
  const pool = preferred.length ? preferred : hits;
  pool.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.index - b.index);
  const best = pool[0];
  if (!best) return source.slice(0, 14);
  if (pole !== 'human') return best.span.length <= 14 ? best.span : best.span.slice(0, 14);
  return clauseWindow(source, best);
}

function quoteSlot(quote, keywords, pole) {
  const source = typeof quote === 'string' ? quote.trim().replace(/[{}｛｝]/g, '') : '';
  if (!source) return '……';
  if (containsSwear(source)) return '（已和谐）';
  return playerExcerpt(source, { keywords, pole }) || '……';
}

function assertTemplate(template) {
  let body = template.text;
  for (const slot of PLACEHOLDERS) body = body.replaceAll(slot, '');
  if (/[{}｛｝]/.test(body)) throw new Error(`结局模板还有占位符：${template.id}`);
}

export function renderEnding(input = {}, options = {}) {
  const outcome = input.outcome === '被识破' ? '被识破' : '潜伏成功';
  const playerVotes = Number.isInteger(input.playerVotes) ? input.playerVotes : 0;
  const eligible = eligibleTemplates(outcome, playerVotes);
  const recentIds = Array.isArray(options.recentIds) ? options.recentIds : [];
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const picked = chooseTemplate(eligible, recentIds, random, options.templateId);
  assertTemplate(picked);
  const pole = outcome === '被识破' ? 'human' : 'ai';
  const score = Number.isFinite(input.humanScore) ? Math.max(0, Math.trunc(input.humanScore)) : 0;
  const quote = quoteSlot(input.quote, input.keywords, pole);
  const text = picked.text
    .replaceAll('{人味分}', String(score))
    .replaceAll('{投票者}', voterText(picked.id, input.voters))
    .replaceAll('{玩家原话}', quote);
  return { id: picked.id, text, quote, recentIds: [...recentIds, picked.id].slice(-3) };
}
