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
  characterOf,
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
  speechPlay,
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
  sending: false,
  faults: 0,
  mismatch: false,
  loopId: 0,
  wake: null,
  chain: Promise.resolve(),
  toastTimer: 0,
  starting: false,
  scale: 1,
  wallKey: '',
  lastPhase: '',
  voteFx: null,
  revealKey: '',
  logOpen: false,
  timerKey: null,
  timerTotal: 0,
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
  state.mismatch = false;
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
  state.faults = 0;
  adopt(payload.game, options);
  const url = clipUrl(payload);
  if (url) await play(url, speechPlay(cue));
  return payload;
}

function fail(error) {
  if (error?.payload?.game) adopt(error.payload.game);
  state.mismatch = error?.status === 409 && String(error?.message || '').includes('对不上');
  toast(error?.message || '出了点问题。请再试一次。');
  if (state.mismatch) render();
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
      const retry = error?.payload?.game && state.game && !['lobby', 'result', 'error'].includes(state.game.phase);
      if (!retry) return;
      state.faults += 1;
      if (state.faults > 4) return;
      const waited = await pause(Math.min(4000, 500 * state.faults));
      if (id !== state.loopId || waited === 'wake') return;
      kick();
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
  if (state.sending) return;
  state.sending = true;
  const send = document.querySelector('#send');
  if (send) send.disabled = true;
  const text = state.draft.trim();
  try {
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
  } finally {
    state.sending = false;
    const again = document.querySelector('#send');
    if (again) again.disabled = false;
  }
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
  await userAction(async () => {
    const result = await call('vote', { seat });
    if (result.accepted === false) toast('这票未记入：投票已结束或当前不能投票。');
  });
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

// ---------- 舞台：1280×720 设计稿，按窗口等比缩放 ----------

const STAGE_W = 1280;
const STAGE_H = 720;
const ICON = {
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  log: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>',
};
const BANNERS = { intro: '开播！', accuse: '互盘时间！', vote: '投票！谁是人类？' };
const COUNT_LABEL = { speak: '秒后自动跳过', defense: '秒后进入投票', vote: '秒后开始念票' };

function fitStage() {
  const stage = document.querySelector('#stage');
  if (!stage) return;
  const scale = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
  stage.style.transform = `scale(${scale})`;
  state.scale = scale;
}

function wait(ms) {
  return reduced || ms <= 0 ? Promise.resolve() : new Promise(resolve => setTimeout(resolve, ms));
}

function pop(el) {
  if (!el || reduced) return;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
}

function shake() {
  const scene = document.querySelector('#stage > *');
  if (!scene || reduced) return;
  scene.classList.remove('shake');
  void scene.offsetWidth;
  scene.classList.add('shake');
}

function av(roleId, extra = '') {
  return `<i class="char av-${esc(characterOf(roleId).key)}${extra ? ` ${extra}` : ''}" aria-hidden="true"></i>`;
}

function mini(roleId) {
  return `<span class="mini"><i class="av-${esc(characterOf(roleId).key)}"></i></span>`;
}

function seatRole(seat) {
  if (seat === 0) return 'host';
  if (seat === (state.game?.playerSeat ?? 5)) return 'player';
  return state.game?.seats?.find(item => item.seat === seat)?.roleId ?? 'host';
}

function whoName(seat, fallback = '') {
  if (seat == null) return fallback;
  const role = seatRole(seat);
  if (role === 'host') return '群主';
  if (role === 'player') return '牛小七';
  return characterOf(role).label || fallback;
}

// 逐字打出一句话。减少动态效果时直接显示整句。
function typeInto(el, text, { instant = false } = {}) {
  if (!el) return;
  const full = String(text ?? '');
  if (el.dataset.full === full) return;
  el.dataset.full = full;
  clearTimeout(el._typer);
  if (instant || reduced || !full) {
    el.textContent = full;
    return;
  }
  const chars = [...full];
  let shown = 0;
  const caret = document.createElement('span');
  caret.className = 'caret';
  const tick = () => {
    shown = Math.min(chars.length, shown + 2);
    el.textContent = chars.slice(0, shown).join('');
    if (shown < chars.length) {
      el.appendChild(caret);
      el._typer = setTimeout(tick, 45);
    }
  };
  tick();
}

function render() {
  const screen = state.game ? screenOf(state.game) : 'lobby';
  if (screen !== state.screen) {
    state.screen = screen;
    state.wallKey = '';
    state.lastPhase = '';
    state.voteFx = null;
    state.revealKey = '';
    const inner = screen === 'lobby' ? lobbyHtml() : screen === 'table' ? tableHtml() : screen === 'reveal' ? revealHtml() : errorHtml();
    app.innerHTML = `<div class="stage stage-${screen}" id="stage">${inner}</div>`;
    fitStage();
    if (screen === 'lobby') dropLineup();
  }
  if (screen === 'table') paintTable();
  if (screen === 'reveal') paintReveal();
  if (screen === 'error') paintError();
}

// ---------- 开局 ----------

function lobbyHtml() {
  const scene = SCENES.find(item => item.id === state.sceneId) ?? SCENES[0];
  const guests = CAST.filter(item => item.roleId !== 'host');
  return `<form class="lobby" id="setup">
    <div class="beams"></div><div class="floor"></div>
    <div class="logo">
      <div class="ep">AI 综艺 · 文字局</div>
      <h1 class="slant title">谁是人类<span class="q">？</span></h1>
      <p class="sub">4 个 AI ＋ 1 个人类 · 装成模型，别被投出去</p>
    </div>
    ${av('host', 'host-lobby')}
    <div class="hb">欢迎来到《谁是人类》！</div>
    <div class="room">
      <div class="tag">场景</div>
      <div class="opts scenes">
        ${SCENES.map(item => `<label class="opt"><input type="radio" name="scene" value="${esc(item.id)}" ${item.id === state.sceneId ? 'checked' : ''}><span>${esc(item.name)}</span></label>`).join('')}
      </div>
      <p class="blurb" id="blurb">${esc(scene?.blurb ?? '')}</p>
      <div class="tag">难度</div>
      <div class="opts diffs">
        ${DIFFICULTIES.map(item => `<label class="opt"><input type="radio" name="difficulty" value="${esc(item.id)}" ${item.id === state.difficulty ? 'checked' : ''}><span>${esc(item.name)}</span></label>`).join('')}
      </div>
      <div class="tag">你的化名</div>
      <div class="alias-row">
        <input id="alias" name="alias" maxlength="12" autocomplete="off" aria-label="化名" value="${esc(state.alias)}">
        <button class="copy" type="button" id="random">随机</button>
      </div>
    </div>
    <div class="lineup" id="lineup">
      ${guests.map(item => `<div class="slot">${av(item.roleId)}<span class="nm">${esc(characterOf(item.roleId).label)}</span><small>${esc(item.name)}</small></div>`).join('')}
      <div class="slot me">${av('player')}<span class="nm">牛小七</span><small>5 号 · 你</small></div>
    </div>
    <div class="rule">${mini('player')}<span>你是 <b>牛小七</b>，混在 AI 里，<b>别被认出来</b>。<small>每局随机 4 位嘉宾上桌 · 文字模式，不连灵矽、不开麦</small></span></div>
    <button class="btn go" type="submit" id="start">开播 ▶</button>
  </form>`;
}

async function dropLineup() {
  const slots = [...document.querySelectorAll('#lineup .slot')];
  for (const slot of slots) {
    slot.classList.add('in');
    await wait(220);
  }
}

// ---------- 牌桌：发言 / 互盘 / 甩锅 / 投票 ----------

function tableHtml() {
  return `<div class="table">
    <header class="topbar" id="topbar">
      <span class="slant" id="phase"></span>
      <div class="timer"><i id="bar"></i></div>
      <span class="pill clock" id="clock">⏱ <span id="count">–</span><small id="count-label"></small></span>
      <span class="pill tally" id="tally" hidden>已投 <b id="tally-n">0</b>/5</span>
      <span class="pill live" id="live"></span>
    </header>
    <nav class="rail">
      <button class="ico" type="button" data-log title="发言记录" aria-label="发言记录">${ICON.log}</button>
    </nav>
    <div class="wall" id="seats"></div>
    <div class="subs" id="subs" aria-live="polite"><span aria-hidden="true">🎙</span><b class="who-line" id="who"></b><span class="subtitle" id="subtitle"></span></div>
    <div class="assist" id="assist" hidden></div>
    <section class="dock" id="dock"></section>
    <aside class="log" id="log" hidden><header><b>发言记录</b><button type="button" class="copy" data-log>收起</button></header><ol id="log-list"></ol></aside>
    <div class="banner" id="banner" hidden></div>
  </div>`;
}

function paintTable() {
  const game = state.game;
  const phase = document.querySelector('#phase');
  if (phase) phase.textContent = phaseLabel(game);
  const live = document.querySelector('#live');
  if (live) live.textContent = `● REC · ${difficultyName(game.difficulty)}`;
  if (state.lastPhase !== game.phase) {
    const previous = state.lastPhase;
    state.lastPhase = game.phase;
    if (previous && BANNERS[game.phase]) showBanner(BANNERS[game.phase]);
    else if (!previous && game.phase === 'intro') showBanner(BANNERS.intro);
  }
  paintSeats();
  paintTopic();
  paintSubtitle();
  paintDock();
  paintVotes();
  paintLog();
}

function paintSeats() {
  const el = document.querySelector('#seats');
  if (!el) return;
  const game = state.game;
  const seats = tableSeats(game, { thinking: state.thinking });
  const key = seats.map(seat => `${seat.seat}:${seat.roleId}`).join('|');
  if (state.wallKey !== key) {
    state.wallKey = key;
    const top = seats.filter(seat => !seat.you).slice(0, 3);
    const bottom = seats.filter(seat => !top.includes(seat));
    const span = bottom.length ? Math.max(1, Math.floor(6 / bottom.length)) : 6;
    el.innerHTML = `${top.map(seat => cardHtml(seat, 2)).join('')}
      <article class="card host" data-seat="0">${av('host')}
        <div class="who"><span class="nm">群主</span><small>主持 · 不投票</small><span class="waves" aria-hidden="true">)))</span><span class="topic-meta" id="topic-meta"></span></div>
        <div class="say" id="topic"></div>
      </article>
      ${bottom.map(seat => cardHtml(seat, span)).join('')}`;
  }
  const mode = dockMode(game);
  const votable = (mode === 'vote' || mode === 'defense') && !game.voteLocked;
  const sub = subtitleModel(game, { thinking: state.thinking });
  for (const seat of seats) {
    const card = el.querySelector(`.card[data-seat="${seat.seat}"]`);
    if (!card) continue;
    card.classList.toggle('speaking', seat.speaking);
    card.classList.toggle('dim', !seat.speaking && game.phase !== 'vote' && speakingSeat(game, { thinking: state.thinking }) != null);
    card.classList.toggle('thinking', seat.speaking && state.thinking);
    const canVote = votable && !seat.you;
    if (canVote) card.dataset.vote = String(seat.seat);
    else delete card.dataset.vote;
    card.classList.toggle('votable', canVote);
    card.classList.toggle('picked', !seat.you && game.playerVote === seat.seat);
    const bubble = card.querySelector('.bubble');
    const say = card.querySelector('.say');
    const last = lastLine(seat.seat);
    if (seat.speaking) {
      bubble.hidden = false;
      say.hidden = true;
      const text = sub.seat === seat.seat ? sub.text : last?.text ?? '';
      typeInto(bubble.querySelector('.text'), text, { instant: sub.thinking || seat.you });
    } else {
      bubble.hidden = true;
      say.hidden = false;
      const text = last?.text ? `「${last.text}」` : seat.you ? '「我是一台纯正的 AI。」' : '';
      if (say.textContent !== text) say.textContent = text;
    }
  }
  const host = el.querySelector('.card.host');
  if (host) host.classList.toggle('speaking', speakingSeat(game, { thinking: state.thinking }) === 0);
}

function cardHtml(seat, span) {
  const character = characterOf(seat.roleId);
  const tag = seat.you ? `你 · ${esc(state.game?.playerAlias || '五号')}` : `${esc(seat.name)} · ${seat.seat} 号`;
  return `<article class="card span-${span}${seat.you ? ' you' : ''}" data-seat="${seat.seat}">
    ${av(seat.roleId)}
    <div class="who"><span class="waves" aria-hidden="true">(((</span><span class="nm">${esc(character.label)}</span><small>${tag}</small><span class="waves" aria-hidden="true">)))</span></div>
    <div class="say"></div>
    <div class="bubble" hidden><span class="text"></span></div>
    <div class="votes"></div>
    <div class="count"></div>
  </article>`;
}

function lastLine(seat) {
  const lines = state.game?.dialogue ?? [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].seat === seat && lines[index].text) return lines[index];
  }
  return null;
}

function paintTopic() {
  const game = state.game;
  const el = document.querySelector('#topic');
  const meta = document.querySelector('#topic-meta');
  const topic = topicModel(game);
  if (!el || !topic) return;
  const hostTalking = speakingSeat(game, { thinking: state.thinking }) === 0;
  const hostLine = lastLine(0);
  const metaText = topic.upcoming ? topic.scene : `${topic.scene} · 第 ${topic.round} / 2 轮`;
  if (meta && meta.textContent !== metaText) meta.textContent = metaText;
  const card = hostTalking && hostLine ? hostLine.text : topic.upcoming ? '开场。五个模型里，混进了一个人类。' : `🃏 话题卡：${topic.prompt}`;
  if (state.thinking && hostTalking) typeInto(el, '思考中…', { instant: true });
  else typeInto(el, card, { instant: !hostTalking });
}

function paintSubtitle() {
  const model = subtitleModel(state.game, { thinking: state.thinking });
  const who = document.querySelector('#who');
  const line = document.querySelector('#subtitle');
  if (!who || !line) return;
  who.textContent = whoName(model.seat, model.name);
  if (line.dataset.text !== model.text || line.dataset.size !== model.size) {
    line.dataset.text = model.text;
    line.dataset.size = model.size;
    line.textContent = model.text;
    line.className = `subtitle ${model.size}${model.thinking ? ' thinking' : ''}`;
  }
}

function paintDock() {
  const el = document.querySelector('#dock');
  if (!el || !state.game) return;
  const game = state.game;
  const mode = dockMode(game);
  if (el.dataset.mode !== mode) {
    el.dataset.mode = mode;
    el.innerHTML = dockHtml(mode);
    const input = el.querySelector('#line');
    if (input) {
      input.value = state.draft;
      input.focus();
    }
    const assist = document.querySelector('#assist');
    const subs = document.querySelector('#subs');
    if (assist && subs) {
      assist.innerHTML = mode === 'speak' ? `${chipsHtml()}<span class="example" id="example" hidden></span>` : '';
      assist.hidden = mode !== 'speak';
      subs.hidden = mode === 'speak';
    }
    const label = document.querySelector('#count-label');
    if (label) label.textContent = COUNT_LABEL[mode] ?? '';
    document.querySelector('#topbar')?.classList.toggle('timed', Boolean(COUNT_LABEL[mode]));
  }
  const note = el.querySelector('#note');
  if (note) note.textContent = game.note || '';
  const example = document.querySelector('#example');
  if (example) {
    example.hidden = !game.example;
    example.textContent = game.example ? `💡 灵感：${game.example}` : '';
  }
  const mine = el.querySelector('#mine') || (['vote', 'defense'].includes(mode) && game.playerVote != null ? note : null);
  if (mine) {
    const target = game.seats.find(seat => seat.seat === game.playerVote);
    mine.textContent = target ? `✓ 已投 ${whoName(target.seat, target.name)}（${target.seat} 号）` : game.voteLocked ? '投票已结束，你未投票' : '你还没投票';
  }
  const logCount = el.querySelector('#log-count');
  if (logCount) logCount.textContent = String(game.dialogue?.length ?? 0);
  let home = el.querySelector('#home');
  if (state.mismatch && !home) {
    home = document.createElement('button');
    home.id = 'home';
    home.type = 'button';
    home.className = 'btn ghost sm';
    home.textContent = '回开局';
    el.appendChild(home);
  }
  if (!state.mismatch && home) home.remove();
}

function dockHtml(mode) {
  const drawer = `<button class="drawer" type="button" data-log>发言记录 <b>(<span id="log-count">0</span>)</b> ▲</button>`;
  const hold = `<button class="btn mic" type="button" id="hold" title="文字模式不会录音。语音版再接上。" aria-label="按住说话">${ICON.mic}</button>`;
  if (mode === 'speak') return `${hold}${lineForm('像模型一样回答这张卡', '确认')}<button class="btn ghost sm" type="button" id="hint">给我灵感</button>${drawer}`;
  if (mode === 'defense') return `${hold}${lineForm('甩一句锅，或直接点头像投票', '确认')}<p class="hint" id="note"></p>${drawer}`;
  if (mode === 'interrupt') return `${hold}${lineForm('打断这句，替自己辩一下', '打断')}<p class="hint" id="note"></p>${drawer}`;
  if (mode === 'vote') return `<div class="hint big"><b>👆 点击头像投票</b><span id="note"></span></div>${drawer}`;
  if (mode === 'ballots') return `<div class="hint"><span id="note"></span><b id="mine" role="status"></b></div>${drawer}`;
  return `<span class="btn mic wait" aria-hidden="true">${ICON.mic}</span><div class="hint"><b>按住说话</b><span id="note"></span></div>${drawer}`;
}

function chipsHtml() {
  return `<span class="tag">AI 腔速填</span>${AI_CHIPS.map(chip => `<button type="button" class="chip" data-chip="${esc(chip)}">${esc(chip)}</button>`).join('')}`;
}

function lineForm(placeholder, action) {
  const interrupt = action === '打断';
  return `<form class="line" id="line-form"><input id="line" maxlength="500" autocomplete="off" aria-label="${esc(placeholder)}" placeholder="${esc(placeholder)}"><button class="btn${interrupt ? ' red' : ''}" type="submit" id="${interrupt ? 'interrupt' : 'send'}">${esc(action)}</button></form>`;
}

// 投票：只把服务端已经公开的票画出来，新出现的票从投票人飞到目标牌上。
function paintVotes() {
  const game = state.game;
  const tally = document.querySelector('#tally');
  const clock = document.querySelector('#clock');
  const inVote = game.phase === 'vote';
  if (tally) tally.hidden = !inVote || dockMode(game) === 'vote';
  if (clock) clock.hidden = inVote && dockMode(game) !== 'vote';
  const key = `${state.sessionId}|${game.generation ?? ''}`;
  if (!state.voteFx || state.voteFx.key !== key) state.voteFx = { key, shown: 0, player: null, counts: {}, queue: Promise.resolve() };
  const fx = state.voteFx;
  const cards = ballotCards(game);
  const fresh = cards.slice(fx.shown);
  fx.shown = cards.length;
  if (game.playerVote != null && fx.player == null && ['vote', 'defense'].includes(game.phase)) {
    fx.player = game.playerVote;
    fresh.unshift({ seat: game.playerSeat ?? 5, targetSeat: game.playerVote });
  }
  for (const ballot of fresh) fx.queue = fx.queue.then(() => landVote(ballot, fx)).catch(() => {});
  const count = document.querySelector('#tally-n');
  if (count) count.textContent = String(cards.length + (game.playerVote != null ? 1 : 0));
}

async function landVote(ballot, fx) {
  if (state.voteFx !== fx) return;
  const wall = document.querySelector('#seats');
  const from = wall?.querySelector(`.card[data-seat="${ballot.seat}"]`);
  const to = wall?.querySelector(`.card[data-seat="${ballot.targetSeat}"]`);
  if (!from || !to) return;
  const role = seatRole(ballot.seat);
  const slot = to.querySelector('.votes');
  await flyTo(from.querySelector('.char'), slot, role);
  if (state.voteFx !== fx) return;
  slot.insertAdjacentHTML('beforeend', mini(role));
  pop(slot.lastElementChild);
  if (!from.querySelector('.check')) {
    from.insertAdjacentHTML('beforeend', `<span class="check">${ICON.check}</span>`);
    pop(from.querySelector('.check'));
  }
  fx.counts[ballot.targetSeat] = (fx.counts[ballot.targetSeat] ?? 0) + 1;
  const badge = to.querySelector('.count');
  badge.textContent = `×${fx.counts[ballot.targetSeat]}`;
  badge.classList.add('on');
  pop(badge);
  const max = Math.max(...Object.values(fx.counts));
  for (const card of wall.querySelectorAll('.card[data-seat]')) {
    card.classList.toggle('target', fx.counts[card.dataset.seat] === max && max > 1);
  }
  await wait(240);
}

async function flyTo(fromEl, toEl, role) {
  const stage = document.querySelector('#stage');
  if (reduced || !stage || !fromEl || !toEl || typeof Element.prototype.animate !== 'function') return;
  const scale = state.scale || 1;
  const box = stage.getBoundingClientRect();
  const a = fromEl.getBoundingClientRect();
  const b = toEl.getBoundingClientRect();
  const ghost = document.createElement('span');
  ghost.className = 'mini flying';
  ghost.innerHTML = `<i class="av-${characterOf(role).key}"></i>`;
  const x0 = (a.left + a.width / 2 - box.left) / scale - 19;
  const y0 = (a.top + a.height / 3 - box.top) / scale - 19;
  const x1 = (b.left + Math.min(b.width, 80) / 2 - box.left) / scale - 19;
  const y1 = (b.top + b.height / 2 - box.top) / scale - 19;
  ghost.style.left = `${x0}px`;
  ghost.style.top = `${y0}px`;
  stage.appendChild(ghost);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const anim = ghost.animate([
    { transform: 'translate(0,0) scale(1)' },
    { transform: `translate(${dx * 0.5}px,${dy * 0.5 - 80}px) scale(1.6) rotate(-12deg)`, offset: 0.5 },
    { transform: `translate(${dx}px,${dy}px) scale(1) rotate(8deg)` },
  ], { duration: 620, easing: 'cubic-bezier(.5,0,.6,1)' });
  try { await anim.finished; } catch { /* 被打断 */ }
  ghost.remove();
}

async function showBanner(text) {
  const el = document.querySelector('#banner');
  if (!el || reduced) return;
  el.innerHTML = `<div class="strip"></div>${av('host', 'face')}<div class="txt slant">${esc(text)}</div>`;
  el.hidden = false;
  el.classList.remove('run');
  void el.offsetWidth;
  el.classList.add('run');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.hidden = true; el.classList.remove('run'); }, 1400);
}

function paintLog() {
  const box = document.querySelector('#log');
  if (!box) return;
  box.hidden = !state.logOpen;
  if (!state.logOpen) return;
  const list = box.querySelector('#log-list');
  const lines = state.game?.dialogue ?? [];
  const key = `${lines.length}|${lines.at(-1)?.text ?? ''}`;
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.innerHTML = lines.map(line => `<li>${mini(seatRole(line.seat))}<div><b>${esc(whoName(line.seat, line.name))}</b><small>${esc(line.name || '')}</small><p>${esc(line.text)}</p></div></li>`).join('') || '<li class="empty">还没有人发言。</li>';
  list.scrollTop = list.scrollHeight;
}

function toggleLog() {
  state.logOpen = !state.logOpen;
  paintLog();
}

// ---------- 揭晓 ----------

function revealHtml() {
  return `<div class="reveal">
    <div class="space"></div>
    <div class="banner" id="banner" hidden></div>
    <div class="hostzoom" id="hz">${av('host')}<div class="hb2">答案是——</div></div>
    <i class="tumble" id="tum" aria-hidden="true"></i>
    <p class="caption" id="cap"></p>
    <div class="flip" id="flip"><div class="inner">
      <div class="face front"><span class="slant qq">?</span></div>
      <div class="face back" id="flip-back"></div>
    </div></div>
    <div class="stamp" id="stamp"><span id="card-title"></span><small id="stamp-sub"></small></div>
    <div class="side">
      <div class="win" id="win"><span class="slant" id="outcome"></span></div>
      <div class="meter" id="meter">
        <div class="tag" id="meter-tag">人味分</div>
        <div class="chipsList" id="chips"></div>
        <blockquote class="quote" id="quote"></blockquote>
        <div class="calc">
          <div class="blk c"><small>人味分</small><b id="human">0</b></div>
          <span>vs</span>
          <div class="blk m"><small>AI 味</small><b id="ai-score">0</b></div>
          <span class="lbl" id="calc-note"></span>
        </div>
      </div>
      <div class="ending" id="ending-row">${mini('host')}<p id="ending"></p></div>
      <p class="roast" id="roast"></p>
      <div class="recap" id="recap"><span class="minis" id="recap-minis"></span><span id="recap-text"></span></div>
      <p class="meta-line" id="meta"></p>
      <div class="acts" id="acts">
        <button class="btn" type="button" id="again">再来一局</button>
        <button class="btn ghost" type="button" id="share">生成分享卡 📸</button>
        <button class="btn ghost" type="button" id="back">返回开局</button>
      </div>
    </div>
    <canvas id="card" width="1080" height="1440" hidden></canvas>
  </div>`;
}

function ejectedSeat(report) {
  if (!report) return null;
  if (report.outcome === '被识破') return state.game?.playerSeat ?? 5;
  let best = null;
  let top = 0;
  for (const [seat, count] of Object.entries(report.tally ?? {})) {
    if (Number(seat) !== (state.game?.playerSeat ?? 5) && count > top) {
      best = Number(seat);
      top = count;
    }
  }
  return best;
}

function paintReveal() {
  const game = state.game;
  const report = game?.report;
  if (!report) {
    const cap = document.querySelector('#cap');
    if (cap) cap.textContent = '正在揭晓……';
    return;
  }
  const key = `${state.sessionId}|${game.generation ?? ''}`;
  fillReveal(report);
  if (state.revealKey === key) return;
  state.revealKey = key;
  runReveal(report, key);
}

function fillReveal(report) {
  const caught = report.outcome === '被识破';
  const set = (sel, text) => { const el = document.querySelector(sel); if (el && el.textContent !== text) el.textContent = text; };
  set('#outcome', caught ? 'AI 阵营获胜！' : '人类潜伏成功！');
  document.querySelector('#win')?.classList.toggle('good', !caught);
  set('#card-title', report.title || '……');
  set('#stamp-sub', `称号 · ${report.outcome || ''}`);
  set('#meter-tag', caught ? '人味分 · 你为什么被认出来' : '人味分 · 你藏得怎么样');
  const quote = caughtQuote(report);
  const quoteEl = document.querySelector('#quote');
  const quoteHtml = `<small>${esc(quote.label || '金句')}</small>「${esc(quote.text || '……')}」`;
  if (quoteEl && quoteEl.dataset.html !== quoteHtml) {
    quoteEl.dataset.html = quoteHtml;
    quoteEl.innerHTML = quoteHtml;
  }
  set('#ending', report.endingText || '');
  set('#roast', report.roast ? `群主点评：${report.roast}` : '');
  set('#calc-note', `得票 ${report.received ?? 0}/${report.of ?? 4}`);
  const from = report.from ?? [];
  const minis = document.querySelector('#recap-minis');
  const minisHtml = from.map(item => mini(seatRole(item.seat))).join('');
  if (minis && minis.dataset.html !== minisHtml) {
    minis.dataset.html = minisHtml;
    minis.innerHTML = minisHtml;
  }
  set('#recap-text', from.length ? `${from.map(item => whoName(item.seat, item.name)).join('、')} 投了你${report.catcherLine ? ` · ${report.catcherLine}` : ''}` : '没有 AI 投你，干得漂亮。');
  const ballots = ballotCards(state.game).map(item => `${whoName(item.seat, item.name)}→${whoName(item.targetSeat, item.targetName)}`).join(' · ');
  const bits = [report.alias, report.scene, ballots ? `票型 ${ballots}` : ''];
  set('#meta', bits.filter(Boolean).join(' · '));
  const back = document.querySelector('#flip-back');
  const seat = ejectedSeat(report);
  const backHtml = caught
    ? `<div class="human"><span class="slant">人类！</span></div><i class="char av-niu-free"></i><div class="box" id="box"></div><div class="nm"><span>牛小七 · 得票 ${esc(report.received ?? 0)}/${esc(report.of ?? 4)}</span></div>`
    : seat != null
      ? `<div class="human ai"><span class="slant">是 AI！</span></div>${av(seatRole(seat))}<div class="nm"><span>${esc(whoName(seat))} · 背锅了</span></div>`
      : `<div class="human ai"><span class="slant">没人出局</span></div>${av('player')}<div class="nm"><span>牛小七 · 安全</span></div>`;
  if (back && back.dataset.html !== backHtml) {
    back.dataset.html = backHtml;
    back.innerHTML = backHtml;
  }
}

async function runReveal(report, key) {
  const live = () => state.revealKey === key && state.screen === 'reveal';
  const $ = sel => document.querySelector(sel);
  const caught = report.outcome === '被识破';
  const seat = ejectedSeat(report);
  const name = seat == null ? '' : whoName(seat);
  const chips = [
    ['得票', `${report.received ?? 0}/${report.of ?? 4}`, caught],
    ['卡壳', `×${report.stats?.stalls ?? 0}`, (report.stats?.stalls ?? 0) > 0],
    ['用了灵感', `×${report.stats?.hints ?? 0}`, false],
    ['插嘴', `×${report.stats?.interrupts ?? 0}`, false],
  ];
  const chipsEl = $('#chips');
  if (chipsEl) chipsEl.innerHTML = '';
  if (reduced) {
    for (const el of ['#flip', '#stamp', '#win', '#meter', '#recap', '#acts', '#ending-row', '#roast', '#meta']) $(el)?.classList.add('on', 'show', 'flipped');
    $('#box')?.classList.add('gone');
    if (chipsEl) chipsEl.innerHTML = chips.map(([label, value, hot]) => `<span class="chip${hot ? ' mul' : ''}"><b>${esc(value)}</b>${esc(label)}</span>`).join('');
    $('#human').textContent = String(report.humanScore ?? '—');
    $('#ai-score').textContent = String(report.aiScore ?? '—');
    $('#cap').innerHTML = name ? `<b>${esc(name)}</b> 被投出了…… 身份是：` : '没人被投出去……';
    $('#cap')?.classList.add('top');
    return;
  }
  const banner = $('#banner');
  if (banner) {
    banner.innerHTML = `<div class="strip"></div>${av('host', 'face')}<div class="txt slant">投票结果</div>`;
    banner.hidden = false;
    banner.classList.add('run');
  }
  await wait(1350);
  if (!live()) return;
  if (banner) banner.hidden = true;
  $('#hz')?.classList.add('run');
  await wait(1100);
  if (!live()) return;
  const tumble = $('#tum');
  if (tumble && seat != null) {
    tumble.className = `tumble av-${characterOf(caught ? 'player' : seatRole(seat)).key} run`;
  }
  typeInto($('#cap'), name ? `${name} 被投出了……` : '没人被投出去……');
  await wait(1900);
  if (!live()) return;
  if (tumble) tumble.hidden = true;
  const cap = $('#cap');
  cap.classList.add('top');
  cap.innerHTML = name ? `<b>${esc(name)}</b> 被投出了…… 身份是：` : '没人被投出去……';
  $('#flip')?.classList.add('show');
  await wait(450);
  $('#flip')?.classList.add('flipped');
  await wait(750);
  $('#box')?.classList.add('fall');
  await wait(600);
  if (!live()) return;
  $('#stamp')?.classList.add('on');
  await wait(300);
  shake();
  await wait(350);
  $('#win')?.classList.add('on');
  await wait(300);
  $('#meter')?.classList.add('on');
  for (const [label, value, hot] of chips) {
    if (!live()) return;
    chipsEl?.insertAdjacentHTML('beforeend', `<span class="chip${hot ? ' mul' : ''}"><b>${esc(value)}</b>${esc(label)}</span>`);
    pop(chipsEl?.lastElementChild);
    await wait(260);
  }
  await Promise.all([countUp($('#human'), report.humanScore), countUp($('#ai-score'), report.aiScore)]);
  pop($('#human')?.parentElement);
  shake();
  await wait(250);
  for (const el of ['#ending-row', '#roast', '#recap', '#meta', '#acts']) $(el)?.classList.add('on');
}

function countUp(el, to, ms = 900) {
  if (!el) return Promise.resolve();
  if (typeof to !== 'number') {
    el.textContent = '—';
    return Promise.resolve();
  }
  if (reduced) {
    el.textContent = String(to);
    return Promise.resolve();
  }
  const t0 = performance.now();
  return new Promise(resolve => {
    const frame = now => {
      const k = Math.min(1, (now - t0) / ms);
      el.textContent = String(Math.round(to * (1 - (1 - k) ** 3)));
      if (k < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}

// ---------- 连接中断 ----------

function errorHtml() {
  return `<div class="error-screen">
    ${av('host', 'err-host')}
    <div class="err-box">
      <span class="slant">连接中断</span>
      <h1>这局还在。</h1>
      <p id="error-copy"></p>
      <div class="acts on">
        <button class="btn" type="button" id="reload">重新读取</button>
        <button class="btn ghost" type="button" id="abandon">回开局</button>
      </div>
    </div>
  </div>`;
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
  const title = String(model.title || '分享卡').replace(/[\\/:*?"<>|]/g, '').trim() || '分享卡';
  canvas.toBlob(blob => {
    if (!blob) {
      toast('分享卡没有生成。');
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `谁是人类-${title}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1500);
    toast('分享卡已保存。');
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
  if (event.target.closest('[data-log]')) toggleLog();
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
  if (button.id === 'home' || button.id === 'abandon') {
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
  if (event.target.name === 'scene') {
    state.sceneId = event.target.value;
    const blurb = document.querySelector('#blurb');
    if (blurb) blurb.textContent = SCENES.find(item => item.id === state.sceneId)?.blurb ?? '';
  }
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
  const bar = document.querySelector('#bar');
  if (!bar) return;
  if (state.timerKey !== state.game.deadlineAt) {
    state.timerKey = state.game.deadlineAt;
    state.timerTotal = ms ?? 0;
  }
  const left = ms == null || !state.timerTotal ? 1 : Math.max(0, Math.min(1, ms / state.timerTotal));
  bar.style.transform = `scaleX(${left})`;
  bar.classList.toggle('low', left < 0.25);
}, 200);

window.addEventListener('resize', fitStage);

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
