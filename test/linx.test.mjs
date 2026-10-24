import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceConfig, ota, otaApplication } from '../linx-config.mjs';
import { connectLinx, isProcessSpeech, mcpRejectDetail } from '../linx.mjs';
import { createGame } from '../game.mjs';

class FakeSocket extends EventEmitter {
  readyState=1;bufferedAmount=0;sent=[];
  send(data,options){this.sent.push({data,options});}
  close(){this.readyState=3;this.emit('close');}
}
function fixture() {
  const upstream=new FakeSocket(),client=new FakeSocket(),game=createGame();
  const bridge=connectLinx({config:{deviceId:'test',clientId:'test'},credentials:{url:'ws://xrobo-io.qiniuapi.com/v1/ws/',token:'test-only'},game,client,createSocket:()=>upstream});
  const incoming=message=>upstream.emit('message',Buffer.from(typeof message==='string'?message:JSON.stringify(message)),false);
  const outgoing=message=>client.emit('message',Buffer.from(typeof message==='string'?message:JSON.stringify(message)),false);
  return {upstream,client,game,bridge,incoming,outgoing};
}
test('device persistence, malformed config and OTA contract',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'counter-'));
  try {
    const path=join(dir,'device.json'),first=await deviceConfig(path);assert.match(first.deviceId,/^02(:[A-F0-9]{2}){5}$/);assert.deepEqual(await deviceConfig(path),first);
    await writeFile(path,'{');await assert.rejects(deviceConfig(path));
    const data=await ota(first,async(url,options)=>{assert.match(url,/qiniuapi/);assert.equal(options.headers['Device-Id'],first.deviceId);assert.equal(options.headers['User-Agent'],'who-is-human/1.0.0');const body=JSON.parse(options.body);assert.equal(body.mac_address,first.deviceId);assert.deepEqual(body.application,{name:'who-is-human',version:'1.0.0',elf_sha256:'who-is-human-local'});return {ok:true,json:async()=>({activation:{code:'123456'}})};},{});assert.equal(data.activation.code,'123456');
    await assert.rejects(ota(first,async()=>({ok:false,status:503})),/503/);
  } finally {await rm(dir,{recursive:true});}
});
test('OTA application name defaults to who-is-human and can be overridden', async () => {
  const config = { deviceId: '02:00:00:00:00:01', clientId: 'client' };
  const capture = async (env, extra = {}) => {
    let application;
    await ota({ ...config, ...extra }, async (_url, options) => {
      application = JSON.parse(options.body).application;
      return { ok: true, json: async () => ({ ok: true }) };
    }, env);
    return application;
  };
  assert.deepEqual(await capture({}), { name: 'who-is-human', version: '1.0.0', elf_sha256: 'who-is-human-local' });
  assert.deepEqual(await capture({ LINX_APP_NAME: '  ', LINX_APP_ELF_SHA256: '' }), { name: 'who-is-human', version: '1.0.0', elf_sha256: 'who-is-human-local' });
  assert.deepEqual(await capture({ LINX_APP_NAME: '  trial-name  ', LINX_APP_ELF_SHA256: 'trial-elf' }), { name: 'trial-name', version: '1.0.0', elf_sha256: 'trial-elf' });
  const fromConfig = await capture({ LINX_APP_NAME: 'from-env', LINX_APP_ELF_SHA256: 'from-env' }, { applicationName: 'from-config', elfSha256: '  ' });
  assert.equal(fromConfig.name, 'from-config');
  assert.equal(fromConfig.elf_sha256, 'from-env');
  const ignored = await capture({ LINX_APP_NAME: 'from-env' }, { applicationName: 1, elfSha256: null });
  assert.equal(ignored.name, 'from-env');
  assert.equal(ignored.elf_sha256, 'who-is-human-local');
  assert.deepEqual(otaApplication({}, {}), { name: 'who-is-human', version: '1.0.0', elf_sha256: 'who-is-human-local' });
});
test('Linx hello, MCP, transcript, audio forwarding and client controls',()=>{
  const f=fixture();
  f.outgoing({type:'text',text:'not ready'});assert.equal(f.upstream.sent.length,0);
  f.upstream.emit('open');
  assert.equal(JSON.parse(f.upstream.sent[0].data).audio_params.format,'pcm');
  f.incoming({type:'hello',session_id:'s',audio_params:{format:'pcm',sample_rate:16000,channels:1}});
  f.incoming({type:'mcp',payload:{id:1,method:'tools/list'}});
  f.incoming({type:'stt',text:'有依据'});f.incoming({type:'tts',state:'sentence_start',text:'请说'});
  assert.equal(f.game.turn,1);assert.equal(f.game.dialogue.length,2);
  f.incoming({type:'mcp',payload:{id:2,method:'tools/call',params:{name:'self.test.evaluate',arguments:{question:1,revision:1,quote:'依据',feedback:'合理'}}}});
  assert.equal(f.game.feedback.text,'合理');
  f.upstream.emit('message',Buffer.alloc(640),true);assert.ok(f.client.sent.some(s=>s.options?.binary));
  f.client.emit('message',Buffer.alloc(640),true);
  for(const message of [{type:'listen',state:'start'},{type:'listen',state:'stop'},{type:'abort'},{type:'opening'},{type:'text',text:'你好'}])f.outgoing(message);
  f.outgoing({type:'opening'});f.incoming({type:'stt',text:'你刚进一个群，有人说：“明天老地方，懂的都懂。”你根本不知道老地方是哪。你会怎么回？'});assert.equal(f.game.turn,1);
  f.incoming('{');f.outgoing('{');
  assert.ok(f.client.sent.some(s=>typeof s.data==='string'&&JSON.parse(s.data).type==='error'));
  f.bridge.close();f.bridge.close();f.incoming({type:'stt',text:'旧消息'});assert.equal(f.game.turn,1);
});
test('tool process monologue is filtered out at sentence and audio level',()=>{
 for(const text of ['我先查看一下当前测评状态。','我先读取当前的测评状态。','我来看看当前的测评状态','我来生成最终报告。','让我调用工具。','我来生成报告。'])assert.ok(isProcessSpeech(text),text);
 for(const text of ['直接问定位，信息边界清晰。','时间地点忌口都齐了，群通知够利索。','你的鉴定结果是通义千问，夯爆了。','这是你的报告，收好。','报告已经生成，你是豆包型人类。','少了点烟火气，像群公告。'])assert.ok(!isProcessSpeech(text),text);
 const f=fixture();
 f.incoming({type:'hello',session_id:'s',audio_params:{format:'pcm',sample_rate:16000,channels:1}});
 f.incoming({type:'tts',state:'start'});
 f.incoming({type:'tts',state:'sentence_start',text:'我先查看一下当前测评状态。'});
 assert.ok(!f.client.sent.some(s=>typeof s.data==='string'&&s.data.includes('查看')));
 f.upstream.emit('message',Buffer.alloc(640),true);
 assert.ok(!f.client.sent.some(s=>s.options?.binary));
 f.incoming({type:'tts',state:'sentence_start',text:'直接问定位，信息边界清晰。'});
 assert.ok(f.client.sent.some(s=>typeof s.data==='string'&&s.data.includes('直接问定位')));
 f.upstream.emit('message',Buffer.alloc(640),true);
 assert.ok(f.client.sent.some(s=>s.options?.binary));
});
test('Opus decoding and connection failures are explicit',()=>{
  const f=fixture();f.incoming({type:'hello',audio_params:{format:'opus',sample_rate:24000,channels:1}});f.upstream.emit('message',Buffer.alloc(10,0xAA),true);
  assert.ok(f.client.sent.some(s=>typeof s.data==='string'&&s.data.includes('音频解码失败')));
  f.incoming({type:'mcp',payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'self.test.evaluate',arguments:{question:1,revision:999,quote:'x',feedback:'x'}}}});
  assert.ok(f.client.sent.some(s=>typeof s.data==='string'&&s.data.includes('这次反馈未能保存')));
  f.bridge.close();
  const invalid=fixture();invalid.incoming({type:'hello',audio_params:{format:'unknown',sample_rate:1,channels:2}});assert.equal(invalid.client.readyState,3);
  const err=fixture();err.upstream.emit('error',new Error('network'));assert.equal(err.client.readyState,3);
  const closed=fixture();closed.upstream.close();assert.equal(closed.client.readyState,3);
  const client=fixture();client.client.emit('error',new Error('client'));assert.equal(client.upstream.readyState,3);
  assert.throws(()=>connectLinx({credentials:{url:'wss://evil.test'},game:createGame()}),/未支持/);
});
test('mcp reject log prints the error string', () => {
  assert.equal(mcpRejectDetail({ result: { content: [{ text: JSON.stringify({ error: '题目或回答已更新，请先读取状态。' }) }] } }), '题目或回答已更新，请先读取状态。');
  assert.equal(mcpRejectDetail({ result: { content: [{ text: JSON.stringify({ error: { message: '引用必须逐字' } }) }] } }), '引用必须逐字');
  assert.equal(mcpRejectDetail({ result: { content: [{ text: '{' }] } }), '请求被拒绝');
  assert.equal(mcpRejectDetail({}), '请求被拒绝');
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.map(item => String(item)).join(' ')); };
  try {
    const f = fixture();
    f.incoming({ type: 'hello', session_id: 's', audio_params: { format: 'pcm', sample_rate: 16000, channels: 1 } });
    f.incoming({ type: 'mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'self.test.evaluate', arguments: { question: 1, revision: 999, quote: 'x', feedback: 'x' } } } });
  } finally {
    console.error = original;
  }
  const line = lines.find(item => item.includes('[mcp拒绝]'));
  assert.ok(line);
  assert.equal(line.includes('undefined'), false);
  assert.match(line, /题目或回答已更新/);
});
