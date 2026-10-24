// 文字局界面。自动推进只用 autoIntent（有 cue 先停一下再 step，否则 tick）。
// 玩家按钮走 hint / text / confirm / vote / interrupt，顺序和 logic.js 的 orchestrate 一致。
// 揭晓前只保留 sanitizeView 放过的字段，不在本地补票、不算人味分。

import {
  AI_CHIPS,
  CAST,
  DIFFICULTIES,
  HOST_NAME,
  SCENES,
  THINK_MS,
  autoIntent,
  ballotCards,
  caughtQuote,
  clipUrl,
  createBody,
  dockMode,
  friendlyError,
  phaseLabel,
  randomAlias,
  randomSeed,
  remainingMs,
  sanitizeView,
  screenOf,
  sessionRecord,
  shareCardModel,
  paintShareCard,
  speakingSeat,
  subtitleModel,
  tableSeats,
  topicModel,
} from './logic.js';
import { play, playThinking, stop, stopHoldToTalk, stopThinking, startHoldToTalk } from './audio.js';

const app = document.querySelector('#app');
const toastEl = document.querySelector('#toast');
const STORE = 'mixin-ui';
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const readScale = reduced ? 0.15 : 1;
const thinkMs = reduced ? 0 : THINK_MS;

const state = {
  sessionId: null,
  clock: 0,
  syncedAt: 0,
  game: null,
  screen: '',
  dealtKey: '',
  thinking: false,
  holdRead: false,
  previousKind: '',
  previousText: '',
  alias: '碳基-7B',
  sceneId: 'annual',
  difficulty: 'normal',
  draft: '',
  holding: false,
  loopId: 0,
  wake: null,
  chain: Promise.resolve(),
  toastTimer: 0,
  starting: false,
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function difficultyName(id) {
  return DIFFICULTIES.find(item => item.id === id)?.name ?? id ?? '';
}

function dealKey() {
  return `${state.sceneId}|${state.difficulty}|${state.alias.trim()}`;
}

function enqueue(fn) {
  const run = state.chain.then(fn, fn);
  state.chain = run.then(() => {}, () => {});
  return run;
}

function persist() {
  if (!state.sessionId) return;
  sessionStorage.setItem(STORE, JSON.stringify(sessionRecord(state.sessionId, state.clock)));
}

function clearStored() {
  state.sessionId = null;
  state.clock = 0;
  state.game = null;
  state.dealtKey = '';
  sessionStorage.removeItem(STORE);
}

function readStored() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORE) || 'null');
    if (!parsed || typeof parsed.sessionId !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function toast(message) {
  if (!toastEl) return;
  toastEl.textContent = message || '';
  toastEl.hidden = !message;
  clearTimeout(state.toastTimer);
  if (message) state.toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4600);
}

function adopt(game, { clockDelta = 0 } = {}) {
  state.clock += clockDelta;
  state.syncedAt = performance.now();
  const next = sanitizeView(game);
  const last = next?.dialogue?.at(-1);
  if (last) {
    state.previousKind = last.kind;
    state.previousText = last.text;
  }
  state.game = next;
  if (next?.phase === 'lobby') {
    state.sceneId = next.scene?.id || state.sceneId;
    state.difficulty = next.difficulty || state.difficulty;
    state.alias = next.playerAlias || state.alias;
    state.dealtKey = dealKey();
  }
  persist();
  render();
}

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) {
    const error = new Error(friendlyError(response.status, payload));
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function call(action, body, options) {
  const cue = state.game?.cue;
  const payload = await request(`/api/mixin/${state.sessionId}/${action}`, { method: 'POST', body });
  adopt(payload.game, options);
  const url = clipUrl(payload);
  if (url) {
    await play(url, {
      seat: cue?.seat ?? null,
      roleId: cue?.roleId ?? null,
      voiceId: payload.game?.cue?.voice?.voiceId ?? null,
    });
  }
  return payload;
}

function fail(error) {
  if (error?.payload?.game) adopt(error.payload.game);
  toast(error?.message || '出了点问题。请再试一次。');
}

function pause(ms) {
  if (ms <= 0) return Promise.resolve('time');
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      state.wake = null;
      resolve('time');
    }, ms);
    state.wake = () => {
      clearTimeout(timer);
      state.wake = null;
      resolve('wake');
    };
  });
}

function kick() {
  const id = ++state.loopId;
  state.wake?.();
  runLoop(id);
}

async function runLoop(id) {
  while (id === state.loopId) {
    const intent = autoIntent(state.game, {
      holdRead: state.holdRead,
      readScale,
      previousKind: state.previousKind,
      previousText: state.previousText,
    });
    if (intent.action === 'idle') return;
    const waited = await pause(intent.delay);
    if (id !== state.loopId || waited === 'wake') return;
    try {
      if (intent.action === 'step') {
        if (!state.game?.cue) continue;
        state.thinking = true;
        state.holdRead = false;
        playThinking();
        render();
        const thought = await pause(thinkMs);
        stopThinking();
        if (id !== state.loopId || thought === 'wake') {
          state.thinking = false;
          render();
          return;
        }
        await enqueue(async () => {
          if (id !== state.loopId || !state.game?.cue) return;
          await call('step', {});
          state.thinking = false;
          state.holdRead = true;
          render();
        });
      } else {
        await enqueue(async () => {
          if (id !== state.loopId || state.game?.cue) return;
          if (!state.game || ['lobby', 'result', 'error'].includes(state.game.phase)) return;
          await call('tick', { ms: intent.ms }, { clockDelta: intent.ms });
        });
      }
    } catch (error) {
      state.thinking = false;
      stopThinking();
      stop();
      fail(error);
      if (error?.payload?.game && state.game && !['lobby', 'result', 'error'].includes(state.game.phase)) kick();
      return;
    }
  }
}

async function userAction(fn) {
  state.loopId += 1;
  state.wake?.();
  state.thinking = false;
  stopThinking();
  try {
    await enqueue(fn);
  } catch (error) {
    fail(error);
  }
  kick();
}

async function begin() {
  if (state.starting) return;
  state.starting = true;
  try {
    const sameDeal = state.sessionId && state.game?.phase === 'lobby' && state.dealtKey === dealKey();
    if (!sameDeal) {
      const created = await request('/api/mixin', {
        method: 'POST',
        body: createBody({
          sceneId: state.sceneId,
          difficulty: state.difficulty,
          alias: state.alias,
          seed: randomSeed(),
        }),
      });
      state.sessionId = created.id;
      state.clock = 0;
      state.holdRead = false;
      state.previousKind = '';
      state.previousText = '';
      state.draft = '';
      adopt(created.game);
    }
    await enqueue(() => call('start', {}));
    state.holdRead = false;
    kick();
  } catch (error) {
    fail(error);
  } finally {
    state.starting = false;
  }
}

async function submitLine() {
  const text = state.draft.trim();
  await userAction(async () => {
    const pending = state.game?.pending;
    if (pending && pending.text === text) {
      await call('confirm', { revision: pending.revision });
      state.draft = '';
      state.holdRead = true;
      return;
    }
    if (!text) return;
    const said = await call('text', { text, typed: true });
    if (said.accepted === false) {
      toast(state.game?.note || '这句没记上。');
      return;
    }
    if (state.game?.pending) {
      await call('confirm', { revision: state.game.pending.revision });
      state.draft = '';
      state.holdRead = true;
    }
  });
}

async function askHint() {
  await userAction(async () => { await call('hint', {}); });
}

async function interrupt() {
  const text = state.draft.trim();
  if ([...text].length < 2) {
    toast('插嘴至少说两个字。');
    return;
  }
  await userAction(async () => {
    const hit = await call('interrupt', { text });
    if (hit.accepted === false) {
      toast(state.game?.note || '这句没插进去。');
      return;
    }
    state.draft = '';
    state.holdRead = true;
  });
}

async function vote(seat) {
  await userAction(async () => { await call('vote', { seat }); });
}

async function finishCue() {
  if (state.game?.phase === 'reveal' && state.game.cue) {
    state.thinking = false;
    stopThinking();
    await call('step', {});
  }
}

async function again() {
  await userAction(async () => {
    await finishCue();
    if (state.game?.phase !== 'result') return;
    await call('restart', {});
    await call('start', {});
    state.holdRead = false;
    state.draft = '';
  });
}

async function backToLobby() {
  await userAction(async () => {
    await finishCue();
    if (state.game?.phase === 'result') await call('restart', {});
    stop();
  });
}

function insertChip(text) {
  const gap = state.draft && !state.draft.endsWith(' ') ? ' ' : '';
  state.draft = `${state.draft}${gap}${text}`.slice(0, 500);
  const input = document.querySelector('#line');
  if (input) {
    input.value = state.draft;
    input.focus();
  }
}

function releaseHold() {
  if (!state.holding) return;
  state.holding = false;
  document.querySelector('#hold')?.classList.remove('holding');
  stopHoldToTalk();
}

function render() {
  const screen = state.game ? screenOf(state.game) : 'lobby';
  if (screen !== state.screen) {
    state.screen = screen;
    app.innerHTML = screen === 'lobby' ? lobbyHtml() : screen === 'table' ? tableHtml() : screen === 'reveal' ? revealHtml() : errorHtml();
  }
  if (screen === 'table') paintTable();
  if (screen === 'reveal') paintReveal();
  if (screen === 'error') paintError();
}

function lobbyHtml() {
  const names = CAST.map(item => item.name).join('、');
  return `<main class="lobby">
    <section class="pitch">
      <p class="eyebrow">MODEL GROUP · LIVE</p>
      <h1>谁是人类</h1>
      <p class="tagline">一桌 AI，只有你是人。</p>
      <ul class="rules">
        <li>你是 <strong>5 号模型</strong>。群主发话题卡，四位 AI 先答，你最后说。</li>
        <li>装得像模型，就别被投票揪出来。</li>
        <li>这一局是文字模式，不连接灵矽，也不申请麦克风。</li>
      </ul>
      <p class="cast-line">${esc(names)}</p>
    </section>
    <form class="setup" id="setup">
      <fieldset>
        <legend>场景</legend>
        <div class="scenes">
          ${SCENES.map(scene => `<label class="scene"><input type="radio" name="scene" value="${esc(scene.id)}" ${scene.id === state.sceneId ? 'checked' : ''}><span><strong>${esc(scene.name)}</strong><small>${esc(scene.blurb)}</small></span></label>`).join('')}
        </div>
      </fieldset>
      <fieldset>
        <legend>难度</legend>
        <div class="diffs">
          ${DIFFICULTIES.map(item => `<label class="diff"><input type="radio" name="difficulty" value="${esc(item.id)}" ${item.id === state.difficulty ? 'checked' : ''}><strong>${esc(item.name)}</strong></label>`).join('')}
        </div>
      </fieldset>
      <fieldset>
        <legend>化名</legend>
        <div class="alias-row">
          <input id="alias" name="alias" maxlength="12" autocomplete="off" aria-label="化名" value="${esc(state.alias)}">
          <button class="ghost" type="button" id="random">随机</button>
        </div>
      </fieldset>
      <button class="primary big" type="submit" id="start">开始本局</button>
      <p class="fine">开局会创建一局并立刻开始。刷新后按本机 cookie 回到当前进度。</p>
    </form>
  </main>`;
}

function tableHtml() {
  return `<main class="table-screen">
    <header class="top">
      <div class="brand">谁是人类<small>TEXT MODE</small></div>
      <div class="phase" id="phase"></div>
      <div class="live"><i></i>REC · ${esc(difficultyName(state.game?.difficulty))}</div>
    </header>
    <div class="host" id="host"></div>
    <div class="seats" id="seats"></div>
    <section class="topic" id="topic"></section>
    <section class="lower" aria-live="polite">
      <p class="who" id="who"></p>
      <p class="subtitle" id="subtitle"></p>
      <ol class="ballots" id="ballots"></ol>
    </section>
    <section class="dock" id="dock"></section>
  </main>`;
}

function revealHtml() {
  return `<main class="reveal-screen">
    <p class="eyebrow">揭晓 · ${esc(HOST_NAME)}</p>
    <p class="outcome" id="outcome"></p>
    <h1 id="card-title"></h1>
    <div class="score-row"><strong id="human"></strong><span id="ai-score"></span></div>
    <blockquote class="quote" id="quote"></blockquote>
    <p class="ending" id="ending"></p>
    <p class="roast" id="roast"></p>
    <p class="meta-line" id="meta"></p>
    <ol class="ballots" id="ballots"></ol>
    <div class="actions">
      <button class="primary" type="button" id="again">再来一局</button>
      <button class="ghost" type="button" id="share">下载分享卡</button>
      <button class="ghost" type="button" id="back">返回开局</button>
    </div>
    <canvas id="card" width="1080" height="1440" hidden></canvas>
  </main>`;
}

function errorHtml() {
  return `<main class="error-screen">
    <p class="eyebrow">连接中断</p>
    <h1>这局还在。</h1>
    <p id="error-copy"></p>
    <div class="actions">
      <button class="primary" type="button" id="reload">重新读取</button>
      <button class="ghost" type="button" id="abandon">回开局</button>
    </div>
  </main>`;
}

function paintTable() {
  const game = state.game;
  const phase = document.querySelector('#phase');
  if (phase) phase.textContent = phaseLabel(game);
  const live = document.querySelector('.live');
  if (live) live.innerHTML = `<i></i>REC · ${esc(difficultyName(game.difficulty))}`;
  paintHost();
  paintSeats();
  paintTopic();
  paintSubtitle();
  paintBallots(document.querySelector('#ballots'));
  paintDock();
}

function paintHost() {
  const el = document.querySelector('#host');
  if (!el || !state.game) return;
  el.classList.toggle('speaking', speakingSeat(state.game, { thinking: state.thinking }) === 0);
  const html = `<span><i></i><b>${esc(HOST_NAME)}</b>主持 · 不投票</span><span>${esc(state.game.scene?.name || '')} · ${esc(state.game.playerAlias || '')}</span>`;
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
}

function paintSeats() {
  const el = document.querySelector('#seats');
  if (!el) return;
  const seats = tableSeats(state.game, { thinking: state.thinking });
  const html = seats.map(seat => `<article class="seat role-${esc(seat.roleId)} ${seat.speaking ? 'speaking' : ''} ${seat.you ? 'you' : ''}" ${seat.speaking ? 'aria-current="true"' : ''}>
    <span class="seat-no">${seat.you ? '05 你' : `0${seat.seat}`}</span>
    <strong>${esc(seat.name)}</strong>
    <em>${seat.you ? '装成模型' : '模型'}</em>
  </article>`).join('');
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
}

function paintTopic() {
  const el = document.querySelector('#topic');
  if (!el) return;
  const topic = topicModel(state.game);
  if (!topic) return;
  const title = topic.upcoming ? '开场。五个模型里，混进了一个人类。' : topic.prompt;
  const meta = topic.upcoming ? `${topic.scene} · ${topic.background}` : `${topic.scene} · 第 ${topic.round} / 2 轮 · ${topic.background}`;
  const html = `<p class="meta">${esc(meta)}</p><h2>${esc(title)}</h2>`;
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
}

function paintSubtitle() {
  const model = subtitleModel(state.game, { thinking: state.thinking });
  const who = document.querySelector('#who');
  const line = document.querySelector('#subtitle');
  if (!who || !line) return;
  who.textContent = model.name || '';
  if (line.dataset.text !== model.text || line.dataset.size !== model.size) {
    line.dataset.text = model.text;
    line.dataset.size = model.size;
    line.textContent = model.text;
    line.className = `subtitle ${model.size}${model.thinking ? ' thinking' : ''}`;
  }
}

function paintBallots(el) {
  if (!el) return;
  const cards = ballotCards(state.game);
  const html = cards.map((card, index) => `<li class="${index === cards.length - 1 ? 'fresh' : ''}">${esc(card.name)} → ${esc(card.targetName)}</li>`).join('');
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
}

function paintDock() {
  const el = document.querySelector('#dock');
  if (!el || !state.game) return;
  const mode = dockMode(state.game);
  if (el.dataset.mode !== mode) {
    el.dataset.mode = mode;
    el.innerHTML = dockHtml(mode);
    const input = el.querySelector('#line');
    if (input) {
      input.value = state.draft;
      input.focus();
    }
  }
  const note = el.querySelector('#note');
  if (note) note.textContent = state.game.note || '';
  const example = el.querySelector('#example');
  if (example) {
    example.hidden = !state.game.example;
    example.textContent = state.game.example ? `灵感：${state.game.example}` : '';
  }
  for (const button of el.querySelectorAll('[data-vote]')) {
    button.classList.toggle('selected', Number(button.dataset.vote) === state.game.playerVote);
  }
  const mine = el.querySelector('#mine');
  if (mine) mine.textContent = state.game.playerVote ? `你投了 ${state.game.playerVote} 号` : '你还没投票';
}

function dockHtml(mode) {
  if (mode === 'speak') return `${dockClock('秒后自动跳过')}${chipsHtml()}${exampleHtml()}${lineForm('像模型一样回答这张卡', '确认')}${toolRow(true)}<p class="fine">按住说话留给语音版。文字局请打字，松开不会录音。</p>`;
  if (mode === 'defense') return `${dockClock('秒后进入投票')}${voteRow()}${exampleHtml()}${lineForm('甩一句锅，或只投票', '确认')}${toolRow(false)}`;
  if (mode === 'interrupt') return `${dockClock('')}${lineForm('打断这句，替自己辩一下', '打断')}${toolRow(false)}`;
  if (mode === 'vote') return `${dockClock('秒后开始念票')}<p class="note" id="note"></p>${voteRow()}`;
  if (mode === 'ballots') return `<div class="dock-head"><p class="note" id="note"></p><p class="fine" id="mine"></p></div>`;
  return `<div class="dock-head"><p class="note" id="note"></p></div>`;
}

function dockClock(label) {
  return `<div class="dock-head"><p class="note" id="note"></p><div class="count"><span id="count">–</span><small>${esc(label)}</small></div></div>`;
}

function chipsHtml() {
  return `<div class="chips">${AI_CHIPS.map(chip => `<button type="button" data-chip="${esc(chip)}">${esc(chip)}</button>`).join('')}</div>`;
}

function exampleHtml() {
  return `<p class="example" id="example" hidden></p>`;
}

function lineForm(placeholder, action) {
  const interrupt = action === '打断';
  return `<form class="line" id="line-form"><input id="line" maxlength="500" autocomplete="off" aria-label="${esc(placeholder)}" placeholder="${esc(placeholder)}"><button class="primary" type="submit" id="${interrupt ? 'interrupt' : 'send'}">${esc(action)}</button></form>`;
}

function toolRow(hint) {
  return `<div class="row">${hint ? '<button class="ghost" type="button" id="hint">给我灵感</button>' : ''}<button class="hold ghost" type="button" id="hold">按住说话</button></div>`;
}

function voteRow() {
  const seats = state.game?.seats ?? [];
  return `<div class="votes">${seats.map(seat => `<button type="button" class="seat-vote" data-vote="${seat.seat}">投 ${esc(seat.name)}</button>`).join('')}</div>`;
}

function paintReveal() {
  const game = state.game;
  const report = game?.report;
  const outcome = document.querySelector('#outcome');
  if (outcome) {
    outcome.textContent = report?.outcome || '正在揭晓';
    outcome.className = `outcome ${report?.outcome === '潜伏成功' ? 'good' : 'bad'}`;
  }
  const title = document.querySelector('#card-title');
  if (title) title.textContent = report?.title || '……';
  const human = document.querySelector('#human');
  if (human) human.textContent = report?.humanScore == null ? '—' : String(report.humanScore);
  const ai = document.querySelector('#ai-score');
  if (ai) ai.textContent = report?.aiScore == null ? '' : `AI 味 ${report.aiScore}`;
  const quote = caughtQuote(report);
  const quoteEl = document.querySelector('#quote');
  if (quoteEl) quoteEl.innerHTML = `<small>${esc(quote.label || '金句')}</small>${esc(quote.text || '……')}`;
  const ending = document.querySelector('#ending');
  if (ending) ending.textContent = report?.endingText || '';
  const roast = document.querySelector('#roast');
  if (roast) roast.textContent = report?.roast || '';
  const meta = document.querySelector('#meta');
  if (meta) {
    const stats = report?.stats;
    const bits = [report?.alias, report?.scene, report?.votes ? `得票 ${report.votes}` : ''];
    if (stats) bits.push(`卡壳 ${stats.stalls} · 提示 ${stats.hints} · 插嘴 ${stats.interrupts}`);
    meta.textContent = bits.filter(Boolean).join(' · ');
  }
  paintBallots(document.querySelector('#ballots'));
}

function paintError() {
  const el = document.querySelector('#error-copy');
  if (el) el.textContent = state.game?.error || state.game?.note || '刷新可以按原进度继续。';
}

function downloadCard() {
  const model = shareCardModel(state.game);
  const canvas = document.querySelector('#card');
  if (!model || !canvas) return;
  paintShareCard(canvas.getContext('2d'), model);
  canvas.toBlob(blob => {
    if (!blob) return;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `谁是人类-${model.title || '分享卡'}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1500);
  }, 'image/png');
}

async function reloadView() {
  if (!state.sessionId) {
    clearStored();
    state.screen = '';
    render();
    return;
  }
  try {
    const payload = await request(`/api/mixin/${state.sessionId}`);
    adopt(payload.game);
    kick();
  } catch (error) {
    toast(error.message);
  }
}

app.addEventListener('submit', event => {
  event.preventDefault();
  if (event.target.id === 'setup') begin();
  if (event.target.id === 'line-form') {
    if (document.querySelector('#interrupt')) interrupt();
    else submitLine();
  }
});

app.addEventListener('click', event => {
  const chip = event.target.closest('[data-chip]');
  if (chip) insertChip(chip.dataset.chip);
  const seat = event.target.closest('[data-vote]');
  if (seat) vote(Number(seat.dataset.vote));
  const button = event.target.closest('button');
  if (!button) return;
  if (button.id === 'random') {
    state.alias = randomAlias();
    const input = document.querySelector('#alias');
    if (input) input.value = state.alias;
  }
  if (button.id === 'hint') askHint();
  if (button.id === 'again') again();
  if (button.id === 'share') downloadCard();
  if (button.id === 'back') backToLobby();
  if (button.id === 'reload') reloadView();
  if (button.id === 'abandon') {
    stop();
    clearStored();
    state.screen = '';
    render();
  }
});

app.addEventListener('input', event => {
  if (event.target.id === 'alias') state.alias = event.target.value;
  if (event.target.id === 'line') state.draft = event.target.value;
});

app.addEventListener('change', event => {
  if (event.target.name === 'scene') state.sceneId = event.target.value;
  if (event.target.name === 'difficulty') state.difficulty = event.target.value;
});

app.addEventListener('pointerdown', event => {
  const button = event.target.closest('#hold');
  if (!button) return;
  event.preventDefault();
  state.holding = true;
  button.classList.add('holding');
  startHoldToTalk({
    onError(error) { toast(error.message || '录音没有开始。'); },
  }).catch(error => toast(error.message || '录音没有开始。'));
});

window.addEventListener('pointerup', releaseHold);
window.addEventListener('pointercancel', releaseHold);

setInterval(() => {
  const el = document.querySelector('#count');
  if (!el || !state.game) return;
  const ms = remainingMs(state.game.deadlineAt, state.clock, Math.round(performance.now() - state.syncedAt));
  el.textContent = ms == null ? '–' : String(Math.ceil(ms / 1000));
}, 200);

async function boot() {
  const saved = readStored();
  if (!saved) {
    render();
    return;
  }
  state.sessionId = saved.sessionId;
  state.clock = Number.isInteger(saved.clock) ? saved.clock : 0;
  try {
    const payload = await request(`/api/mixin/${saved.sessionId}`);
    adopt(payload.game);
    if (!['lobby', 'result'].includes(state.game?.phase)) kick();
  } catch (error) {
    clearStored();
    toast(error.message);
    state.screen = '';
    render();
  }
}

boot();
