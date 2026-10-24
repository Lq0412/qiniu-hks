// 一台设备只留一条灵矽连接。后台预合成和对局共用它。
// 对局开始时打断预合成，但不另开 WebSocket，避免第二条把第一条挤掉。

import { runPresynth } from './scripts/presynth.mjs';

export function createAudioLane({ openLink, dir, log = () => {}, timeoutMs = 100_000, catalog } = {}) {
  if (typeof openLink !== 'function') throw new Error('缺少连接入口');
  let link = null;
  let mode = 'idle';
  let cancel = false;
  let finished = Promise.resolve();
  let markFinished = () => {};
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
    cancel = false;
    finished = new Promise(resolve => { markFinished = resolve; });
    try {
      const current = await ensure();
      await runPresynth({
        link: current,
        dir,
        log,
        timeoutMs,
        catalog,
        shouldStop: () => cancel,
      });
    } catch (error) {
      if (!cancel) log(typeof error?.message === 'string' && error.message ? error.message : '预合成失败');
    } finally {
      if (mode === 'presynth') mode = 'idle';
      markFinished();
    }
  }

  return {
    get mode() { return mode; },
    warmupBackground() {
      if (mode !== 'idle') return finished;
      void pump();
      return finished;
    },
    async acquireForGame() {
      if (mode === 'presynth') {
        cancel = true;
        try { link?.abort(); } catch { /* 还没连上 */ }
        let timer;
        const limit = new Promise(resolve => { timer = setTimeout(resolve, 3000); });
        await Promise.race([finished, limit]);
        clearTimeout(timer);
        if (mode === 'presynth') {
          try { link?.cancelTurn(); } catch { /* 还没连上，或这一句已经结束 */ }
        }
      }
      mode = 'game';
      return ensure();
    },
    releaseGame() {
      if (mode !== 'game') return;
      mode = 'idle';
      this.warmupBackground();
    },
    close() {
      cancel = true;
      try { link?.abort(); } catch { /* 还没连上 */ }
      try { link?.close(); } catch { /* 已经关闭 */ }
    },
  };
}
