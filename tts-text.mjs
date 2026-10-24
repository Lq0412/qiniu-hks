// 显示名和朗读名共用一张表。
const MODEL_NAMES = [
  ['Claude', '克劳德'],
  ['Cursor', '科瑟'],
  ['DeepSeek', '深度求索'],
];
const spokenNames = new Map(MODEL_NAMES.map(([display, spoken]) => [display.toLowerCase(), spoken]));
const displayNames = new Map(MODEL_NAMES.map(([display, spoken]) => [spoken, display]));
const displayPattern = new RegExp(MODEL_NAMES.map(([display]) => display).join('|'), 'gi');
const spokenPattern = new RegExp(MODEL_NAMES.map(([, spoken]) => spoken).join('|'), 'g');

export function restoreDisplayNames(text) {
  return text.replace(spokenPattern, name => displayNames.get(name));
}

// 模型文案中的玩家引用保持逐字原文。
export function displayModelText(text, playerTexts = []) {
  return text.replace(/「([^」]*)」|[^「]+/g, (part, quote) =>
    quote !== undefined && playerTexts.some(source => source.includes(quote)) ? part : restoreDisplayNames(part));
}
export function chineseNumber(number) {
  const digits = '零一二三四五六七八九';
  const tens = Math.floor(number / 10);
  const rest = number % 10;
  const chinese = number < 10 ? digits[number]
    : `${tens === 1 ? '' : digits[tens]}十${rest ? digits[rest] : ''}`;
  return chinese;
}

function ordinal(number) {
  return `第${chineseNumber(number)}、`;
}

export function sanitizeForTts(text) {
  return text
    .replace(displayPattern, name => spokenNames.get(name.toLowerCase()))
    .replace(/(?<![\d.])([1-9]\d?)号/g, (_, number) => `${chineseNumber(Number(number))}号`)
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
    .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([，。！？、；：「」『』（）【】《》…])\s*/g, '$1')
    .trim();
}
