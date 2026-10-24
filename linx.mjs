import WebSocket from 'ws';
import OpusScript from 'opusscript';
import { brief, questions } from './benchmark.mjs';
import { addSpeech, evaluate, saveReport, view } from './game.mjs';

// 模型偶尔会把工具调用过程念出来（“我先查看一下测评状态”“我来生成最终报告”）。
// 这类过程语只可能是短句：在句子级静音并丢弃对应音频，玩家只能听到正式反馈。
// 名词只收“状态/工具/最终报告”，不收“报告”单独出现，避免误吞“报告已经生成”这类公布语。
export const PROCESS_RE = /(查看|读取|看一下|看一眼|看看|获取|检查|分析|整理|调用).{0,8}(测评状态|当前状态|当前的?测评|测评结果|工具)|(生成|编译|整理).{0,4}(最终报告|测评报告|报告)/;
export const isProcessSpeech = text => typeof text === 'string' && text.trim().length <= 30 && PROCESS_RE.test(text);

export const tools = [
  {name:'self.test.status',description:'读取当前测评题号、回答版本revision、最新转写和已确认的回答；每次评价前读取。',inputSchema:{type:'object',properties:{},required:[]}},
  {name:'self.test.evaluate',description:'为当前回答记录一句短反馈，等待用户确认后再下一题。',inputSchema:{type:'object',properties:{question:{type:'integer'},revision:{type:'integer'},quote:{type:'string'},feedback:{type:'string'}},required:['question','revision','quote','feedback']}},
  {name:'self.test.report',description:'六题确认后提交最终模型测评报告。report_json必须是包含型号、夯拉等级与三项带引用维度的JSON字符串，按当前提示中的结构填写。',inputSchema:{type:'object',properties:{report_json:{type:'string'}},required:['report_json']}},
];

export function mcpRejectDetail(reply) {
  try {
    const parsed = JSON.parse(reply?.result?.content?.[0]?.text || '{}');
    const error = parsed?.error;
    if (typeof error === 'string' && error.trim()) return error.trim();
    if (typeof error?.message === 'string' && error.message.trim()) return error.message.trim();
  } catch { /* 坏 JSON 也要留下一句可读的原因 */ }
  return '请求被拒绝';
}
export function mcpReply(payload,game,stage) {
  const reply={jsonrpc:'2.0',id:payload.id};
  if(payload.method==='initialize')return {...reply,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'human-benchmark',version:'1.0.0'}}};
  if(payload.method==='tools/list')return {...reply,result:{tools}};
  if(payload.method==='tools/call'){
    try{
      let result;
      if(payload.params?.name==='self.test.status')result=view(game);
      else if(payload.params?.name==='self.test.evaluate')result=evaluate(game,stage,payload.params.arguments??{});
      else if(payload.params?.name==='self.test.report')result=saveReport(game,stage,payload.params.arguments?.report_json);
      else return {...reply,error:{code:-32601,message:'未知工具'}};
      return {...reply,result:{content:[{type:'text',text:JSON.stringify({...result,instruction:result.status==='done'?'报告已保存，只用两句话公布型号和评级。':brief(game.stage,game)})}],isError:false}};
    }catch(error){return {...reply,result:{content:[{type:'text',text:JSON.stringify({error:error.message,state:view(game),instruction:brief(game.stage,game)})}],isError:true}};}
  }
  return {...reply,error:{code:-32601,message:'未知方法'}};
}
export function connectLinx({ config, credentials, game, client, onClose, createSocket = (url, options) => new WebSocket(url, options) }) {
  const stage = game.stage;
  const openingText = game.status === 'reporting' ? '六题已全部确认，请生成最终报告。' : questions[stage].text;
  const url = new URL(credentials.url);
  // OTA currently advertises ws; this fixed platform endpoint also supports WSS.
  if (url.hostname !== 'xrobo-io.qiniuapi.com') throw new Error('Linx返回了未支持的语音地址。');
  url.protocol = 'wss:';
  const upstream = createSocket(url, { headers: { Authorization: `Bearer ${credentials.token}`, 'Protocol-Version': '1', 'Device-Id': config.deviceId, 'Client-Id': config.clientId }, handshakeTimeout: 15000, maxPayload: 1024 * 1024 });
  let sessionId;
  let ready = false;
  let closed = false;
  let decoder = null;
  let openingPending = false;
  let toolsReady = false;
  let muted = false;
  let muteTimer = null;
  let audioOk = false;
  const pendingInputs = [];
  const emit = data => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data)); };
  const send = data => {
    if(data.type === 'listen' && !toolsReady) { if(pendingInputs.length < 8)pendingInputs.push(data); return; }
    if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ ...data, session_id: sessionId }));
  };
  const timer = setTimeout(() => { emit({ type: 'error', message: 'Linx语音握手超时，请重新连接。' }); upstream.close(); }, 20000);
  const close = () => { if (closed) return; closed = true; clearTimeout(timer); clearTimeout(muteTimer); upstream.close(); decoder?.delete(); decoder = null; onClose?.(); };
  upstream.on('open', () => send({ type: 'hello', version: 1, features: { mcp: true }, transport: 'websocket', audio_params: { format: 'pcm', sample_rate: 16000, channels: 1, bit_depth: 16, endianness: 'little', frame_duration: 20, frame_size: 320, sample_format: 'signed_int16' }, agent_params: { custom_replace_prompt: { counter_brief: brief(stage, game) } } }));
  upstream.on('message', (data, binary) => {
    if (closed) return;
    if (binary) {
      if (closed) return;
      // 静音时也要继续喂解码器，保证 Opus 帧连续；只丢弃播放输出。
      try {
        const pcm = decoder ? decoder.decode(data) : data;
        audioOk = true;
        if (!muted && client.readyState === WebSocket.OPEN) client.send(pcm, { binary: true });
      } catch {
        // 首次就失败说明音频格式不支持；成功解码后的偶发残帧（如断连收尾）静默跳过，不打断体验。
        if (!audioOk) emit({ type: 'error', message: 'Linx音频解码失败，请重新连接。' });
      }
      return;
    }
    let message;
    try { message = JSON.parse(data.toString()); } catch { emit({ type: 'error', message: 'Linx返回了无效消息。' }); return; }
    if (message.type === 'hello') {
      clearTimeout(timer); ready = true; sessionId = message.session_id;
      const params = message.audio_params;
      if (!params || !['pcm', 'opus'].includes(params.format) || ![16000, 24000, 48000].includes(params.sample_rate) || params.channels !== 1) { emit({ type: 'error', message: 'Linx返回的音频参数不受支持。' }); close(); client.close(); return; }
      if (params.format === 'opus') decoder = new OpusScript(params.sample_rate, 1, OpusScript.Application.AUDIO);
      emit({ ...message, audio_params: { ...params, format: 'pcm' } }); emit({ type: 'game', game: view(game) });
      return;
    }
    if (message.type === 'mcp' && message.payload?.id !== undefined) {
      const reply = mcpReply(message.payload, game, stage);
      if (reply.result?.isError) {
        console.error('[mcp拒绝]', message.payload.params?.name || '未知工具', mcpRejectDetail(reply));
        const feedback = message.payload.params?.name === 'self.test.evaluate';
        emit({type:feedback?'feedback_error':'error',message:feedback?'这次反馈未能保存。可以重答，或点击重试反馈。':'报告尚未保存，测试员正在修正；也可以断开后重试。'});
      }
      send({ type: 'mcp', payload: reply });
      if(message.payload.method === 'tools/list') { toolsReady = true; for(const input of pendingInputs.splice(0))send(input); }
      emit({ type: 'game', game: view(game) });
      return;
    }
    if (message.type === 'stt') {
      if (openingPending && message.text === openingText) { openingPending = false; return; }
      openingPending = false;
      addSpeech(game, message.text);
    }
    if (message.type === 'tts') {
      if (message.state === 'start') { muted = false; clearTimeout(muteTimer); }
      if (message.state === 'sentence_start' && message.text) {
        if (isProcessSpeech(message.text)) {
          muted = true;
          clearTimeout(muteTimer);
          muteTimer = setTimeout(() => { muted = false; }, 3000); // 句边界丢失时的兜底，防止永久静音
          return;
        }
        muted = false; clearTimeout(muteTimer);
        game.dialogue.push({ who: 'clerk', text: message.text.slice(0, 1000), stage });
      }
      if (message.state === 'stop') { muted = false; clearTimeout(muteTimer); }
    }
    emit(message);
    if (['stt', 'tts'].includes(message.type)) emit({ type: 'game', game: view(game) });
  });
  upstream.on('error', () => { emit({ type: 'error', message: 'Linx连接失败，请检查设备绑定和网络。' }); close(); client.close(1011); });
  upstream.on('close', () => { if (!closed) { emit({ type: 'disconnected' }); close(); client.close(); } });
  client.on('message', (data, binary) => {
    if (closed || !ready) return;
    if (binary) { if (data.length <= 8192 && upstream.bufferedAmount < 1024 * 1024) upstream.send(data, { binary: true }); return; }
    try {
      const input = JSON.parse(data.toString());
      if (input.type === 'listen' && ['start', 'stop'].includes(input.state)) send({ type: 'listen', state: input.state, mode: 'manual' });
      else if (input.type === 'abort') send({ type: 'abort', reason: 'wake_word_detected' });
      else if (input.type === 'opening') { openingPending = true; send(game.status === 'reporting' ? {type:'listen',state:'detect',text:openingText} : {type:'listen',state:'detect',text:'开始测试',text_response:openingText}); }
      else if (input.type === 'text' && typeof input.text === 'string' && input.text.trim() && input.text.length <= 500) send({ type: 'listen', state: 'detect', text: input.text.trim() });
    } catch { emit({ type: 'error', message: '消息格式不正确。' }); }
  });
  client.on('close', close);
  client.on('error', close);
  return { close };
}
