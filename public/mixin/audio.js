// 文字模式的音频接口。本文件不调用 getUserMedia，不请求麦克风，不连接灵矽。
// 语音调度（feat/mixin-voice）只替换函数体，保持导出名和参数不变。
//
// play(url, options) → Promise<void>
//   url：同源音频地址。空字符串直接 resolve。
//   options.seat：0 群主，1–4 是 AI，5 是玩家。
//   options.roleId：host / claudia / astra / shensi / baobao / xiaosi / player。
//   options.voiceId：音色 id，按字符串使用，纯数字也不要转成 number。
//   options.onEnded：自然播放结束时调用。stop() 打断时不调用。
//   Promise 在播放结束或 stop() 时 resolve。
//
// stop() → void
//   停掉 play() 的对白，不停思考音。
//
// playThinking() → void
//   座位切换时的循环「思考中」音效。重复调用只保留一层。
//
// stopThinking() → void
//   只停思考音。
//
// startHoldToTalk(handlers) → Promise<void>
//   handlers.onStart()
//   handlers.onStop({ blob, durationMs, mimeType })
//   handlers.onError(error)
//   handlers.onLevel(level)  level 为 0 到 1，可选。
//   按下时调用。失败走 onError，不要抛出未捕获异常。
//
// stopHoldToTalk() → void
//   松开时调用。语音模式结束录音并触发一次 onStop。

export async function play(url, options = {}) {
  void url;
  void options;
}

export function stop() {}

export function playThinking() {}

export function stopThinking() {}

export async function startHoldToTalk(handlers = {}) {
  void handlers;
}

export function stopHoldToTalk() {}
