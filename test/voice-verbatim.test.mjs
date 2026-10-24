import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ACCUSATION_TEMPLATES, presynthCatalog, scriptedBody, stageDirection } from '../mixin-prompts.mjs';
import { buildMixinDetect } from '../mixin-link.mjs';
import { sanitizeForTts } from '../tts-text.mjs';
import { ttsKey, ttsManifestEntry } from '../mixin-audio.mjs';
import { createMixinGame, startMixin, viewMixin } from '../mixin-game.mjs';

test('every fixed cue sends exact sanitized words and local verbatim rules without persona', () => {
  for (const kind of ['host_open', 'host_card', 'wrap', 'nudge', 'accuse', 'vote', 'reveal']) {
    const line = '我投5号，Claude说「先核对，再提交」。😊';
    const text = stageDirection({ kind, name: 'GPT', line, personality: '爱用列表和 emoji，分点说明' });
    const detect = buildMixinDetect({ text, voiceId: 'fake-voice' });
    assert.equal(scriptedBody(detect.text), sanitizeForTts(line));
    assert.match(detect.text, /一字不增不减/);
    assert.match(detect.text, /禁止改写/);
    assert.doesNotMatch(detect.text, /爱用列表|emoji|分点说明/);
    assert.deepEqual(detect.agent_params, { voice: { id: 'fake-voice' } });
  }
  for (const template of ACCUSATION_TEMPLATES.astra) assert.doesNotMatch(template, /[0-9]\uFE0F?\u20E3/);
});

test('pronunciation changes invalidate old presynth hashes and expose spokenText', () => {
  const text = '请Claude、Cursor、DeepSeek先来，5号。';
  const voiceId = 'fake-voice';
  const hash = value => createHash('sha256').update(JSON.stringify([value, voiceId])).digest('hex').slice(0, 16);
  assert.notEqual(ttsKey(text, voiceId), hash(text));
  assert.equal(ttsKey(text, voiceId), hash(sanitizeForTts(text)));
  assert.equal(ttsManifestEntry({ id: 'fake', text }, voiceId).spokenText, sanitizeForTts(text));
});

test('state fixed cue exposes paired text and spokenText, and presynth uses Chinese question numbers', () => {
  const game = createMixinGame({ demo: true, now: 0 });
  startMixin(game, { generation: game.generation, mode: 'text', now: 0 });
  const cue = viewMixin(game).cue;
  assert.equal(cue.text, game.cue.line);
  assert.equal(cue.spokenText, sanitizeForTts(cue.text));
  const cards = presynthCatalog().filter(item => item.id.startsWith('host-card-'));
  assert.ok(cards.length > 0);
  for (const card of cards) assert.match(card.text, /^第[一二]题：/);
});
