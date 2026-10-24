import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, addSpeech, review, advance, view, checkTime } from '../game.mjs';
import { mcpReply } from '../linx.mjs';

test('three counters require two meaningful reviews each, all stamps win', () => {
  const g = createGame();
  assert.equal(addSpeech(g, ''), false);
  for (let stage = 0; stage < 3; stage++) {
    addSpeech(g, '具体的合理建议'); review(g, stage, {turn:1,delta:25,reason:'有可核对的依据'});
    assert.equal(view(g).stamped, false);
    addSpeech(g, '进一步的可执行办法'); review(g, stage, {turn:2,delta:25,reason:'明确解决顾虑'});
    assert.equal(view(g).stamped, true);
    if (stage < 2) { advance(g); assert.equal(g.score,30); }
  }
  assert.equal(g.status,'won'); assert.equal(addSpeech(g,'更多话'),false); assert.throws(()=>advance(g));
});

test('reject invalid, stale, repeated and out-of-range evaluations', () => {
  const g = createGame(); assert.throws(()=>advance(g));
  assert.throws(()=>review(g,0,{turn:0,delta:25,reason:'bad'}));
  addSpeech(g,'你好');
  for (const args of [{turn:1,delta:100,reason:'bad'},{turn:1,delta:1.2,reason:'bad'},{turn:1,delta:25,reason:''},{turn:1,delta:25,reason:3}]) assert.throws(()=>review(g,0,args));
  assert.throws(()=>review(g,1,{turn:1,delta:25,reason:'旧窗'}));
  review(g,0,{turn:1,delta:25,reason:'有效'});
  assert.equal(review(g,0,{turn:1,delta:25,reason:'重试'}).duplicate,true); assert.equal(g.score,55);
  assert.throws(()=>review(g,0,{turn:2,delta:25,reason:'未来轮'}));
  addSpeech(g,'说明');review(g,0,{turn:2,delta:25,reason:'有效'});
  assert.equal(addSpeech(g,'已盖章'),false);
  addSpeech(g,'');
  g.turn=3;assert.throws(()=>review(g,0,{turn:3,delta:25,reason:'已盖章'}));
});

test('zero score, deadline, restart and detached views', () => {
  const g=createGame();for(let i=0;i<3;i++){addSpeech(g,'辱骂');review(g,0,{turn:g.turn,delta:-10,reason:'辱骂'});}assert.equal(g.status,'rejected');assert.throws(()=>review(g,0,{turn:3,delta:25,reason:'无效'}));
  const timed=createGame();checkTime(timed);addSpeech(timed,'开始',Date.now()-180001);checkTime(timed);assert.equal(view(timed).status,'timeout');
  const fresh=createGame();assert.notEqual(fresh.id,g.id);assert.equal(view(fresh).secondsLeft,180);
  const copy=view(fresh);copy.counter.name='changed';assert.notEqual(view(fresh).counter.name,'changed');
});

test('MCP initialize, discovery, status, review and errors', () => {
  const g=createGame();
  assert.equal(mcpReply({id:1,method:'initialize'},g,0).result.protocolVersion,'2024-11-05');
  assert.equal(mcpReply({id:2,method:'tools/list'},g,0).result.tools.length,2);
  assert.equal(mcpReply({id:3,method:'tools/call',params:{name:'self.game.status'}},g,0).result.isError,false);
  assert.equal(mcpReply({id:4,method:'tools/call',params:{name:'self.game.review'}},g,0).result.isError,true);
  addSpeech(g,'具体建议');
  assert.equal(mcpReply({id:5,method:'tools/call',params:{name:'self.game.review',arguments:{turn:1,delta:25,reason:'具体'}}},g,0).result.isError,false);
  assert.equal(mcpReply({id:6,method:'tools/call'},g,0).error.code,-32601);
  assert.equal(mcpReply({id:7,method:'bad'},g,0).error.code,-32601);
});
