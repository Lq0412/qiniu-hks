import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as logic from '../public/mixin/logic.js';

// 运行真实 app 请求流程，用可手动结束的音频替代播放设备，不连接灵矽。
async function pageHarness(game, response = {}) {
  const source = await readFile(new URL('../public/mixin/app.js', import.meta.url), 'utf8');
  let finish;
  let started;
  const playing = new Promise(resolve => { started = resolve; });
  const snapshots = [];
  const messages = [];
  const input = { value: '', focus() {}, addEventListener() {}, style: {}, classList: { toggle() {} } };
  const dialog = { open: false, innerHTML: '', addEventListener() {}, querySelectorAll: () => [], querySelector: () => ({ focus() {} }), showModal() { this.open = true; }, close() { this.open = false; } };
  const intervals = [];
  const context = {
    ...logic,
    document: { querySelector: selector => selector === '#game-menu' ? dialog : input },
    window: { matchMedia: () => ({ matches: false }), addEventListener() {} },
    performance: { now: () => context.time || 0 },
    sessionStorage: { setItem() {}, removeItem() {} },
    setInterval(fn) { intervals.push(fn); },
    fetch: async () => ({ ok: true, json: async () => ({ game, audioUrl: '/test.wav', ...response }) }),
    stop() {}, stopThinking() {}, pausePlayback() {}, resumePlayback() {},
    startHoldToTalk(handlers) { context.recordHandlers = handlers; },
    stopHoldToTalk() { if (context.recordHandlers) context.stopped = context.recordHandlers.onStop({ pcm: 'fake', durationMs: 1000 }); },
    play(url, options) {
      started({ url, options });
      return new Promise((resolve, reject) => { finish = error => error ? reject(error) : resolve(); });
    },
    snapshots,
    messages,
  };
  // 只替换模块装载和自动启动；call/adopt 与显示模型运行生产代码。
  const executable = source.replace(/^import\s[\s\S]*?from\s+'[^']+';\r?\n/gm, '')
    .replace(/boot\(\);\s*$/, `
      render = () => snapshots.push({
        thinking: state.thinking,
        seat: speakingSeat(state.game, state),
        subtitle: subtitleModel(state.game, state),
        seats: tableSeats(state.game, state),
      });
      toast = message => messages.push(message);
      kick = () => {};
      globalThis.page = { state, call, beginHold, releaseHold, runLoop, submitLine, pauseGame, resumeGame, exitGame, fail };
    `);
  runInNewContext(executable, context);
  return { ...context.page, snapshots, playing, context, input, dialog, intervals, finish: error => finish(error) };
}

const cursor = { seat: 2, roleId: 'xiaosi', name: 'Cursor', voice: { voiceId: 'cursor-voice' }, kind: 'intro' };
const deepseek = { seat: 3, roleId: 'shensi', name: 'DeepSeek', kind: 'intro' };
const gemini = { seat: 1, roleId: 'baobao', name: 'Gemini', voice: { voiceId: 'gemini-voice' }, kind: 'vote' };
const gpt = { seat: 2, roleId: 'astra', name: 'GPT', kind: 'vote' };

for (const [speaker, next, phase] of [[cursor, deepseek, 'intro'], [gemini, gpt, 'vote']]) {
  test(`${speaker.name} 音频播放期间，高亮和字幕不会提前切到 ${next.name}`, async () => {
    const line = { seat: speaker.seat, name: speaker.name, text: `我是${speaker.name}。`, kind: speaker.kind };
    const game = { phase, cue: next, seats: [speaker, next], dialogue: [line] };
    const page = await pageHarness(game);
    page.state.game = { ...game, cue: speaker, dialogue: [] };
    page.state.thinking = true;
    const request = page.call('step', {});
    const playback = await page.playing;
    const shown = page.snapshots.at(-1);
    assert.equal(playback.options.roleId, speaker.roleId);
    assert.equal(playback.options.voiceId, speaker.voice.voiceId);
    assert.equal(shown.thinking, false);
    assert.equal(shown.seat, speaker.seat);
    assert.equal(shown.subtitle.text, line.text);
    assert.equal(shown.subtitle.seat, speaker.seat);
    assert.equal(shown.seats.find(seat => seat.speaking).roleId, speaker.roleId);
    assert.equal(page.state.game.cue.seat, next.seat);
    page.finish();
    await request;
    assert.equal(page.state.speech, null);
    assert.equal(logic.speakingSeat(page.state.game, { thinking: true }), next.seat);
  });
}

for (const phase of ['round_player', 'defense', 'vote']) {
  test(`${phase} 已进入玩家阶段时仍等当前语音播完才切换显示`, async () => {
    const line = { seat: 0, name: '群主', text: '请五号发言。', kind: 'wrap' };
    const game = { phase, cue: null, seats: [], dialogue: [line], playerSeat: 5 };
    const page = await pageHarness(game);
    page.state.game = { ...game, cue: { seat: 0, roleId: 'host' } };
    page.state.thinking = true;
    const request = page.call('step', {});
    await page.playing;
    assert.equal(page.snapshots.at(-1).seat, 0);
    assert.equal(page.snapshots.at(-1).subtitle.text, line.text);
    page.finish();
    await request;
    assert.equal(page.snapshots.at(-1).seat, 5);
    assert.equal(page.state.speech, null);
  });
}

test('播放失败后清除当前语音的高亮锁定', async () => {
  const game = { phase: 'round_player', cue: null, seats: [], dialogue: [{ seat: 2, name: 'Cursor', text: '代码收到。' }] };
  const page = await pageHarness(game);
  const request = page.call('step', {});
  const rejected = assert.rejects(request, /播放失败/);
  await page.playing;
  page.finish(new Error('播放失败'));
  await rejected;
  assert.equal(page.state.speech, null);
  assert.equal(page.snapshots.at(-1).seat, 5);
});

test('录音和识别暂停自动推进，只填草稿；玩家确认后才提交', async () => {
  const game = { phase: 'round_player', mode: 'live', generation: 1, round: 2, seats: [], dialogue: [] };
  const page = await pageHarness(game);
  page.state.game = game;
  page.state.sessionId = 'fake-session';
  page.state.draft = '之前的文字';
  const requests = [];
  let complete;
  page.context.fetch = async (path, options) => {
    requests.push({ path, body: JSON.parse(options.body) });
    return new Promise(resolve => { complete = text => resolve({ ok: true, json: async () => ({ text, durationMs: 1000 }) }); });
  };
  page.beginHold();
  assert.equal(page.state.inputBusy, true);
  await page.runLoop(page.state.loopId);
  assert.equal(requests.length, 0);
  page.releaseHold();
  await Promise.resolve();
  assert.equal(page.state.inputBusy, true);
  assert.equal(requests.length, 1);
  assert.match(requests[0].path, /transcribe$/);
  assert.equal(page.state.draft, '之前的文字');
  complete('作为一个 AI，我先分析。');
  await page.context.stopped;
  assert.equal(page.state.inputBusy, false);
  assert.equal(page.input.value, '作为一个 AI，我先分析。');
  assert.equal(page.state.game.pending, undefined);
  assert.equal(requests.length, 1);
  page.context.fetch = async (path, options) => {
    const body = JSON.parse(options.body);
    requests.push({ path, body });
    return { ok: true, json: async () => ({ game: path.endsWith('/text') ? { ...game, pending: { text: body.text, revision: 1 } } : game }) };
  };
  await page.submitLine();
  assert.equal(requests[1].body.typed, false);
  assert.equal(requests[1].body.durationMs, 1000);
  assert.match(requests[2].path, /confirm$/);
});

test('识别失败保留草稿并恢复计时，文字局不触发录音', async () => {
  const game = { phase: 'round_player', mode: 'live', generation: 1, round: 1, seats: [], dialogue: [] };
  const page = await pageHarness(game);
  page.state.game = game;
  page.state.draft = '不要丢掉这句';
  page.context.fetch = async () => { throw new Error('连接已关闭'); };
  page.beginHold();
  page.releaseHold();
  await page.context.stopped;
  assert.equal(page.state.inputBusy, false);
  assert.equal(page.state.draft, '不要丢掉这句');
  page.context.recordHandlers = null;
  page.state.game = { ...game, mode: 'text' };
  page.beginHold();
  assert.equal(page.context.recordHandlers, null);
});

const flush = () => new Promise(resolve => setImmediate(resolve));

test('录音期间不发识别请求，松开仅识别一次完整音频', async () => {
  const game = { phase: 'round_player', mode: 'live', generation: 1, round: 1, seats: [], dialogue: [] };
  const page = await pageHarness(game);
  page.state.game = game;
  const requests = [];
  page.context.fetch = async (path, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ text: '完整回答', durationMs: 4500 }) };
  };
  page.beginHold();
  await flush();
  assert.equal(requests.length, 0);
  assert.equal(page.context.recordHandlers.onProgress, undefined);
  await page.context.recordHandlers.onStop({ pcm: 'complete-audio', durationMs: 4500 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pcm, 'complete-audio');
  assert.equal(page.input.value, '完整回答');
  assert.equal(page.state.inputBusy, false);
});

test('取消录音保留原草稿，不请求识别', async () => {
  const game = { phase: 'round_player', mode: 'live', generation: 1, round: 1, seats: [], dialogue: [] };
  const page = await pageHarness(game);
  page.state.game = game;
  page.state.draft = '原来的草稿';
  let requests = 0;
  page.context.fetch = async () => { requests++; throw new Error('不应识别'); };
  page.beginHold();
  await page.context.recordHandlers.onStop(null);
  assert.equal(requests, 0);
  assert.equal(page.input.value, '原来的草稿');
  assert.equal(page.state.inputBusy, false);
});

test('完整识别失败显示具体原因并保留已有文字', async () => {
  const game = { phase: 'round_player', mode: 'live', generation: 1, round: 1, seats: [], dialogue: [] };
  const page = await pageHarness(game);
  page.state.game = game;
  page.state.draft = '原来的回答';
  page.context.fetch = async () => { throw new Error('语音识别超时，请重试。'); };
  page.beginHold();
  await page.context.recordHandlers.onStop({ pcm: 'final', durationMs: 4500 });
  assert.equal(page.state.draft, '原来的回答');
  assert.equal(page.context.messages.at(-1), '语音识别超时，请重试。');
  assert.equal(page.state.inputBusy, false);
});

test('暂停冻结倒计时并保留输入，继续从同一剩余时间恢复', async () => {
  const game = { phase: 'round_player', mode: 'live', deadlineAt: 20000, seats: [], dialogue: [] };
  const page = await pageHarness(game);
  page.state.game = game;
  page.state.draft = '暂时不要提交';
  page.context.time = 3000;
  page.pauseGame();
  assert.equal(page.state.paused, true);
  assert.equal(page.dialog.open, true);
  assert.match(page.dialog.innerHTML, /游戏已暂停/);
  page.context.time = 63000;
  page.intervals[0]();
  assert.equal(page.input.textContent, '17');
  page.context.fetch = () => { throw new Error('暂停时不应发送请求'); };
  await page.runLoop(page.state.loopId);
  await page.submitLine();
  page.resumeGame();
  assert.equal(page.dialog.open, false);
  assert.equal(page.state.draft, '暂时不要提交');
  page.intervals[0]();
  assert.equal(page.input.textContent, '17');
});

test('失效对局停止自动运行并提供重新开局，不能继续旧局', async () => {
  const page = await pageHarness({ phase: 'round_player', seats: [], dialogue: [] });
  page.state.game = { phase: 'round_player', seats: [], dialogue: [] };
  page.state.sessionId = 'old';
  page.fail({ status: 404, payload: { error: '没有这一局。' } });
  assert.equal(page.state.expired, true);
  assert.equal(page.state.paused, true);
  assert.match(page.dialog.innerHTML, /重新开局/);
  page.resumeGame();
  assert.equal(page.state.paused, true);
  page.context.fetch = () => { throw new Error('失效对局无需再次退出服务端'); };
  await page.exitGame();
  assert.equal(page.state.game, null);
  assert.equal(page.state.sessionId, null);
  assert.equal(page.dialog.open, false);
});

test('退出会发送结束请求，迟到的步骤响应不能把页面拉回旧局', async () => {
  const game = { phase: 'intro', seats: [], dialogue: [] };
  const page = await pageHarness(game);
  page.state.game = game;
  page.state.sessionId = 'old';
  let complete;
  const paths = [];
  page.context.fetch = (path) => {
    paths.push(path);
    if (path.endsWith('/exit')) return Promise.resolve({ ok: true, json: async () => ({ exited: true }) });
    return new Promise(resolve => { complete = () => resolve({ ok: true, json: async () => ({ game }) }); });
  };
  const pending = page.call('step', {});
  page.pauseGame('exit');
  assert.match(page.dialog.innerHTML, /确认退出/);
  await page.exitGame();
  complete();
  await pending;
  assert.equal(paths.at(-1), '/api/mixin/old/exit');
  assert.equal(page.state.game, null);
  assert.equal(page.state.exiting, false);
});
