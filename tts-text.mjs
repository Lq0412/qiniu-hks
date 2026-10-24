// 只用于语音输入和回声归一化；显示文案保留原文。
function ordinal(number) {
  const digits = '零一二三四五六七八九';
  const tens = Math.floor(number / 10);
  const rest = number % 10;
  const chinese = number < 10 ? digits[number]
    : `${tens === 1 ? '' : digits[tens]}十${rest ? digits[rest] : ''}`;
  return `第${chinese}、`;
}

export function sanitizeForTts(text) {
  return text
    .replace(/[0-9]\uFE0F?\u20E3|🔟|[\u2460-\u2473\u24EA\u24F5-\u24FE\u2776-\u277F\u2780-\u2789\u278A-\u2793\u3251-\u325F\u32B1-\u32BF]/gu, marker => {
      const code = marker.codePointAt(0);
      if (code >= 48 && code <= 57) return ordinal(code - 48);
      if (marker === '🔟') return ordinal(10);
      if (code === 0x24EA) return ordinal(0);
      for (const [start, end, first] of [[0x2460, 0x2473, 1], [0x24F5, 0x24FE, 1], [0x2776, 0x277F, 1], [0x2780, 0x2789, 1], [0x278A, 0x2793, 1], [0x3251, 0x325F, 21], [0x32B1, 0x32BF, 36]]) {
        if (code >= start && code <= end) return ordinal(code - start + first);
      }
      return marker;
    })
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}]/gu, '');
}
