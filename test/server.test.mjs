import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { createApp } from '../server.mjs';
test('HTTP assets, cookie state, activation and endpoint guards', async t => {
  const server=createApp({loadConfig:async()=>({}),getOta:async()=>({activation:{code:'123456'}})});
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  for(const path of ['/','/app.js','/style.css','/audio.js','/recorder.js','/api/health'])assert.equal((await fetch(base+path)).status,200);
  assert.equal((await fetch(base+'/missing')).status,404);
  const denied=await new Promise((resolve,reject)=>{http.get(base+'/api/game',{headers:{host:'evil.test'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});
  assert.equal(denied,403);
  const post=(path,cookie='',origin=base)=>fetch(base+path,{method:'POST',headers:{cookie,origin}});
  assert.equal((await post('/api/game','','https://evil.test')).status,403);
  assert.equal((await post('/api/next')).status,409);
  const start=await post('/api/game');assert.equal(start.status,201);const cookie=start.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await fetch(base+'/api/game',{headers:{cookie}})).json()).game.stage,0);
  assert.equal((await (await fetch(base+'/api/game')).json()).game,null);
  assert.equal((await post('/api/next',cookie)).status,400);
  assert.equal((await post('/api/connect',cookie)).status,409);
  assert.equal((await (await post('/api/activation')).json()).bound,false);
});

test('voice tickets are same-origin, single-use and invalidated on restart',async t=>{
  let connection;
  const server=createApp({loadConfig:async()=>({}),getOta:async()=>({websocket:{url:'wss://xrobo-io.qiniuapi.com/v1/ws/',token:'test'}}),openVoice:({client,game,onClose})=>{
    connection={client,game};client.on('close',onClose);return {close:()=>{onClose();client.close();}};
  }});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{connection?.client.terminate();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const start=await fetch(base+'/api/game',{method:'POST',headers:{origin:base}});const cookie=start.headers.get('set-cookie').split(';')[0];
  const post=path=>fetch(base+path,{method:'POST',headers:{origin:base,cookie}});
  const ticket=(await(await post('/api/connect')).json()).ticket;
  const connect=(value,origin=base)=>new WebSocket(base.replace('http:','ws:')+'/voice?ticket='+value,{headers:{origin,cookie}});
  await new Promise(r=>{const bad=connect(ticket,'https://evil.test');bad.on('error',()=>r());});
  const ws=connect(ticket);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});assert.ok(connection.game.id);
  await new Promise(r=>{const replay=connect(ticket);replay.on('error',()=>r());});
  const ended=new Promise(r=>ws.once('close',r));assert.equal((await post('/api/game')).status,201);await ended;
  assert.equal((await post('/api/connect')).status,200);
  const running=(await(await fetch(base+'/api/game',{headers:{cookie}})).json()).game;
  assert.notEqual(running.id,connection.game.id);
});
