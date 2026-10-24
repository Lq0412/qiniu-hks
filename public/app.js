import { VoiceAudio } from './audio.js';
const app=document.querySelector('#app'),error=document.querySelector('#error');
let game=null,voice=null,socket=null,connected=false,connecting=false,recording=false,speaking=false,note='接通测试员，然后按住说话。',latest='',epoch=0,requestBusy=false,feedbackIssue='';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function render(){
 const input=app.querySelector('input'),draft=input?.value,focused=input===document.activeElement;
 if(!game){app.innerHTML=`<section class="intro"><div><div class="eyebrow">HUMAN MODEL BENCHMARK / 生活版跑分</div><h1>你是什么<br><em>人类模型？</em></h1><p class="lead">老板一句“找你有事”，你的脑内已经开了八场发布会？<br>来，用六道生活题，测测你的日常推理到底有多离谱。</p><div class="facts">6 道生活题 · 自由语音回答 · 夯到拉</div><button class="primary" id="start">开始跑分 →</button><p class="note">不需要懂 AI。想到什么就说什么。<br>约 3–5 分钟，Linx 语音测试员陪你跑完整场。</p></div><div class="sample"><div class="sample-label">报告样例 / 实际结果由回答生成</div><h2>上下文没丢，<br>班味溢出了。</h2><div class="sample-model">Claude 型人类</div><div class="tier-stamp">顶级</div><p class="sample-quote">“建议你少写两段免责声明，<br>火锅店不会起诉你。”</p><div class="sample-foot">幻觉控制 / 上下文保持 / 指令遵循</div><p class="model-pool">GPT · Claude · Gemini · DeepSeek<br>通义千问 · Kimi · 豆包 · 4B 小模型</p></div></section>`;return;}
 const top=`<div class="topline"><span class="eyebrow">人类模型 / 本次测试</span><button class="link-button" id="restart">重新开始</button></div>`;
 if(game.status==='done'){
  const r=game.report;app.innerHTML=top+`<article class="report"><div class="report-hero"><div class="report-type">鉴定结果 / ${esc(r.model)} 型人类</div><div class="report-grade">${esc(r.tier)}</div><h1>${esc(r.headline)}</h1><p>${esc(r.summary)}</p></div><p class="roast">“${esc(r.roast)}”</p>${r.dimensions.map(d=>`<section class="dimension"><div><strong>${esc(d.name)}</strong><div class="verdict">${esc(d.verdict)}</div></div><div><p>${esc(d.comment)}</p><blockquote>Q${d.question} 原话：“${esc(d.quote)}”</blockquote></div></section>`).join('')}<p class="patch"><strong>下次升级建议</strong><br>${esc(r.advice)}</p><p class="note">型号代表回答风格，等级只评价本局。语音响应速度本版未评分。</p><div class="report-actions"><button class="primary" id="again">再跑一次 →</button><button class="secondary" id="print">保存 / 打印报告</button></div></article>`;
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
  try { hangup(); const data = await api(path, body); game = data.game; latest = ''; feedbackIssue = ''; note = '想好后，接通测试员开始回答。'; render(); }
  catch (err) { showError(err.message); } finally { requestBusy = false; }
}
app.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  if (['start','again'].includes(button.id)) await change('/api/game');
  if (button.id === 'restart' && confirm('重新开始会清空本次回答，确定吗？')) await change('/api/game');
  if (button.id === 'next') { await change('/api/next', {revision:game.pending.revision}); if (game.status === 'reporting') await connect(); }
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
