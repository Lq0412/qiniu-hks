import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,addSpeech,evaluate,advance,saveReport,view} from '../game.mjs';
import {mcpReply} from '../linx.mjs';
import {dimensions} from '../benchmark.mjs';
function answer(g){addSpeech(g,'我会先确认实际信息，再安排后续事情。');evaluate(g,g.stage,{question:g.stage+1,revision:g.pending.revision,quote:'确认实际信息',feedback:'先查再说，有点东西。'});}
function completed(){const g=createGame();for(let i=0;i<6;i++){answer(g);advance(g,g.pending.revision);}return g;}
function report(){return {model:'DeepSeek',tier:'夯爆了',headline:'脑子在线',summary:'先确认再行动。',roast:'脑补服务今天暂停营业。',advice:'继续保持。',dimensions:dimensions.map(name=>({name,verdict:'在线',comment:'保留了信息边界。',question:1,quote:'确认实际信息'}))};}
test('confirmed answers, revisions and final evidence are authoritative',()=>{
 const g=createGame();assert.equal(addSpeech(g,''),false);assert.equal(addSpeech(g,null),false);assert.throws(()=>advance(g,0));answer(g);const old=g.pending.revision;addSpeech(g,'重答：我会确认实际信息。');assert.throws(()=>advance(g,old));assert.throws(()=>evaluate(g,0,{question:1,revision:old,quote:'确认',feedback:'好'}));
 evaluate(g,0,{question:1,revision:g.pending.revision,quote:'确认',feedback:'好'});advance(g,g.pending.revision);assert.equal(g.answers[0].text,'重答：我会确认实际信息。');const v=view(g);v.answers[0].text='篡改';assert.notEqual(v.answers[0].text,g.answers[0].text);
 const done=completed();assert.equal(done.status,'reporting');assert.equal(addSpeech(done,'多余输入'),false);assert.throws(()=>advance(done,6));saveReport(done,6,JSON.stringify(report()));assert.equal(done.status,'done');assert.throws(()=>saveReport(done,6,JSON.stringify(report())));
});
test('invalid tool calls and fabricated report evidence are rejected',()=>{
 const g=createGame();assert.throws(()=>saveReport(g,0,'{}'));addSpeech(g,'确认实际信息');
 for(const args of [{quote:'假的',feedback:'好'},{quote:'',feedback:'好'},{quote:null,feedback:'好'},{quote:'确认',feedback:''},{quote:'确认',feedback:null},{quote:'确认',feedback:'太'.repeat(101)}])assert.throws(()=>evaluate(g,0,{question:1,revision:1,...args}));
 assert.equal(mcpReply({id:1,method:'initialize'},g,0).result.serverInfo.name,'human-benchmark');assert.equal(mcpReply({id:2,method:'tools/list'},g,0).result.tools.length,3);
 assert.equal(mcpReply({id:3,method:'tools/call',params:{name:'self.test.status'}},g,0).result.isError,false);
 assert.equal(mcpReply({id:4,method:'tools/call',params:{name:'self.test.evaluate'}},g,0).result.isError,true);
 assert.ok(mcpReply({id:5,method:'unknown'},g,0).error);assert.ok(mcpReply({id:6,method:'tools/call',params:{name:'unknown'}},g,0).error);
 const done=completed();for(const raw of [null,'x','x'.repeat(12001),'null'])assert.throws(()=>saveReport(done,6,raw));
 const mutations=[r=>r.model='未知',r=>r.tier='神',r=>r.headline='',r=>r.summary=null,r=>r.roast='长'.repeat(301),r=>r.dimensions=null,r=>r.dimensions=[],r=>r.dimensions[0].name='速度',r=>r.dimensions[0].verdict='',r=>r.dimensions[0].verdict='长'.repeat(41),r=>r.dimensions[0].comment='',r=>r.dimensions[0].comment='长'.repeat(201),r=>r.dimensions[0].question=7,r=>r.dimensions[0].question=1.1,r=>r.dimensions[0].quote='虚构证据啊',r=>r.dimensions[0].quote='',r=>r.dimensions[0].quote=null];
 for(const mutate of mutations){const r=report();mutate(r);assert.throws(()=>saveReport(done,6,JSON.stringify(r)));}
 assert.equal(mcpReply({id:7,method:'tools/call',params:{name:'self.test.report',arguments:{report_json:JSON.stringify(report())}}},done,6).result.isError,false);
});

test('short answers remain confirmable and tool failures return repair context',()=>{
 const g=createGame();
 for(let i=0;i<6;i++){
  addSpeech(g,i===0?'就是':'嗯');
  const failed=mcpReply({id:i,method:'tools/call',params:{name:'self.test.evaluate',arguments:{question:i+1,revision:g.pending.revision-1,quote:'假的',feedback:'好'}}},g,i);
  const repair=JSON.parse(failed.result.content[0].text);assert.equal(repair.state.pending.text,i===0?'就是':'嗯');assert.ok(repair.instruction.includes('任何非空回答'));
  evaluate(g,i,{question:i+1,revision:g.pending.revision,quote:g.pending.text,feedback:'信息不足，可以补充或确认继续'});advance(g,g.pending.revision);
 }
 const r=report();r.dimensions=r.dimensions.map(d=>({...d,question:2,quote:'嗯',verdict:'证据不足',comment:'回答只有语气词，不能据此判断。'}));saveReport(g,6,JSON.stringify(r));assert.equal(g.report.dimensions[0].quote,'嗯');
});
