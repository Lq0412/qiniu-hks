// 座位发言接口。调用方只说「这个座位用这份音色配置说这段舞台指令」。
// 会话内能不能真的换音色、能不能带语速和情感，都还没实测。实现方可以忽略 voiceId，
// 但必须回一段台词，失败时用 fallbackText，不能让这一席卡住。

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

export async function dispatchSeatSpeech(implement, input) {
  const request = speakRequest(input);
  try {
    const result = await implement(request);
    const text = typeof result?.text === 'string' ? result.text.trim() : '';
    return {
      ok: true,
      cueId: request.cueId,
      generation: request.generation,
      seat: request.seat,
      text: text || request.fallbackText,
      voiceUsed: result?.voiceUsed ?? null,
      mode: result?.mode ?? (text ? 'text' : 'fallback'),
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
  }
}

export function createScriptedSpeaker() {
  return request => ({ text: request.fallbackText, mode: 'text', voiceUsed: null });
}
