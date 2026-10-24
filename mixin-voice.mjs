// 座位发言接口。调用方只说「这个座位用这份音色配置说这段舞台指令」。
// #14 已测过 listen.detect 换音色。本模块只定义请求和超时兜底，不打开连接。
// 实现方可以忽略 voiceId，但必须回一段台词；抛错、超时或空字符串都改用 fallbackText。

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
