import { VoiceAudio } from './audio.js';

const app = document.querySelector('#app');
const error = document.querySelector('#error');
let game = null;
let voice = null;
let socket = null;
let connected = false;
let connecting = false;
let recording = false;
let speaking = false;
let note = '连接柜员后，按住按钮或空格说话。';
let latest = '';
let epoch = 0;
let requestBusy = false;
const esc = text => String(text).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);

function duck(stage = 0) {
  return `<svg class="duck" viewBox="0 0 300 300" aria-label="鸭子柜员" role="img"><path d="M64 300Q60 210 150 210Q240 210 236 300" fill="${['#e2e5c8','#b1bec8','#cbc1a9'][stage]}" stroke="#223d36" stroke-width="4"/><path d="M116 214l34 37 34-37M150 251v49" fill="none" stroke="#223d36" stroke-width="3"/><path d="M119 233l31 18-11 37-18-32M181 233l-31 18 11 37 18-32" fill="#547f65" stroke="#223d36" stroke-width="3"/><path d="M83 174Q66 149 81 117Q71 67 117 48Q159 17 207 58Q239 81 220 129Q241 166 212 198Q194 220 148 219Q100 220 83 174" fill="#fff9df" stroke="#223d36" stroke-width="4"/><path d="M107 109l24-5M174 103l23 8" fill="none" stroke="#223d36" stroke-width="5" stroke-linecap="round"/><ellipse class="pupil" cx="121" cy="125" rx="5" ry="8" fill="#223d36"/><ellipse class="pupil" cx="181" cy="125" rx="5" ry="8" fill="#223d36"/><path class="bill" d="M109 161Q126 139 156 146Q174 145 196 158Q201 175 173 183Q135 191 109 171Z" fill="#e8a152" stroke="#223d36" stroke-width="3"/><path d="M116 164q40 11 72-3" fill="none" stroke="#9b5d33" stroke-width="2"/>${stage === 1 ? '<rect x="99" y="113" width="45" height="31" rx="8" fill="none" stroke="#223d36" stroke-width="4"/><rect x="161" y="113" width="45" height="31" rx="8" fill="none" stroke="#223d36" stroke-width="4"/><path d="M144 123h17" stroke="#223d36" stroke-width="4"/>' : stage === 2 ? '<path d="M98 60q55-45 104 7l-8 22q-38-13-85-2Z" fill="#6c7360" stroke="#223d36" stroke-width="4"/><path d="M106 190q17 10 27-3M165 189q15 10 27-3" fill="none" stroke="#223d36" stroke-width="3"/>' : '<path d="M114 61q-24-39 13-35l23 22q16-38 37-17l-16 29" fill="#c45d35" stroke="#223d36" stroke-width="3"/>'}<rect x="183" y="259" width="39" height="22" rx="2" fill="#fffaf0" stroke="#223d36" stroke-width="2"/><path d="M189 267h24M189 274h13" stroke="#698073" stroke-width="2"/></svg>`;
}

function scene(stage = 0) {
  const names = ['取号窗口','材料审核','最终盖章']; const clerks = ['章小鸭','白主任','胡大爷'];
  return `<div class="scene ${speaking ? 'talking' : ''} ${recording ? 'listening' : ''}"><div class="scene-sign">0${stage + 1} / ${names[stage]}</div><div class="clock">16:57</div>${duck(stage)}<div class="counter-desk"><div><strong>${clerks[stage]}</strong><div class="desk-tag">HAPPINESS SERVICE CENTER</div></div><span class="desk-stamp">按规定办事</span></div></div>`;
}

function render() {
  const previousInput = app.querySelector('input[name="text"]');
  const draft = previousInput?.value;
  const restoreFocus = previousInput && document.activeElement === previousInput;
  const selection = restoreFocus ? [previousInput.selectionStart, previousInput.selectionEnd] : null;
  if (!game) {
    app.innerHTML = `<section class="intro"><div><div class="eyebrow">A VOICE GAME / 快乐生活办事大厅</div><h1>办个事，<br>怎么<span>这么难？</span></h1><p class="lead">你请了半天假，来领一张「快乐生活许可证」。<br>还有三个窗口，而他们马上就要下班了。<br>材料不齐、规定如此、明天再来——<br>能不能办成，全看你怎么说。</p><div class="intro-goal"><span>3 个难搞柜员</span><span>3 枚通关印章</span><span>用嘴闯关</span></div><button class="primary" id="start">取号，开始办事 <span>→</span></button><p class="note">先看你的材料，再开口和柜员聊。<br>真实对话由 Linx 驱动 · 无需输入私人信息</p></div><div>${scene()}<p class="intro-scene-caption">“没号条？那不行。<br>……你先别走，说说你有什么证明。”</p></div></section>`;
    return;
  }
  const c = game.counter;
  const ended = game.status !== 'playing';
  const last = game.history.filter(h => h.stage === game.stage).at(-1);
  app.innerHTML = `<div class="game-header"><div class="passport">${['取号章','材料章','办结章'].map((name,i) => `<span class="${game.stamps.includes(i) ? 'stamped' : ''}">${game.stamps.includes(i) ? '✓ ' : ''}${name}</span>`).join('')}</div><button class="link-button" id="restart">重新取号</button></div><section class="play-grid"><div class="left">${scene(game.stage)}<div class="progress-label"><span>柜员态度 / ${game.stamped ? '准予办理' : game.score < 40 ? '不太想办' : game.score < 75 ? '有点松动' : '快说动了'}</span><span>${game.score} / 100</span></div><div class="meter"><div class="meter-fill" id="meter"></div></div><p class="note">${esc(c.trait)} · 本窗限时 <span id="timer">${game.secondsLeft}</span> 秒</p>${last ? `<div class="reason">${last.delta >= 0 ? '+' : ''}${last.delta} · ${esc(last.reason)}</div>` : ''}</div><div class="right">${ended ? `<div class="result"><div class="eyebrow">${game.status === 'won' ? 'MISSION COMPLETE' : 'PLEASE TRY AGAIN'}</div><h2>${game.status === 'won' ? '恭喜，今天办成了。' : game.status === 'timeout' ? '下班了，明天请早。' : '柜员决定：不予办理。'}</h2>${game.status === 'won' ? '<div class="result-badge">快乐生活许可证 · 已批准</div>' : ''}<p>你拿到了 ${game.stamps.length} 枚章。${game.status === 'won' ? '这份快乐，是你靠口才争取来的。' : '换个说法，再给这个大厅一次机会。'}</p><button class="primary" id="again">再来办一件事 →</button></div>` : `<div class="task"><div class="eyebrow">WINDOW 0${game.stage + 1} / YOUR MISSION</div><h1 class="stage-title">${esc(c.objective)}</h1><p class="goal">${esc(c.brief)}</p><details open><summary>翻翻你的口袋 / 可用线索</summary><ul class="pocket">${c.pocket.map(item => `<li>${esc(item)}</li>`).join('')}</ul></details></div><div class="speech" aria-live="polite"><div class="speaker">${esc(c.clerk)} · ${speaking ? '正在说话' : '等你开口'}</div><p>${esc(latest || c.opening)}</p></div><div class="status" role="status">${esc(note)}</div><div class="controls">${game.stamped ? '<button class="primary" id="next">章拿到了，去下一窗口 →</button>' : connected ? `<button class="primary ${recording ? 'recording' : ''}" id="talk">${recording ? '正在听… 松开发送' : '按住说话 / 空格'}</button><button class="secondary" id="disconnect">挂断</button>` : `<button class="primary" id="connect" ${connecting ? 'disabled' : ''}>${connecting ? '正在连接柜员…' : '接通柜员 · 开启语音'}</button>`}</div>${connected && !game.stamped ? '<form class="text-form" id="text-form"><input name="text" aria-label="文字补充" placeholder="不方便说话？也可以打字，柜员仍会语音回答" maxlength="500" required><button type="submit">发送 ↗</button></form>' : ''}` }<details><summary>查看办事记录（${game.dialogue.length}）</summary><div class="transcript">${game.dialogue.map(d => `<p><b>${d.who === 'player' ? '你' : '柜员'}</b>　${esc(d.text)}</p>`).join('') || '<p>还没有对话，先向柜员说明来意。</p>'}</div></details></div></section>`;
  document.querySelector('#meter').style.width = `${game.score}%`;
  const nextInput = app.querySelector('input[name="text"]');
  if (nextInput && draft !== undefined) {
    nextInput.value = draft;
    if (restoreFocus) { nextInput.focus({preventScroll:true}); nextInput.setSelectionRange(...selection); }
  }
}

async function api(path) {
  const res = await fetch(path, { method: 'POST', signal: AbortSignal.timeout(20000) });
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
async function connect() {
  if (connecting || connected) return;
  hangup(); const generation = epoch; connecting = true; note = '正在授权麦克风并连接 Linx…'; render();
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
      if (message.type === 'hello') { connected = true; connecting = false; audio.rate = message.audio_params.sample_rate; note = '已接通 Linx。按住说话，松开发送。'; send({type:'opening'}); }
      if (message.type === 'game') { game = message.game; if (game.status !== 'playing' || game.stamped) { audio.record(false); audio.releaseMic(); recording = false; } }
      if (message.type === 'stt') note = `你说：${message.text}`;
      if (message.type === 'llm') note = '柜员正在想怎么回复你…';
      if (message.type === 'tts') {
        if (message.state === 'start') { speaking = true; latest = ''; }
        if (message.state === 'sentence_start') latest += message.text;
        if (message.state === 'stop') {
          speaking = false; if (message.is_aborted) audio.stop();
          if (game.stamped || game.status !== 'playing') setTimeout(() => { if (generation === epoch) { hangup(); note = '本窗口已结束，语音连接已释放。'; render(); } }, audio.remainingMs() + 100);
        }
      }
      if (message.type === 'error') showError(message.message);
      render();
    };
    ws.onclose = () => { if (generation !== epoch) return; hangup(); note = '连接已结束，可以重新接通。'; render(); };
    ws.onerror = () => showError('语音连接失败，请重新接通。');
  } catch (err) { if (generation === epoch) { hangup(); note = '尚未接通。'; showError(err.name === 'NotAllowedError' ? '需要允许麦克风才能语音办事；也可接通后使用文字补充。' : err.message); render(); } }
}
function record(active) {
  if (!connected || !game || game.status !== 'playing' || game.stamped || active === recording) return;
  recording = active;
  if (active) { voice.stop(); speaking = false; send({ type:'abort' }); send({type:'listen',state:'start'}); } else send({type:'listen',state:'stop'});
  voice.record(active); render();
}
async function change(path) {
  if (requestBusy) return; requestBusy = true; error.hidden = true;
  try { hangup(); const data = await api(path); game = data.game; latest = ''; note = '看完线索后，接通这个窗口的柜员。'; render(); }
  catch (err) { showError(err.message); } finally { requestBusy = false; }
}
app.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  if (['start','again'].includes(button.id)) await change('/api/game');
  if (button.id === 'restart' && confirm('重新取号会清空本局印章，确定吗？')) await change('/api/game');
  if (button.id === 'next') await change('/api/next');
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
app.addEventListener('submit', event => { if (event.target.id !== 'text-form') return; event.preventDefault(); const text = new FormData(event.target).get('text').trim(); if (!text) return; send({type:'abort'}); voice.stop(); send({type:'text',text}); event.target.reset(); note = '已发送，柜员正在回复…'; render(); });
setInterval(() => { if (!game || game.status !== 'playing' || !connected || game.stamped) return; const el = document.querySelector('#timer'); if (el && game.turn > 0) { game.secondsLeft = Math.max(0, game.secondsLeft - 1); el.textContent = game.secondsLeft; if (!game.secondsLeft) { hangup(); game.status = 'timeout'; render(); } } },1000);
try { const data = await (await fetch('/api/game', {signal:AbortSignal.timeout(5000)})).json(); game = data.game; render(); } catch { showError('本地服务尚未启动，请刷新重试。'); }
