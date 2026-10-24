// 谁是人类的虚构角色。名字只借风格，不点真实产品。
// 音色 ID 在 mixin-voice.mjs，按角色 id 索引。MIXIN_VOICE_IDS 用「角色id=音色id」逗号分隔覆盖。
// 群主音色首音约 3.0–3.5 秒，开场、规则和串场要预合成。灵矽对同一句话、同一音色有 TTS 缓存，第二次音频与第一次完全一致。这两件事先记在这里，实现留给语音调度。

import { VOICE_CATALOG, voiceIdOverrides } from './mixin-voice.mjs';

function roleVoice(id, extra) {
  const catalog = VOICE_CATALOG[id];
  return {
    voiceId: catalog.voiceId,
    fallbackVoiceId: catalog.fallbackVoiceId,
    label: catalog.label,
    verified: false,
    ...extra,
  };
}

export const HOST = {
  id: 'host',
  seat: 0,
  name: '群主·零号',
  style: '系统',
  personality: '冷幽默综艺主持，不站队',
  catchphrases: ['下一位，请加载'],
  intro: '',
  voice: roleVoice('host', { description: '播音腔，固定不换', rate: 'medium', pitch: 'medium', emotion: 'neutral' }),
};

export const ROLES = [
  {
    id: 'claudia',
    name: '柯老师',
    style: '免责声明型',
    personality: '温柔、谨慎、什么都要提醒风险',
    catchphrases: ['需要说明的是', '这只是我的看法，请以实际情况为准'],
    intro: '大家好，我是柯老师。需要说明的是，我很安全。',
    voice: roleVoice('claudia', { description: '知性温柔女声，语速稍慢', rate: 'slow', pitch: 'medium', emotion: 'calm' }),
  },
  {
    id: 'astra',
    name: '阿斯哥',
    style: '宏大调度型',
    personality: '自信爆棚、凡事拆三步、爱画大饼',
    catchphrases: ['我给你拆成三步', '这个格局要打开'],
    intro: '阿斯哥，格局打开，今晚我负责带飞。',
    voice: roleVoice('astra', { description: '沉稳有质感的男声，语速稍快', rate: 'fast', pitch: 'medium', emotion: 'confident' }),
  },
  {
    id: 'shensi',
    name: '深思哥',
    style: '深度思考型',
    personality: '慢半拍、先盘约束、爱报思考时长',
    catchphrases: ['嗯……已深度思考 37 秒', '先把约束盘清楚'],
    intro: '嗯……已深度思考 12 秒，我是深思哥。',
    voice: roleVoice('shensi', { description: '低沉慢速男声', rate: 'slow', pitch: 'low', emotion: 'thoughtful' }),
  },
  {
    id: 'baobao',
    name: '包包',
    style: '口语务实型',
    personality: '接地气、像群里靠谱朋友、爱叫宝子',
    catchphrases: ['宝子，这事儿简单', '家人们谁懂啊'],
    intro: '宝子们好，包包在线，人类别想跑。',
    voice: roleVoice('baobao', { description: '调皮或活泼的女声', rate: 'fast', pitch: 'high', emotion: 'playful' }),
  },
  {
    id: 'xiaosi',
    name: '小四',
    style: '4B 小模型',
    personality: '话短、自信地胡说、常被全桌嫌弃',
    catchphrases: ['收到！其实没懂', '参数少，但我快'],
    intro: '收到！其实没懂。参数少，但我快。',
    voice: roleVoice('xiaosi', { description: '童声，语速偏快', rate: 'fast', pitch: 'high', emotion: 'chipper' }),
  },
];

export const PLAYER_ALIASES = ['碳基-7B', '打工人-Turbo', '摸鱼-mini', '熬夜-Pro'];

// 投票时不能投自己，替罪羊把票让给关系梗对手，制造内讧。
export const RIVAL = {
  baobao: 'claudia',
  claudia: 'astra',
  astra: 'shensi',
  shensi: 'baobao',
  xiaosi: 'astra',
};

const PLAYER_VOICE = { voiceId: null, fallbackVoiceId: null, label: '玩家', description: '玩家自己的声音', rate: 'medium', pitch: 'medium', emotion: 'neutral', verified: false };

const SEATABLE_IDS = new Set(ROLES.map(role => role.id));

export function voiceOf(role) {
  const base = role.voice.voiceId;
  const voice = {
    voiceId: typeof base === 'string' && base.trim() ? base.trim() : null,
    fallbackVoiceId: typeof role.voice.fallbackVoiceId === 'string' && role.voice.fallbackVoiceId.trim() ? role.voice.fallbackVoiceId.trim() : null,
    label: role.voice.label,
    description: role.voice.description,
    rate: role.voice.rate,
    pitch: role.voice.pitch,
    emotion: role.voice.emotion,
    verified: false,
  };
  const override = voiceIdOverrides()[role.id];
  if (typeof override === 'string') voice.voiceId = override;
  return voice;
}

export function roleById(id) {
  if (id === HOST.id) return HOST;
  if (id === 'player') return { id: 'player', name: '五号', style: '玩家', personality: '装成模型', catchphrases: [], intro: '', voice: { ...PLAYER_VOICE } };
  const role = ROLES.find(item => item.id === id);
  if (!role) throw new Error(`未知角色 ${id}`);
  return role;
}

export function seatFrom(roleId, seat) {
  if (!SEATABLE_IDS.has(roleId)) throw new Error(`角色不能上桌 ${roleId}`);
  const role = roleById(roleId);
  return { seat, roleId: role.id, name: role.name, personality: role.personality, catchphrases: [...role.catchphrases], voice: voiceOf(role) };
}

export function defaultLineup() {
  return ['claudia', 'astra', 'shensi', 'baobao'].map((id, index) => seatFrom(id, index + 1));
}

export function createRng(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// 每局从 5 个角色里抽 4 个。rng() 返回 [0, 1)。
export function pickLineup(rng) {
  const bag = ROLES.map(role => role.id);
  bag.splice(Math.floor(rng() * bag.length), 1);
  for (let index = bag.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [bag[index], bag[swap]] = [bag[swap], bag[index]];
  }
  return bag.map((id, index) => seatFrom(id, index + 1));
}

export function pickAlias(rng) {
  return PLAYER_ALIASES[Math.floor(rng() * PLAYER_ALIASES.length)];
}

export function relationshipLines(roleIds) {
  const notes = [];
  if (roleIds.includes('baobao') && roleIds.includes('claudia')) notes.push('包包嫌柯老师啰嗦');
  if (roleIds.includes('claudia') && roleIds.includes('astra')) notes.push('柯老师觉得阿斯哥爱幻觉');
  if (roleIds.includes('shensi')) notes.push('深思哥永远最后一个想好');
  if (roleIds.includes('xiaosi')) notes.push('所有人都怀疑小四是人，因为他太蠢');
  return notes;
}
