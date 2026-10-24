// 座位发言接口。调用方只说「这个座位用这份音色配置说这段舞台指令」。
// #14 已测过 listen.detect 换音色。本模块只定义请求、音色表和超时兜底，不打开连接。
// 实现方可以忽略 voiceId，但必须回一段台词；抛错、超时或空字符串都改用 fallbackText。
//
// 音色 ID 不是密钥。voiceId 一律是字符串：包包的 ID 是纯数字，转成 Number 会丢精度。
// 备选 ID 先记在表里，本步不在失败时自动换音色。群主固定用典型播音女，一局里不换。
// 运行时覆盖：LINX_VOICE_IDS=角色id=音色id,角色id=音色id
// 等号两侧可有空格。缺等号或空 id 的项忽略。未写到的角色继续用下表。

export const VOICE_CATALOG = {
  host: {
    voiceId: '4bdb867c07d54e119950b5bda44673a7', // 典型播音女
    fallbackVoiceId: null,
    label: '典型播音女',
  },
  claudia: {
    voiceId: '8fca6d5172fc4c309c2d16352ca8a9b3', // 温暖治愈女
    fallbackVoiceId: 'b30165086267413f96643a803aed599f', // 积极知性女
    label: '温暖治愈女',
  },
  astra: {
    voiceId: '2e7965636b0d4472ae51e75f419dff41', // 沉稳质感男
    fallbackVoiceId: null,
    label: '沉稳质感男',
  },
  shensi: {
    voiceId: '9d91653b2adf4aa9ad97e1c8f63fbda3', // 磁性低音男
    fallbackVoiceId: 'b38d4a6eb8f64c209fa6febfd7f91663', // 深夜播客
    label: '磁性低音男',
  },
  baobao: {
    voiceId: '1965294143278125057', // 调皮公主
    fallbackVoiceId: '2077603629237219330', // 活泼女孩 2.0
    label: '调皮公主',
  },
  xiaosi: {
    voiceId: '91ccc0758b22473693dfa86c8e7e3fa3', // 稚气呆板女
    fallbackVoiceId: null,
    label: '稚气呆板女',
  },
};

export function voiceIdOverrides(raw = process.env.LINX_VOICE_IDS) {
  const map = {};
  if (typeof raw !== 'string' || !raw.trim()) return map;
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const roleId = trimmed.slice(0, eq).trim();
    const voiceId = trimmed.slice(eq + 1).trim();
    if (!roleId || !voiceId || /[\r\n]/.test(voiceId)) continue;
    map[roleId] = voiceId;
  }
  return map;
}

export function speakRequest(input) {
  if (!input || typeof input.cueId !== 'string' || !input.cueId) throw new Error('发言请求缺少 cueId。');
  if (!Number.isInteger(input.generation)) throw new Error('发言请求缺少代数号。');
  if (!Number.isInteger(input.seat)) throw new Error('发言请求缺少座位。');
  if (!input.voice || typeof input.voice !== 'object') throw new Error('发言请求缺少音色配置。');
  if (typeof input.instruction !== 'string' || typeof input.fallbackText !== 'string') throw new Error('发言请求缺少舞台指令或兜底台词。');
  return {
    cueId: input.cueId,
    generation: input.generation,
    phase: input.phase,
    seat: input.seat,
    roleId: input.roleId,
    voice: input.voice,
    instruction: input.instruction,
    fallbackText: input.fallbackText,
  };
}

export const SPEECH_TIMEOUT_MS = 8000;

export async function dispatchSeatSpeech(implement, input, timeoutMs = SPEECH_TIMEOUT_MS) {
  const request = speakRequest(input);
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => implement(request)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('发言超时')), timeoutMs);
      }),
    ]);
    const text = typeof result?.text === 'string' ? result.text.trim() : '';
    return {
      ok: true,
      cueId: request.cueId,
      generation: request.generation,
      seat: request.seat,
      text: text || request.fallbackText,
      voiceUsed: result?.voiceUsed ?? null,
      mode: text ? (result?.mode ?? 'text') : 'fallback',
      voice: request.voice,
    };
  } catch (error) {
    return {
      ok: false,
      cueId: request.cueId,
      generation: request.generation,
      seat: request.seat,
      text: request.fallbackText,
      voiceUsed: null,
      mode: 'fallback',
      voice: request.voice,
      error: error instanceof Error ? error.message : '发言失败',
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createScriptedSpeaker() {
  return request => ({ text: request.fallbackText, mode: 'text', voiceUsed: null });
}
