import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceConfig, ota } from '../linx-config.mjs';
import { connectLinx } from '../linx.mjs';
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
    const data=await ota(first,async(url,options)=>{assert.match(url,/qiniuapi/);assert.equal(options.headers['Device-Id'],first.deviceId);assert.equal(JSON.parse(options.body).mac_address,first.deviceId);return {ok:true,json:async()=>({activation:{code:'123456'}})};});assert.equal(data.activation.code,'123456');
    await assert.rejects(ota(first,async()=>({ok:false,status:503})),/503/);
  } finally {await rm(dir,{recursive:true});}
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
  f.incoming({type:'mcp',payload:{id:2,method:'tools/call',params:{name:'self.game.review',arguments:{turn:1,delta:25,reason:'合理'}}}});
  assert.equal(f.game.score,55);
  f.upstream.emit('message',Buffer.alloc(640),true);assert.ok(f.client.sent.some(s=>s.options?.binary));
  f.client.emit('message',Buffer.alloc(640),true);
  for(const message of [{type:'listen',state:'start'},{type:'listen',state:'stop'},{type:'abort'},{type:'opening'},{type:'text',text:'你好'}])f.outgoing(message);
  f.outgoing({type:'opening'});f.incoming({type:'stt',text:'下一位！号条呢？没有号条，我怎么知道你不是来插队的？'});assert.equal(f.game.turn,1);
  f.incoming('{');f.outgoing('{');
  assert.ok(f.client.sent.some(s=>typeof s.data==='string'&&JSON.parse(s.data).type==='error'));
  f.bridge.close();f.bridge.close();f.incoming({type:'stt',text:'旧消息'});assert.equal(f.game.turn,1);
});
test('Opus decoding and connection failures are explicit',()=>{
  const f=fixture();f.incoming({type:'hello',audio_params:{format:'opus',sample_rate:24000,channels:1}});f.upstream.emit('message',Buffer.alloc(0),true);f.bridge.close();
  const invalid=fixture();invalid.incoming({type:'hello',audio_params:{format:'unknown',sample_rate:1,channels:2}});assert.equal(invalid.client.readyState,3);
  const err=fixture();err.upstream.emit('error',new Error('network'));assert.equal(err.client.readyState,3);
  const closed=fixture();closed.upstream.close();assert.equal(closed.client.readyState,3);
  const client=fixture();client.client.emit('error',new Error('client'));assert.equal(client.upstream.readyState,3);
  assert.throws(()=>connectLinx({credentials:{url:'wss://evil.test'},game:createGame()}),/未支持/);
});
