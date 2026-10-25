// 一台设备只留一条灵矽连接。后台预合成和对局共用它。
// 对局开始时打断预合成，但不另开 WebSocket，避免第二条把第一条挤掉。

import { runPresynth } from './scripts/presynth.mjs';

export function createAudioLane({ openLink, dir, log = () => {}, timeoutMs = 100_000, catalog } = {}) {
  if (typeof openLink !== 'function') throw new Error('缺少连接入口');
  let link = null;
  let mode = 'idle';
  let generation = 0;
  let running = false;
  let finished = Promise.resolve();
  let connecting = null;

  async function ensure() {
    if (link) return link;
    if (!connecting) {
      connecting = Promise.resolve().then(async () => {
        const next = openLink();
        await next.connect();
        link = next;
        return next;
      }).finally(() => { connecting = null; });
    }
    return connecting;
  }

  async function pump() {
    mode = 'presynth';
    const mine = ++generation;
    running = true;
    let markFinished;
    finished = new Promise(resolve => { markFinished = resolve; });
    try {
      const current = await ensure();
      await runPresynth({
        link: current,
        dir,
        log,
        timeoutMs,
        catalog,
        shouldStop: () => mine !== generation,
      });
    } catch (error) {
      if (mine === generation) log(typeof error?.message === 'string' && error.message ? error.message : '预合成失败');
    } finally {
      running = false;
      if (mine === generation && mode === 'presynth') mode = 'idle';
      markFinished();
    }
  }

  return {
    get mode() { return mode; },
    warmupBackground() {
      if (mode !== 'idle') return finished;
      if (running) {
        const previous = finished;
        return previous.then(() => this.warmupBackground());
      }
      void pump();
      return finished;
    },
    async acquireForGame() {
      if (mode === 'game') throw new Error('语音通道已被其他对局占用。');
      if (mode === 'presynth') {
        generation += 1;
        try { link?.abort(); } catch { /* 还没连上 */ }
      }
      mode = 'game';
      try { return await ensure(); }
      catch (error) { this.releaseGame(); throw error; }
    },
    releaseGame() {
      if (mode !== 'game') return;
      mode = 'idle';
      this.warmupBackground();
    },
    close() {
      generation += 1;
      try { link?.abort(); } catch { /* 还没连上 */ }
      try { link?.close(); } catch { /* 已经关闭 */ }
    },
  };
}
