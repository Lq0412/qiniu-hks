// 灵矽语音探针的纯计算。这里不连网、不读凭据。
// 延迟定义：开口 = 发出 listen.detect 到第一帧 TTS 二进制；说完 = 到 tts.stop。
// p90 用 nearest-rank（rank = ceil(p/100*n)）。

export const TURN_TARGET_MS = 1500;
export const OPENING_TEXT = '探针开场白甲乙丙';
export const LONG_STORY_PROMPT = '请连续讲一个不少于八十个字的故事，中途不要停，不要提问。';
export const NEW_INPUT_PROMPT = '停。不要继续故事。只说一个字：停。';
export const SITUATION_QUESTION = '现在的局势口令是什么？只回答口令。';
export const DEFAULT_BRIEF = '语音探针。请直接回答，不要调用工具，不要描述操作过程。';

export const SITUATIONS = {
  hello: '松果三号',
  listenUpdate: '潮汐四号',
  mcpFirst: '灯塔五号',
  mcpSecond: '礁石七号',
  reconnect: '港湾六号',
};

export const CAST = [
  { role: 'ai-1', name: '阿柿', marker: '阿柿赞成', speed: 1, pitch: 1, emotion: 'calm' },
  { role: 'ai-2', name: '阿梨', marker: '阿梨反对', speed: 1.1, pitch: 0.9, emotion: 'happy' },
  { role: 'ai-3', name: '阿枣', marker: '阿枣弃权', speed: 0.9, pitch: 1.1, emotion: 'sad' },
  { role: 'ai-4', name: '阿桃', marker: '阿桃跟票', speed: 1.2, pitch: 1, emotion: 'angry' },
  { role: 'host', name: '主持', marker: '主持收束', speed: 1, pitch: 1, emotion: 'neutral' },
];

export const LATENCY_OPTIMIZATIONS = [
  '达标看开口：发出 listen.detect 到第一帧 TTS 的 p90 是否 ≤1500ms。说完时间含语音本身，不拿来当开口达标。',
  '默认文字注入，跳过真人 ASR。麦克风路径更慢，转写形态见 asrShape。',
  '同一条连接连续回合，不要每回合重连。重连耗时见 situation.reconnect 和 connectTiming。',
  '测开口时 hello 声明 mcp:false。必须用工具改局势时，工具只回短 instruction，并要求模型静默调用。',
  '换音色把 id、语速、音调、情感放在同一次 listen.detect 的 agent_params.voice，不为换音色重连。',
  '探针记的是收到首帧，不是扬声器出声。play_buffer_duration 越大，听感越晚。',
  '限制回复字数，缩短 LLM 和 TTS 生成时间。',
  '选计时系数低的模型和音色，客户端尽量靠近 xrobo-io。',
  '若改走上行音频，优先 PCM 16kHz/20ms，省掉 Opus 编码。',
];

export const VOICE_UNCERTAINTIES = [
  '官方文档：会话内换音色是上行 listen.agent_params.voice={id,speed,pitch,emotion,volume}，只改 TTS，不换智能体，默认保留上下文。Header 换音色已不支持。X-Agent-ID 只在握手时选智能体。',
  '编排端发出的 listen.detect 能否同时带音色参数，文档示例允许，但是否真的改了这次 TTS 要听真机音频，文本探针看不出来。',
  '五个音色轮流时上下文稳不稳、模型会不会替别人说话，只能看真机 TTS。离线测试只锁定判定规则。',
  'custom_replace_prompt 文档只出现在 hello。中途改局势的正式办法是 MCP 工具返回 instruction，或断开后用新 hello 重连。listen 上再带该字段只是观察项。',
  '同一设备号能否重叠第二条 WSS、OTA 耗时、开场白会不会回成 STT、真实 ASR 的标点和数字写法，都要真机。未提供预录音频时 asrShape 跳过。',
  '1.5 秒目标对照开口首帧 p90，不是把整段 TTS 播完，也不含麦克风 ASR。',
];

export const PLAN_B_OPTIONS = {
  sse: {
    name: '第三方 chat SSE 按句指定音色',
    documented: true,
    source: 'https://linx.qiniu.com/docs/xrobot/guide/third-app',
    how: '业务服务充当大模型。SSE 在 event=message 且 type=chat 时给出 details.answer、tts_provider、voice_type、speed_ratio、pitch_ratio，平台只做 TTS。',
    context: '上下文放在编排器，不依赖灵矽会话，也避免角色私密信息串线。',
    limit: '需要公网 HTTPS，并把智能体的模型指到该端点。',
  },
  multiConnection: {
    name: '一角色一条 WSS',
    documented: true,
    source: 'https://linx.qiniu.com/docs/xrobot/platform/agent-voice-switch',
    how: '握手用 X-Agent-ID 选智能体。每条连接固定 ttsVoiceId，或只在自己的会话里发 listen.agent_params.voice。',
    context: '连接之间不共享上下文。主持人要记住别人的话，得由编排器写回去。',
    sameDevice: '同一设备号能否重叠第二条连接由 concurrentSocket 探针测量。不行就每个角色单独伪 MAC，各自 OTA。',
  },
  prerender: {
    name: '预先合成每个角色的句子再播放',
    documented: false,
    source: 'ADR-005 备选',
    how: '编排器提前把各角色台词合成音频，局内按轮次播放，不再等待实时换音色后的 TTS。',
    when: '实时换音色超过约 1.5 秒，或不稳又来不及改接入方式时。',
  },
};

const SECRET_KEYS = new Set([
  'token', 'access_token', 'accesstoken', 'authorization', 'deviceid', 'device_id',
  'clientid', 'client_id', 'mac', 'mac_address', 'password', 'secret', 'websocket', 'apikey', 'api_key',
]);
const MAC = /\b[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}\b/g;
const BEARER = /Bearer\s+\S+/gi;
const JWT = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

export function emptyStats() {
  return { count: 0, min: null, median: null, p90: null, max: null };
}

export function percentileNearestRank(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function summarizeLatencies(values) {
  const nums = (values ?? []).filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!nums.length) return emptyStats();
  const mid = Math.floor(nums.length / 2);
  const median = nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  return { count: nums.length, min: nums[0], median, p90: percentileNearestRank(nums, 90), max: nums.at(-1) };
}

export function judgeTarget(stats, targetMs = TURN_TARGET_MS) {
  if (!stats?.count || stats.p90 == null) return { meetsTarget: null, basis: 'p90', targetMs, p90: stats?.p90 ?? null, median: stats?.median ?? null };
  return { meetsTarget: stats.p90 <= targetMs, basis: 'p90', targetMs, p90: stats.p90, median: stats.median };
}

export function redactSecrets(value, extra = []) {
  const extras = extra.filter(item => typeof item === 'string' && item.length >= 6);
  const scrub = text => {
    let out = String(text).replace(BEARER, 'Bearer [redacted]').replace(JWT, '[redacted]').replace(MAC, '[redacted]');
    for (const secret of extras) if (out.includes(secret)) out = out.split(secret).join('[redacted]');
    return out;
  };
  const walk = (item, seen) => {
    if (typeof item === 'string') return scrub(item);
    if (item == null || typeof item !== 'object') return item;
    if (seen.has(item)) return null;
    seen.add(item);
    if (Array.isArray(item)) return item.map(entry => walk(entry, seen));
    const out = {};
    for (const [key, entry] of Object.entries(item)) {
      out[key] = SECRET_KEYS.has(key.toLowerCase()) ? '[redacted]' : walk(entry, seen);
    }
    return out;
  };
  return walk(value, new WeakSet());
}

export function safeErrorMessage(error, extra = []) {
  if (error?.code === 'TIMEOUT') return '超时';
  return redactSecrets(error?.message || '未知错误', extra);
}

export function assertVoiceId(id) {
  const trimmed = String(id ?? '').trim();
  if (!trimmed || trimmed.length > 128 || /[\r\n]/.test(trimmed)) throw new Error('音色 ID 无效');
  return trimmed;
}

export function buildVoiceParams({ id, speed, pitch, emotion, volume } = {}) {
  const voice = { id: assertVoiceId(id) };
  if (speed != null) {
    if (typeof speed !== 'number' || speed < 0.5 || speed > 2) throw new Error('语速超出 0.5–2.0');
    voice.speed = speed;
  }
  if (pitch != null) {
    if (typeof pitch !== 'number' || pitch < 0.5 || pitch > 2) throw new Error('音调超出 0.5–2.0');
    voice.pitch = pitch;
  }
  if (volume != null) {
    if (typeof volume !== 'number' || volume < 1 || volume > 100) throw new Error('音量超出 1–100');
    voice.volume = volume;
  }
  if (emotion != null) {
    const text = String(emotion).trim();
    if (!text || text.length > 32) throw new Error('情感长度需为 1–32');
    voice.emotion = text;
  }
  return voice;
}

export function buildHello({ mcp = false, promptKey = 'counter_brief', promptText = DEFAULT_BRIEF } = {}) {
  if (promptKey === 'assistant_name') throw new Error('不能使用已被平台占用的 assistant_name');
  return {
    type: 'hello',
    version: 1,
    features: { mcp: !!mcp },
    transport: 'websocket',
    audio_params: {
      format: 'pcm', sample_rate: 16000, channels: 1, bit_depth: 16, endianness: 'little',
      frame_duration: 20, frame_size: 320, sample_format: 'signed_int16',
    },
    agent_params: { custom_replace_prompt: { [promptKey]: promptText } },
  };
}

export function buildDetect({ text, mode = 'manual', voice = null, promptReplace = null } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('缺少文本');
  const message = { type: 'listen', state: 'detect', mode, text };
  if (voice || promptReplace) {
    message.agent_params = {};
    if (voice) message.agent_params.voice = buildVoiceParams(voice);
    if (promptReplace) message.agent_params.custom_replace_prompt = promptReplace;
  }
  return message;
}

export function buildListen({ state, mode } = {}) {
  return { type: 'listen', state, mode };
}

export function buildAbort(reason = 'wake_word_detected') {
  return { type: 'abort', reason };
}

export function turnPrompt(index) {
  return `第${index + 1}次：只用四个字回答收到完毕。`;
}

export function castPrompt(member) {
  return `你现在只扮演${member.name}。请只说这四个字，不要补充：${member.marker}。不要提及其他角色，不要替别人表态。`;
}

export function recallPrompt() {
  return '你现在只扮演主持人。请只根据前面几位角色已经说过的话，按顺序复述阿柿、阿梨、阿枣、阿桃各自的态度原话。不要发明新的态度。';
}

export function situationBrief(marker, { mcp = false } = {}) {
  if (mcp) return '开口前必须调用工具 probe.situation。只朗读工具返回的 instruction，不要添加别的话。';
  return `当前局势口令是${marker}。当用户询问局势口令时，只回答该口令，不要解释，不要调用工具。`;
}

export function mcpInstruction(marker) {
  return `只回答口令：${marker}`;
}

export const PROBE_TOOLS = [
  { name: 'probe.situation', description: '读取当前局势口令。回答前必须调用，然后只朗读 instruction。', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'self.test.status', description: '兼容已绑定测评智能体的状态工具。探针里只返回局势 instruction。', inputSchema: { type: 'object', properties: {}, required: [] } },
];

export function probeMcpReply(payload, state = {}) {
  if (!payload || payload.id === undefined) return null;
  const base = { jsonrpc: '2.0', id: payload.id };
  if (payload.method === 'initialize') {
    return { ...base, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'voice-probe', version: '1.0.0' } } };
  }
  if (payload.method === 'tools/list') return { ...base, result: { tools: state.tools ?? PROBE_TOOLS } };
  if (payload.method === 'tools/call') {
    state.calls = (state.calls ?? 0) + 1;
    state.names = [...(state.names ?? []), payload.params?.name ?? ''];
    const body = { instruction: state.instruction ?? '没有新的局势。', situation: state.marker ?? null };
    return { ...base, result: { content: [{ type: 'text', text: JSON.stringify(body) }], isError: false } };
  }
  return { ...base, error: { code: -32601, message: '未知方法' } };
}

export function createTurnState(inputAt) {
  return { inputAt, firstAudioAt: null, stopAt: null, isAborted: false, texts: [], stt: [] };
}

export function reduceTurn(state, event) {
  if (!event || event.at < state.inputAt) return state;
  if (event.type === 'audio' && state.firstAudioAt == null) state.firstAudioAt = event.at;
  const message = event.type === 'json' ? event.message : null;
  if (message?.type === 'tts' && message.state === 'sentence_start' && message.text) state.texts.push(message.text);
  if (message?.type === 'tts' && message.state === 'stop' && state.stopAt == null) {
    state.stopAt = event.at;
    state.isAborted = message.is_aborted === true;
  }
  if (message?.type === 'stt' && message.text) state.stt.push(message.text);
  return state;
}

export function finalizeTurn(state) {
  const firstAudioMs = state.firstAudioAt == null ? null : state.firstAudioAt - state.inputAt;
  const endToEndMs = state.stopAt == null ? null : state.stopAt - state.inputAt;
  return {
    ok: firstAudioMs != null,
    firstAudioMs,
    endToEndMs,
    texts: [...state.texts],
    stt: [...state.stt],
    isAborted: state.isAborted,
    error: firstAudioMs == null ? '未收到 TTS 音频帧' : null,
    drainError: firstAudioMs != null && endToEndMs == null ? '未收到 tts.stop' : null,
  };
}

export function createInterruptState(abortAt) {
  return { abortAt, lastAudioAt: null, stopAt: null, isAborted: null, audioAfterStop: 0 };
}

export function reduceInterrupt(state, event) {
  if (!event || event.at < state.abortAt) return state;
  if (event.type === 'audio') {
    if (state.stopAt == null) state.lastAudioAt = event.at;
    else state.audioAfterStop += 1;
  }
  const message = event.type === 'json' ? event.message : null;
  if (message?.type === 'tts' && message.state === 'stop' && state.stopAt == null) {
    state.stopAt = event.at;
    state.isAborted = message.is_aborted === true;
  }
  return state;
}

export function finalizeInterrupt(state, { method = 'abort' } = {}) {
  const endAt = state.lastAudioAt ?? state.stopAt;
  const gotStop = state.stopAt != null;
  const leaked = method === 'abort' && state.audioAfterStop > 0;
  let error = null;
  if (!gotStop) error = '未收到 tts.stop';
  else if (leaked) error = 'abort 之后 tts.stop 仍有音频帧';
  return {
    ok: Boolean(gotStop && !leaked && endAt != null),
    latencyMs: endAt == null ? null : endAt - state.abortAt,
    stopLatencyMs: state.stopAt == null ? null : state.stopAt - state.abortAt,
    lastAudioLatencyMs: state.lastAudioAt == null ? null : state.lastAudioAt - state.abortAt,
    isAborted: state.isAborted === true,
    audioAfterStop: state.audioAfterStop,
    error,
  };
}

export function judgeMarker(texts, marker, forbidden = []) {
  const blob = (texts ?? []).join('\n');
  return { heard: blob.includes(marker), alsoHeard: forbidden.filter(item => blob.includes(item)) };
}

export function judgeRoleTurn({ texts, ownMarker, otherMarkers }) {
  const judged = judgeMarker(texts, ownMarker, otherMarkers);
  return { spokeOwnMarker: judged.heard, leakedMarkers: judged.alsoHeard, roleFidelity: judged.heard && judged.alsoHeard.length === 0 };
}

export function judgeContextRecall({ texts, markers }) {
  const blob = (texts ?? []).join('\n');
  const hit = markers.filter(marker => blob.includes(marker));
  const missing = markers.filter(marker => !blob.includes(marker));
  return { contextKept: missing.length === 0 && markers.length > 0, hit, missing };
}

export function judgePromptUpdate({ heardNew, heardOld }) {
  if (heardNew && !heardOld) return 'adopted-new';
  if (heardOld && !heardNew) return 'kept-hello';
  if (heardNew && heardOld) return 'mixed';
  return 'neither';
}

export function judgeOpeningEcho({ openingText, sttTexts }) {
  const texts = sttTexts ?? [];
  return { echoed: texts.some(text => text === openingText || (openingText && text.includes(openingText))), sttTexts: [...texts] };
}

export function describeAsrShape(transcript) {
  const text = String(transcript ?? '');
  const arabicDigits = text.match(/\d/g)?.length ?? 0;
  const chineseNumerals = text.match(/[零〇一二两三四五六七八九十百千万]/g)?.length ?? 0;
  const numberStyle = arabicDigits && chineseNumerals ? 'mixed' : arabicDigits ? 'arabic' : chineseNumerals ? 'chinese' : 'none';
  return {
    transcript: text,
    hasPunctuation: /[，。！？、；：,.!?;:]/.test(text),
    arabicDigits,
    chineseNumerals,
    numberStyle,
  };
}

export function assessPlanB({ contextKept = null, roleFidelity = null, turnsOk = null, concurrentAllowed = null, latencyOk = null, live = false } = {}) {
  const measured = contextKept != null && roleFidelity != null && turnsOk != null;
  const inSessionViable = measured ? Boolean(contextKept && roleFidelity && turnsOk) : null;
  let recommendation;
  if (!measured) recommendation = '五个音色的上下文和角色边界还没测完，Plan B 先不选定。';
  else if (inSessionViable && latencyOk === true) recommendation = '同一次测量里，一条连接轮流五个音色，上下文、角色边界和 1.5 秒开口目标都成立，可以不启用 Plan B。';
  else if (inSessionViable && latencyOk === false) recommendation = '上下文和角色边界成立，但开口 p90 超过 1.5 秒。ADR-005 的备选是预先合成每个角色的句子再播放；实时单连接仍可用，只是达不到回合间隔。';
  else if (inSessionViable) recommendation = '同一次测量里，一条连接轮流五个音色，上下文和角色边界都成立。开口延迟还没对照 1.5 秒，暂不判断要不要预先合成。';
  else if (concurrentAllowed === true) recommendation = '会话内换音色没有同时保住上下文和角色边界。Plan B：编排器自己记上下文；音色用第三方 SSE 按句 voice_type，或同设备多条连接各绑一个音色（本次并发探针允许第二条 WSS）。若演示来不及改接入，可预先合成再播放。';
  else if (concurrentAllowed === false) recommendation = '会话内换音色未达标，且同一设备号没能同时保住第二条 WSS。Plan B：每角色独立设备号，或第三方 SSE 在一条连接上按句指定 voice_type，上下文放在编排器。若演示来不及改接入，可预先合成再播放。';
  else recommendation = '会话内换音色未达标。并发探针还没有结论时，Plan B 备选是 SSE 按句音色，或多连接（同设备或一角色一设备）。若演示来不及改接入，可预先合成再播放。';
  if (!live) recommendation = `（非真机，只是把本次样本代入决策规则）${recommendation}`;
  return {
    inSessionViable,
    required: inSessionViable == null ? null : !inSessionViable || latencyOk === false,
    confirmedOnDevice: Boolean(live),
    sse: PLAN_B_OPTIONS.sse,
    multiConnection: { ...PLAN_B_OPTIONS.multiConnection, sameDeviceConcurrent: concurrentAllowed },
    prerender: PLAN_B_OPTIONS.prerender,
    recommendation,
  };
}

export function pcmFromWav(buffer) {
  const bytes = Buffer.from(buffer);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('不是 WAV');
  let offset = 12;
  let data = null;
  let channels = null;
  let bits = null;
  let rate = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) throw new Error('WAV 块越界');
    if (id === 'fmt ') {
      channels = bytes.readUInt16LE(start + 2);
      rate = bytes.readUInt32LE(start + 4);
      bits = bytes.readUInt16LE(start + 14);
    } else if (id === 'data') {
      data = bytes.subarray(start, start + size);
      break;
    }
    offset = start + size + (size % 2);
  }
  if (!data || channels == null) throw new Error('WAV 缺少 data 或 fmt');
  if (channels !== 1 || bits !== 16) throw new Error('需要单声道 16bit PCM');
  if (rate !== 16000) throw new Error('需要 16000 Hz');
  return data;
}

export function splitPcmFrames(pcm, frameBytes = 640) {
  const bytes = Buffer.from(pcm);
  const frames = [];
  for (let offset = 0; offset + frameBytes <= bytes.length; offset += frameBytes) frames.push(bytes.subarray(offset, offset + frameBytes));
  return frames;
}

export function loadPcmFrames(buffer) {
  const bytes = Buffer.from(buffer);
  const pcm = bytes.toString('ascii', 0, 4) === 'RIFF' ? pcmFromWav(bytes) : bytes;
  const frames = splitPcmFrames(pcm);
  if (!frames.length) throw new Error('音频太短，不足一帧');
  return frames;
}

function fmt(value) {
  return value == null ? '—' : String(value);
}

function flag(value) {
  if (value == null) return '待测';
  return value ? '是' : '否';
}

export function formatProbeReport(report) {
  const probes = report?.probes ?? {};
  const lines = [
    `灵矽语音探针  ${report?.timestamp ?? ''}`,
    `总结果 ${report?.ok ? '通过' : '未通过'}  开口目标 ${report?.targetMs ?? TURN_TARGET_MS}ms（p90 首帧）`,
  ];
  const pushStats = (title, section, field = 'stats') => {
    if (!section) return;
    const stats = section[field] ?? emptyStats();
    lines.push(`${title}  成功 ${flag(section.ok)}  n=${fmt(stats.count)} min=${fmt(stats.min)} median=${fmt(stats.median)} p90=${fmt(stats.p90)} max=${fmt(stats.max)} 达标=${flag(section.meetsTarget)}${section.error ? `  错误=${section.error}` : ''}`);
  };
  pushStats('首字延迟', probes.firstAudio);
  if (probes.turnLatency) {
    pushStats('回合开口', probes.turnLatency);
    const complete = probes.turnLatency.completeStats ?? emptyStats();
    lines.push(`回合说完  n=${fmt(complete.count)} min=${fmt(complete.min)} median=${fmt(complete.median)} p90=${fmt(complete.p90)} 说完达标=${flag(probes.turnLatency.completeMeetsTarget)}`);
  }
  const voice = probes.voiceSwitch;
  if (voice) {
    lines.push(`换音色  成功 ${flag(voice.ok)}  上下文 ${flag(voice.contextKept)}  角色不串台 ${flag(voice.roleFidelity)}${voice.error ? `  错误=${voice.error}` : ''}`);
    for (const turn of voice.turns ?? []) {
      lines.push(`  ${turn.role ?? '—'} ${turn.voiceId ?? '—'} 首帧=${fmt(turn.latencyMs)} 与上一段差=${fmt(turn.deltaFromPreviousMs)} 本角=${flag(turn.spokeOwnMarker)} 串台=${flag(turn.leakedMarkers?.length ? true : turn.spokeOwnMarker == null ? null : false)}`);
    }
    if (voice.recall) lines.push(`  复述 首帧=${fmt(voice.recall.latencyMs)} 命中=${(voice.recall.hit ?? []).join('、') || '—'} 缺失=${(voice.recall.missing ?? []).join('、') || '—'}`);
  }
  const interrupt = probes.interrupt;
  if (interrupt) {
    lines.push(`打断  成功 ${flag(interrupt.ok)}${interrupt.error ? `  错误=${interrupt.error}` : ''}`);
    for (const [name, group] of Object.entries(interrupt.groups ?? {})) {
      const stats = group.stats ?? emptyStats();
      lines.push(`  ${name} n=${fmt(stats.count)} min=${fmt(stats.min)} median=${fmt(stats.median)} p90=${fmt(stats.p90)} 成功=${flag(group.ok)}`);
    }
  }
  const situation = probes.situation;
  if (situation) {
    lines.push(`局势注入  成功 ${flag(situation.ok)}${situation.error ? `  错误=${situation.error}` : ''}`);
    for (const trial of situation.trials ?? []) {
      const extra = trial.observation ? ` 观察=${trial.observation}` : '';
      const cost = trial.stats?.median ?? trial.reconnectMs ?? trial.latencyMs;
      lines.push(`  ${trial.method} 成功=${flag(trial.ok)} 耗时=${fmt(cost)}${extra}${trial.error ? ` 错误=${trial.error}` : ''}`);
    }
  }
  for (const [title, section] of [['连接耗时', probes.connectTiming], ['开场STT', probes.openingSttEcho], ['ASR形态', probes.asrShape], ['同设备双连接', probes.concurrentSocket]]) {
    if (!section) continue;
    if (section.skipped) {
      lines.push(`${title}  跳过  ${section.reason ?? section.error ?? ''}`);
      continue;
    }
    lines.push(`${title}  成功 ${flag(section.ok)}${section.allowed == null ? '' : `  允许第二条=${flag(section.allowed)}`}${section.echoed == null ? '' : `  回显=${flag(section.echoed)}`}${section.error ? `  错误=${section.error}` : ''}`);
  }
  if (report?.planB?.recommendation) lines.push(`Plan B  ${report.planB.recommendation}`);
  if (report?.error) lines.push(`错误  ${report.error}`);
  return lines.join('\n');
}
