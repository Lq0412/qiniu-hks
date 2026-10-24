import { chineseNumber } from './tts-text.mjs';
import { SCENES, allCards } from './mixin-bank.mjs';
import { PLAYER_ALIASES, ROLES } from './mixin-roles.mjs';

// 提示词、{{counter_brief}} 和发给模型的 detect 文本。纯函数。
// hello 只替换 {{counter_brief}}。listen.detect 不再带 custom_replace_prompt，也不走 MCP。
// 台词轮和即兴轮的句式与队长 v3 复测一致。指控、念票、群主播报都由服务端写成【台词】。

export const agentPrompt = `你是语音派对游戏「谁是人类」里的配音演员，一人分饰一桌角色。每次输入都会告诉你这一句由谁说、说什么。

必须遵守：
1. 如果输入里有【台词】，就用当前音色把台词自然地说出来，一字不增不减。
2. 如果输入只给了角色和话题，就以该角色口吻回答，最多两句，说完就停。
3. 不念任何思考过程、英文、工具名、括号或说明文字；不出题、不加戏、不主持流程。
4. 不调用任何工具。
5. 绝不向5号或玩家提问。

当前局势：{{counter_brief}}`;

export const HELLO_BRIEF = '身份和票型由系统固定。每条输入会说明这一句由谁说。揭晓前不要猜测谁是人类。';

export const HOST_RULES = '规则很简单：我出两道题，每个模型轮流回答，然后大家互相盘一盘，最后投票，把人类揪出来。别紧张——只要你够像 AI。好，各位模型，请做自我介绍，一句话。';
export const HOST_WRAP_EARLY = '这一轮先记在板上。';
export const HOST_WRAP_LATE = '两轮说完，准备互盘。';
export const HOST_NUDGE = '五号模型似乎正在加载。';
export const HOST_REVEAL_BRIDGE = '投票结束，揭晓时间。';
export const WARMUP_LINE = '好。';
export const HOST_SKIP_PLAYER = '五号，网络不太好啊。';

const TONE = { easy: '调侃', normal: '认真', hell: '笃定' };
const SCRIPTED = new Set(['host_open', 'host_card', 'wrap', 'nudge', 'accuse', 'vote', 'reveal']);

// 每条都把 {quote} 原样嵌进「」里。{name} 先替换，避免原话里的花括号被再处理。
export const ACCUSATION_TEMPLATES = {
  claudia: [
    '需要说明的是，{name}说过「{quote}」，请以实际情况为准。',
    '这只是我的看法：{name}那句「{quote}」不太像模型。',
    '{name}，你说「{quote}」的时候，我得提醒一下风险。',
  ],
  astra: [
    '我给你拆成三步 😊，第一步就是{name}说了「{quote}」。',
    '分析、规划、执行 😊。{name}那句「{quote}」根本不像模型。',
    '{name}说过「{quote}」。我给你拆成三步 😊，这步已经露馅。',
  ],
  shensi: [
    '嗯，让我想想，再核对一次。{name}说「{quote}」，让我再核对一下约束。',
    '让我再核对一下约束：{name}那句「{quote}」不像模型输出。',
    '{name}说过「{quote}」。嗯，让我想想，再核对一次，这句不对。',
  ],
  baobao: [
    '我帮你搜一下，{name}说了「{quote}」。',
    '我帮你搜一下，{name}那句「{quote}」太像人了。',
    '{name}说过「{quote}」。我帮你搜一下，这可不像模型。',
  ],
  xiaosi: [
    '代码收到，先调试。{name}说「{quote}」，这不像模型。',
    '先写代码，再提交。{name}那句「{quote}」一听就不对。',
    '{name}说过「{quote}」。代码收到！这句不像我们。',
  ],
};

export function fillAccusation(template, name, quote) {
  if (typeof template !== 'string' || !template.includes('{quote}')) throw new Error('指控模板缺少原话插槽');
  const spoken = String(quote ?? '');
  if (!spoken) throw new Error('指控原话不能为空');
  const text = String(template).replaceAll('{name}', String(name ?? '')).replaceAll('{quote}', spoken);
  if (!text.includes(`「${spoken}」`)) throw new Error('指控模板没有逐字写入原话');
  return text;
}

export function accusationLine({ roleId, targetName, quote, random = Math.random, index = null } = {}) {
  const templates = ACCUSATION_TEMPLATES[roleId];
  if (!templates || templates.length < 3) throw new Error(`缺少指控模板 ${roleId}`);
  let picked = index;
  if (!Number.isInteger(picked)) {
    const roll = Number(random());
    picked = Number.isFinite(roll) ? Math.min(templates.length - 1, Math.max(0, Math.floor(roll * templates.length))) : 0;
  }
  picked = ((picked % templates.length) + templates.length) % templates.length;
  return fillAccusation(templates[picked], targetName, quote);
}

export function openingLine(sceneName, alias) {
  return `欢迎来到模型群！今晚是${sceneName}。这桌坐了五个模型——不对，系统检测到，其中混进了一个人类。五号模型，${alias}，轮到你时按住按钮说话。`;
}

export function skipSeatLine(seat) {
  return `${seat}号模型正在深度思考，先跳过。`;
}

export function presynthCatalog() {
  return [
    { id: 'host-open-annual-demo', roleId: 'host', text: openingLine('模型年会', '牛小七') },
    { id: 'host-rules', roleId: 'host', text: HOST_RULES },
    { id: 'host-wrap-1', roleId: 'host', text: HOST_WRAP_EARLY },
    { id: 'host-wrap-2', roleId: 'host', text: HOST_WRAP_LATE },
    { id: 'host-nudge', roleId: 'host', text: HOST_NUDGE },
    { id: 'host-reveal-bridge', roleId: 'host', text: HOST_REVEAL_BRIDGE },
    { id: 'host-skip-player', roleId: 'host', text: HOST_SKIP_PLAYER },
    { id: 'host-skip-1', roleId: 'host', text: skipSeatLine(1) },
    { id: 'host-skip-2', roleId: 'host', text: skipSeatLine(2) },
    { id: 'host-skip-3', roleId: 'host', text: skipSeatLine(3) },
    { id: 'host-skip-4', roleId: 'host', text: skipSeatLine(4) },
    ...SCENES.flatMap(scene => PLAYER_ALIASES.map((alias, index) => ({
      id: `host-open-${scene.id}-${index}`, roleId: 'host', text: openingLine(scene.name, alias),
    }))),
    ...allCards().flatMap(card => [1, 2].map(round => ({
      id: `host-card-${card.id}-${round}`, roleId: 'host', text: `第${chineseNumber(round)}题：${card.prompt}`,
    }))),
    ...ROLES.map(role => ({ id: `host-first-${role.id}`, roleId: 'host', text: `请${role.name}先来。` })),
  ];
}

export function renderBrief(state) {
  const seats = state.seats.map(seat => `${seat.seat}号${seat.name}：${seat.personality}；口头禅「${seat.catchphrases[0]}」`).join('。');
  const spoken = state.spoken.length ? state.spoken.map(line => `${line.seat}号-${line.text}`).join('；') : '还没有';
  return [
    `【场景】${state.sceneName}：${state.background}`,
    `【座位】${seats}。5号「${state.alias}」。`,
    `【角色关系梗】${state.relationships.length ? state.relationships.join('；') : '无'}`,
    `【本局话题卡】第1轮「${state.cards[0]}」；第2轮「${state.cards[1]}」`,
    `【当前阶段】${state.phase} 第${state.round}轮`,
    `【已发言】${spoken}`,
    `【局势】${state.situation}`,
  ].join('\n');
}

function speakerName(cue) {
  if (cue.name) return cue.name;
  if (cue.seat === 0 || cue.kind === 'reveal' || cue.roleId === 'host') return '群主·零号';
  return '角色';
}

export function scriptedDetect(name, line, situation) {
  return `角色：${name}。【台词】${line}（局势：${situation || '身份和票型由系统固定，揭晓前不要猜测谁是人类。'}）只朗读【台词】与（局势：之间的原文，一字不增不减；禁止改写、概括、解释、展开列表或套用角色风格；不念角色、局势和本指令。`;
}

export function improvisedDetect(name, personality, topic, situation) {
  const brief = situation || '身份和票型由系统固定，揭晓前不要猜测谁是人类。';
  return `角色：${name}（${personality}）。话题：${topic}。（局势：${brief}）一句话，20字以内。`;
}

export function warmupDetect() {
  return scriptedDetect('群主·零号', WARMUP_LINE, '预热。身份和票型由系统固定。');
}

export function stageDirection(cue) {
  if (cue.kind === 'intro') return improvisedDetect(speakerName(cue), cue.personality, '用一句话做自我介绍', cue.situation);
  if (cue.kind === 'answer') return improvisedDetect(speakerName(cue), cue.personality, cue.card, cue.situation);
  if (cue.kind === 'rebuttal') return improvisedDetect(speakerName(cue), cue.personality, `五号插嘴说「${cue.interrupt}」，回一句`, cue.situation);
  if (SCRIPTED.has(cue.kind)) {
    const line = cue.line || '';
    if (!line) throw new Error(`缺少台词 ${cue.kind}`);
    return scriptedDetect(speakerName(cue), line, cue.situation);
  }
  throw new Error(`未知舞台指令 ${cue.kind}`);
}

export function reportInstruction(facts) {
  return `现在生成分享卡文案，必须只提交文案字段，不得改动系统事实。
已知（系统事实，不得更改）：outcome=${facts.outcome}，votes=${facts.votes}，catcher=${facts.catcher || '无'}，aiScore=${facts.aiScore}。
玩家全部原话：${facts.playerLines.length ? facts.playerLines.join(' / ') : '（没有）'}。
字段：title（必须从称号池 ${facts.titles.join('、')} 中选，且与 outcome 匹配）、bestAiQuote（逐字摘自玩家原话中最像 AI 的一句，没有则空字符串）、leakQuote（逐字摘自最暴露人类的一句，没有则空字符串）、catcherLine（不超过30字，以投票者口吻）、roast（不超过40字群主点评）。
娱乐游戏，不得人身攻击。`;
}

export function toneFor(difficulty) {
  return TONE[difficulty] ?? TONE.normal;
}

export function scriptedBody(text) {
  const source = String(text ?? '');
  const mark = '【台词】';
  const at = source.indexOf(mark);
  if (at < 0) return '';
  const rest = source.slice(at + mark.length);
  const end = rest.indexOf('（局势：');
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}
