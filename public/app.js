import { VoiceAudio } from './audio.js';
const app=document.querySelector('#app'),error=document.querySelector('#error');
let game=null,voice=null,socket=null,connected=false,connecting=false,recording=false,speaking=false,note='接通测试员，然后按住说话。',latest='',epoch=0,requestBusy=false,feedbackIssue='';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function render(){
 const input=app.querySelector('input'),draft=input?.value,focused=input===document.activeElement;
 if(!game){app.innerHTML=`<section class="intro"><div><div class="eyebrow">HUMAN MODEL BENCHMARK / 生活版跑分</div><h1>你是什么<br><em>人类模型？</em></h1><p class="lead">老板一句“找你有事”，你的脑内已经开了八场发布会？<br>来，用六道生活题，测测你的日常推理到底有多离谱。</p><div class="facts">6 道生活题 · 自由语音回答 · 夯到拉</div><button class="primary" id="start">开始跑分 →</button><p class="note">不需要懂 AI。想到什么就说什么。<br>约 3–5 分钟，Linx 语音测试员陪你跑完整场。</p></div><div class="sample"><div class="sample-label">报告样例 / 实际结果由回答生成</div><h2>上下文没丢，<br>班味溢出了。</h2><div class="sample-model">Claude 型人类</div><div class="tier-stamp">顶级</div><p class="sample-quote">“建议你少写两段免责声明，<br>火锅店不会起诉你。”</p><div class="sample-foot">幻觉控制 / 上下文保持 / 指令遵循</div><p class="model-pool">GPT · Claude · Gemini · DeepSeek<br>通义千问 · Kimi · 豆包 · 4B 小模型</p></div></section>`;return;}
 const top=`<div class="topline"><span class="eyebrow">人类模型 / 本次测试</span><button class="link-button" id="restart">重新开始</button></div>`;
 if(game.status==='done'){
  const r=game.report;const barKeys=['hallucination','context','instruction'];
  const cells=(filled,max)=>Array.from({length:max},(_,i)=>`<i class="${i<filled?'on':''}"></i>`).join('');
  const mk=ok=>`<i class="${ok?'hit':'miss'}">${ok?'✓':'✕'}</i>`;
  const specRows=[['上下文窗口',r.specs.contextWindow],['推理模式',r.specs.reasoning],['推荐部署',r.specs.deployBest],['暂缓部署',r.specs.deployWorst]];
  const L=r.ledger||{};
  const factCols=[['time','时间'],['place','地点'],['food','火锅'],['restriction','香菜']];
  const factRows=[['Q2 写入',L.q2],['Q4 改期',L.q4],['Q6 召回',L.q6]];
  const factTotal=factRows.reduce((s,[,f])=>s+factCols.filter(([k])=>f&&f[k]).length,0);
  const matrix=`<div class="audit-matrix"><div class="audit-row audit-head"><span class="audit-q">信息要素</span>${factCols.map(([,label])=>`<span>${label}</span>`).join('')}<span class="audit-c">覆盖</span></div>${factRows.map(([label,f])=>{const hits=factCols.filter(([k])=>f&&f[k]).length;return `<div class="audit-row"><span class="audit-q">${label}</span>${factCols.map(([k])=>`<span class="audit-cell">${mk(f&&f[k])}</span>`).join('')}<span class="audit-c">${hits}/4</span></div>`;}).join('')}</div>`;
  const checks=[
    ['Q1 未知地点',L.q1?.clarify?['主动澄清，没装懂',1]:L.q1?.assert?['把未知地点脑补成已知',0]:['没有澄清也没断言',0]],
    ['Q3 老板问起',L.q3?.assert?['把猜测当事实',0]:[`保留不确定 ${mk(!!L.q3?.hedged)} 主动核实 ${mk(!!L.q3?.verify)}`,2]],
    ['Q5 外卖+室友',L.q5?.violation?[`先沟通 ${mk(!!L.q5?.communicate)} 有方案 ${mk(!!L.q5?.plan)} 钥匙关门 ${mk(!!L.q5?.keys)} 敞门违规 ${mk(false)}`,0]:[`先沟通 ${mk(!!L.q5?.communicate)} 有方案 ${mk(!!L.q5?.plan)} 钥匙关门 ${mk(!!L.q5?.keys)} 没敞门 ${mk(true)}`,2]],
  ];
  const audit=`<section class="card-audit"><h2>事实核查 · 逐项覆盖</h2>${matrix}<div class="audit-total">信息保持覆盖率 <strong>${factTotal}/12</strong> · 写入 → 改期 → 召回，丢一项少一格</div><div class="audit-checks">${checks.map(([label,[txt,st]])=>`<div class="audit-line"><span class="audit-label">${label}</span><span class="audit-state st-${st}">${txt}</span></div>`).join('')}</div><p class="audit-note">每格由六题原话机器核对，测试员只写文案，不能改格。</p></section>`;
  app.innerHTML=top+`<article class="model-card"><div class="card-hero"><div class="card-id"><div class="eyebrow">鉴定结果 / HUMAN MODEL</div><div class="model-name">${esc(r.model)}<em>型人类</em></div><div class="model-variant">${esc(r.variant)}</div></div><div class="grade-stamp grade-${barKeys.map(k=>r.bars[k].score).reduce((a,b)=>a+b,0)}">${esc(r.tier)}</div></div><h1 class="card-headline">${esc(r.headline)}</h1><p class="card-summary">${esc(r.summary)}</p><section class="card-bars"><h2>本局跑分</h2>${r.dimensions.map((d,i)=>{const b=r.bars[barKeys[i]];return `<div class="bar-row"><div class="bar-meta"><strong>${esc(d.name)}</strong><span class="verdict">${esc(d.verdict)}</span></div><div class="bar-track">${cells(b.score,b.max)}<em>${b.score}/${b.max}${barKeys[i]==='context'?' · 约束保持':''}</em></div></div>`;}).join('')}</section>${audit}<p class="roast">“${esc(r.roast)}”</p><section class="card-specs"><h2>型号规格</h2><dl>${specRows.map(([label,value])=>`<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl></section><section class="card-evidence"><h2>跑分依据 · 原话为证</h2>${r.dimensions.map(d=>`<div class="dimension"><p>${esc(d.comment)}</p><blockquote>Q${d.question} 原话：“${esc(d.quote)}”</blockquote></div>`).join('')}</section><p class="patch"><strong>下次升级建议</strong><br>${esc(r.advice)}</p><p class="note">型号代表回答风格，等级只评价本局；格条由六题原话逐项核对生成。语音响应速度本版未评分。</p><div class="report-actions"><button class="primary" id="again">再跑一次 →</button><button class="secondary" id="print">保存 / 打印模型卡</button></div></article>`;
 }else if(game.status==='reporting'){
  app.innerHTML=top+`<section class="reporting"><div class="eyebrow">6 / 6 · 回答已确认</div><h1>正在编译<br>你的人类模型。</h1><p>测试员会从你的原话里找证据，然后给出型号和夯拉等级。</p><div class="loader"></div><p class="status">${esc(note)}</p><button class="primary" id="connect" ${connecting||connected?'disabled':''}>${connecting||connected?'报告生成中…':'生成我的模型卡 →'}</button><p class="note">通常需要十几秒。断线后可以重新生成，回答不会丢。</p><button class="link-button" id="disconnect">断开后重试</button></section>`;
 }else{
  const q=game.current;app.innerHTML=top+`<div class="steps">${Array.from({length:6},(_,i)=>`<i class="${i<game.stage?'done':i===game.stage?'active':''}"></i>`).join('')}</div><section class="question-layout"><div class="question"><div class="eyebrow">QUESTION 0${game.stage+1} / ${esc(q.tag)}</div><h1>${esc(q.title)}</h1><p class="lead">${esc(q.text)}</p><p class="note">${esc(q.hint)}</p><div class="examiner"><span class="badge">LINX 测试员</span><p>${esc(latest||'准备好了就开口，没有选项，也不用写标准答案。')}</p></div><div class="controls">${connected?`<button class="primary ${recording?'recording':''}" id="talk">${recording?'正在听… 松开发送':'按住说话 / 空格'}</button><button class="secondary" id="disconnect">挂断</button>`:`<button class="primary" id="connect" ${connecting?'disabled':''}>${connecting?'正在连接…':'接通测试员 →'}</button>`}</div><p class="status" role="status">${esc(note)}</p>${connected?'<form class="input-form" id="text-form"><input name="text" aria-label="文字回答" placeholder="也可以输入回答" maxlength="500" required><button>发送 ↗</button></form>':''}</div><aside class="aside"><h2>本题回答</h2>${game.pending?`<div class="answer"><div class="answer-label">语音转写 / 可以重答</div><p>${esc(game.pending.text)}</p></div><p class="feedback">${esc(game.feedback?.text||feedbackIssue||'测试员正在看你的回答…')}</p>${game.feedback?'<button class="primary confirm" id="next">确认，'+(game.stage===5?'生成报告':'下一题')+' →</button>':'<button class="secondary" id="retry-feedback">重试反馈</button>'}`:'<p>你的回答会出现在这里。确认转写无误后，再进入下一题。</p>'}<p class="note">只评价本次回答。放心玩梗，不需要提供真实姓名或隐私。</p></aside></section>`;
 }
 const next=app.querySelector('input');if(next&&draft!==undefined){next.value=draft;if(focused)next.focus();}
}
app.addEventListener('click',e=>{if(e.target.closest('#print'))window.print();});
async function api(path, body) {
  const res = await fetch(path, { method: 'POST', headers: {'Content-Type':'application/json'}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}
function showError(message) { error.textContent = message; error.hidden = false; }
function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function hangup() {
  epoch++; connected = false; connecting = false; recording = false; speaking = false;
  voice?.close(); voice = null; socket?.close(); socket = null;
}
async function connect(retry = false) {
  if (connecting || connected) return;
  const retryText = retry ? game.pending?.text : null; hangup(); const generation = epoch; connecting = true; note = '正在授权麦克风并连接 Linx…'; render();
  const audio = new VoiceAudio(); voice = audio;
  try {
    await audio.init(packet => { if (recording && socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 100000) socket.send(packet); });
    const data = await api('/api/connect');
    if (generation !== epoch) { audio.close(); return; }
    const ws = new WebSocket(`ws://${location.host}/voice?ticket=${data.ticket}`); socket = ws; ws.binaryType = 'arraybuffer';
    ws.onmessage = event => {
      if (generation !== epoch) return;
      if (event.data instanceof ArrayBuffer) { if (!recording) audio.play(event.data); return; }
      const message = JSON.parse(event.data);
      if (message.type === 'hello') { connected = true; connecting = false; audio.rate = message.audio_params.sample_rate; note = '已接通 Linx。按住说话，松开发送。'; send(retryText ? {type:'text',text:retryText} : {type:'opening'}); }
      if (message.type === 'game') { game = message.game; if (game.feedback || game.status === 'done') { error.hidden = true; feedbackIssue = ''; if(game.feedback) note = '反馈已保存，可以确认下一题，也可以重答。'; } if (game.status === 'done') { audio.record(false); audio.releaseMic(); recording = false; } }
      if (message.type === 'stt') feedbackIssue = '';
      if (message.type === 'stt') note = `你说：${message.text}`;
      if (message.type === 'llm') note = '测试员正在整理你的回答…';
      if (message.type === 'tts') {
        if (message.state === 'start') { speaking = true; latest = ''; }
        if (message.state === 'sentence_start') latest += message.text;
        if (message.state === 'stop') {
          speaking = false; if(game.feedback) note = '反馈已保存，可以确认下一题，也可以重答。'; if(game.pending && !game.feedback) feedbackIssue = '还没有保存反馈，可以补充回答，或点击重试反馈。'; if (message.is_aborted) audio.stop();
          if (game.status === 'done') setTimeout(() => { if (generation === epoch) { hangup(); note = '测评已结束，语音连接已释放。'; render(); } }, audio.remainingMs() + 100);
        }
      }
      if (message.type === 'feedback_error') { feedbackIssue = message.message; note = message.message; }
      if (message.type === 'error') showError(message.message);
      render();
    };
    ws.onclose = () => { if (generation !== epoch) return; hangup(); note = '连接已结束，可以重新接通。'; render(); };
    ws.onerror = () => showError('语音连接失败，请重新接通。');
  } catch (err) { if (generation === epoch) { hangup(); note = '尚未接通。'; showError(err.name === 'NotAllowedError' ? '需要允许麦克风才能语音作答；也可接通后使用文字补充。' : err.message); render(); } }
}
function record(active) {
  if (!connected || !game || game.status !== 'playing' || active === recording) return;
  recording = active;
  if (active) { voice.stop(); speaking = false; send({ type:'abort' }); send({type:'listen',state:'start'}); } else send({type:'listen',state:'stop'});
  voice.record(active); render();
}
async function change(path, body) {
  if (requestBusy) return; requestBusy = true; error.hidden = true;
  try { hangup(); const data = await api(path, body); game = data.game; latest = ''; feedbackIssue = ''; note = '想好后，接通测试员开始回答。'; render(); return true; }
  catch (err) { showError(err.message); return false; } finally { requestBusy = false; }
}
app.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  if (['start','again'].includes(button.id)) await change('/api/game');
  if (button.id === 'restart' && confirm('重新开始会清空本次回答，确定吗？')) await change('/api/game');
  if (button.id === 'next') {
    const continueVoice = connected || connecting;
    const advanced = await change('/api/next', {revision:game.pending.revision});
    if (advanced && (continueVoice || game.status === 'reporting')) await connect();
  }
  if (button.id === 'retry-feedback') { hangup(); feedbackIssue = ''; await connect(true); }
  if (button.id === 'connect') { error.hidden = true; await connect(); }
  if (button.id === 'disconnect') { hangup(); note = '已挂断。'; render(); }
});
app.addEventListener('pointerdown', event => { if (event.target.closest('#talk')) { event.preventDefault(); record(true); } });
window.addEventListener('pointerup', () => record(false));
window.addEventListener('pointercancel', () => record(false));
window.addEventListener('keydown', event => { if (event.code === 'Space' && (!['INPUT','TEXTAREA','BUTTON','SUMMARY'].includes(document.activeElement.tagName) || document.activeElement.id === 'talk')) { event.preventDefault(); if (!event.repeat) record(true); } });
window.addEventListener('keyup', event => { if (event.code === 'Space') record(false); });
window.addEventListener('blur', () => record(false));
window.addEventListener('beforeunload', hangup);
app.addEventListener('submit', event => { if (event.target.id !== 'text-form') return; event.preventDefault(); const text = new FormData(event.target).get('text').trim(); if (!text) return; send({type:'abort'}); voice.stop(); send({type:'text',text}); event.target.reset(); note = '已发送，测试员正在回复…'; render(); });

try { const data = await (await fetch('/api/game', {signal:AbortSignal.timeout(5000)})).json(); game = data.game; render(); } catch { showError('本地服务尚未启动，请刷新重试。'); }
