import test from 'node:test';
import assert from 'node:assert/strict';
import { createScriptedSpeaker, dispatchSeatSpeech, speakRequest } from '../mixin-voice.mjs';

const request = {
  cueId: 'c1',
  generation: 1,
  phase: 'intro',
  seat: 1,
  roleId: 'claudia',
  voice: { voiceId: null, label: '知性温柔女声', rate: 'slow', pitch: 'medium', emotion: 'calm', verified: false },
  instruction: '【舞台指令】自我介绍',
  fallbackText: '大家好，我是Claude。',
};

test('seat speech validates the request and falls back without a live voice', async () => {
  assert.equal(speakRequest(request).voice.voiceId, null);
  for (const broken of [
    null,
    { ...request, cueId: '' },
    { ...request, generation: 1.5 },
    { ...request, seat: '1' },
    { ...request, voice: null },
    { ...request, instruction: null },
  ]) assert.throws(() => speakRequest(broken));
  const spoken = await dispatchSeatSpeech(createScriptedSpeaker(), request);
  assert.equal(spoken.ok, true);
  assert.equal(spoken.text, request.fallbackText);
  assert.equal(spoken.voiceUsed, null);
  assert.equal(spoken.mode, 'text');
  const empty = await dispatchSeatSpeech(async () => ({ text: '  ', mode: 'mock' }), request);
  assert.equal(empty.text, request.fallbackText);
  assert.equal(empty.mode, 'fallback');
  const failed = await dispatchSeatSpeech(async () => { throw new Error('音色没切过去'); }, request);
  assert.equal(failed.ok, false);
  assert.equal(failed.text, request.fallbackText);
  assert.match(failed.error, /音色没切过去/);
  const custom = await dispatchSeatSpeech(async () => ({ text: '自定义', voiceUsed: 'later', mode: 'mock' }), request);
  assert.equal(custom.text, '自定义');
  assert.equal(custom.voiceUsed, 'later');
  const weird = await dispatchSeatSpeech(async () => { throw 'x'; }, request);
  assert.equal(weird.error, '发言失败');
  const hung = await dispatchSeatSpeech(() => new Promise(() => {}), request, 20);
  assert.equal(hung.ok, false);
  assert.equal(hung.text, request.fallbackText);
  assert.equal(hung.mode, 'fallback');
  assert.match(hung.error, /超时/);
});
