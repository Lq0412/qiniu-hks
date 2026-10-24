import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeForTts } from '../tts-text.mjs';
import { normalizeEcho, isStageEcho } from '../mixin-game.mjs';
import { isInjectedEcho } from '../mixin-link.mjs';
import { scriptedDetect } from '../mixin-prompts.mjs';

test('sanitizeForTts removes emoji and sequence remnants', () => {
  assert.equal(sanitizeForTts('你好😀👩🏽‍💻🏳️‍🌈🇨🇳👍🏻❤️\uFE0F\u200D\u{E0067}\u{E007F}！'), '你好！');
});

test('sanitizeForTts converts keycaps and circled list numbers', () => {
  assert.equal(sanitizeForTts('1️⃣2⃣3️⃣🔟①②③⑩⑳㉑㊿❶➁➌⓵'),
    '第一、第二、第三、第十、第一、第二、第三、第十、第二十、第二十一、第五十、第一、第二、第三、第一、');
});

test('sanitizeForTts preserves ordinary Chinese and empty text', () => {
  assert.equal(sanitizeForTts('普通中文，第1题：你好。\n下一行 123 #*'), '普通中文，第1题：你好。\n下一行 123 #*');
  assert.equal(sanitizeForTts(''), '');
});

test('GPT emoji list echo matches the actual spoken text', () => {
  const original = '1️⃣先核对证据🙂2️⃣再给出结论👍';
  const spoken = '第一，先核对证据，第二，再给出结论';
  assert.equal(isInjectedEcho(spoken, [scriptedDetect('GPT', original)]), true);
  assert.equal(isInjectedEcho(original, [scriptedDetect('GPT', sanitizeForTts(original))]), true);
  assert.equal(isStageEcho(spoken, [normalizeEcho(original)]), true);
  assert.equal(isInjectedEcho('我昨天加班到十点', [scriptedDetect('GPT', original)]), false);
});
