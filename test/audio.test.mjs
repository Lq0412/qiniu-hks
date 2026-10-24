import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceAudio } from '../public/audio.js';

function environment(t, getMedia) {
  const original = Object.fromEntries(['AudioContext','AudioWorkletNode','navigator'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const nodes=[];
  class Context {
    state='running';currentTime=0;destination={};audioWorklet={addModule:async()=>{}};
    async resume(){} async close(){this.state='closed';}
    createMediaStreamSource(){return {connect(){}};}
    createGain(){return {gain:{value:1},connect(){}};}
    createBuffer(channels,length,rate){const samples=new Float32Array(length);return {duration:length/rate,getChannelData:()=>samples};}
    createBufferSource(){const source={connect(){},start(at){this.at=at;},stop(){this.stopped=true;}};nodes.push(source);return source;}
  }
  class Worklet { port={postMessage(){}};connect(){}disconnect(){this.disconnected=true;} }
  Object.defineProperty(globalThis,'navigator',{value:{mediaDevices:{getUserMedia:getMedia}},configurable:true});
  globalThis.AudioContext=Context;globalThis.AudioWorkletNode=Worklet;
  t.after(()=>{for(const [key,descriptor] of Object.entries(original)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}});
  return nodes;
}

test('microphone stops on stage completion while queued playback can finish',async t=>{
  let stopped=0;const nodes=environment(t,async()=>({getTracks:()=>[{stop:()=>stopped++}]}));
  const audio=new VoiceAudio();await audio.init(()=>{});audio.rate=16000;
  const packet=new ArrayBuffer(4);new DataView(packet).setInt16(0,16384,true);audio.play(packet);
  assert.equal(nodes.length,1);assert.ok(audio.remainingMs()>0);audio.record(true);audio.releaseMic();
  assert.equal(stopped,1);assert.equal(audio.node,null);assert.equal(nodes[0].stopped,undefined);
  audio.close();assert.equal(nodes[0].stopped,true);assert.equal(audio.context,null);assert.equal(audio.remainingMs(),0);
  audio.play(packet);audio.record(false);
});
test('late permission response after cancellation immediately releases microphone',async t=>{
  let resolveMedia,stopped=0;environment(t,()=>new Promise(r=>{resolveMedia=r;}));
  const audio=new VoiceAudio();const init=audio.init(()=>{});await Promise.resolve();audio.close();
  resolveMedia({getTracks:()=>[{stop:()=>stopped++}]});await assert.rejects(init,/取消/);assert.equal(stopped,1);
});
test('permission denial closes audio resources',async t=>{
  environment(t,async()=>{throw new Error('denied');});const audio=new VoiceAudio();await assert.rejects(audio.init(()=>{}),/denied/);assert.equal(audio.context,null);audio.close();
});
