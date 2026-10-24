import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeForTts, restoreDisplayNames, displayModelText } from '../tts-text.mjs';
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
  assert.equal(sanitizeForTts('普通中文，第1题：你好。\n下一行 123 #*'), '普通中文，第1题：你好。下一行 123 #*');
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

test('TTS names and seat numbers share echo normalization, leaving display input intact', () => {
  const display = 'Claude、Cursor、DeepSeek、GPT、Gemini，我投5号。';
  const spoken = '克劳德、科瑟、深度求索、GPT、Gemini，我投五号。';
  assert.equal(sanitizeForTts(display), spoken);
  assert.equal(isInjectedEcho(spoken, [scriptedDetect('GPT', display)]), true);
  assert.equal(isInjectedEcho(display, [scriptedDetect('GPT', spoken)]), true);
  assert.equal(normalizeEcho(display), normalizeEcho(spoken));
  assert.equal(sanitizeForTts('1号、10号、25号、99号；100号、3.5号、123'), '一号、十号、二十五号、九十九号；100号、3.5号、123');
});


test('display names reverse the shared pronunciation table and protect player quotes', () => {
  const spoken = '我是克劳德，科瑟和深度求索😊';
  assert.equal(restoreDisplayNames(spoken), '我是Claude，Cursor和DeepSeek😊');
  assert.equal(sanitizeForTts(restoreDisplayNames(spoken)), sanitizeForTts(spoken));
  assert.equal(displayModelText('克劳德说「我喜欢科瑟」', ['我喜欢科瑟']), 'Claude说「我喜欢科瑟」');
});

test('sanitizeForTts collapses whitespace left by emoji and around Chinese punctuation', () => {
  assert.equal(sanitizeForTts('  拆成三步 😊，  然后  继续\n。  '), '拆成三步，然后 继续。');
  assert.equal(sanitizeForTts('拆成三步 😊，'), '拆成三步，');
});
