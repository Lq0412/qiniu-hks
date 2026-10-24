import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFileAssets, decodeMxop, encodeMxop, pcmFromWav, revealSfxWav, ttsManifestEntry, wavFromPcm } from '../mixin-audio.mjs';
import { presynthCatalog } from '../mixin-prompts.mjs';

test('wav and mxop round-trip, and presynth names stay stable', async () => {
  const wav = revealSfxWav();
  assert.ok(wav.length < 20_000);
  const pcm = pcmFromWav(wav).pcm;
  assert.ok(pcm.length > 1000);
  assert.equal(pcmFromWav(wavFromPcm(pcm)).pcm.equals(pcm), true);
  const packed = encodeMxop(pcm);
  assert.ok(packed.length < wav.length);
  const decoded = decodeMxop(packed);
  assert.equal(decoded.pcm.length, Math.floor(pcm.length / 640) * 640);
  assert.ok(decoded.pcm.some(byte => byte !== 0));
  const ids = presynthCatalog().map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.slice(0, 11), [
    'host-open-annual-demo', 'host-rules', 'host-wrap-1', 'host-wrap-2', 'host-nudge',
    'host-reveal-bridge', 'host-skip-player', 'host-skip-1', 'host-skip-2', 'host-skip-3', 'host-skip-4',
  ]);
  assert.equal(ids.filter(id => /^host-open-.*-\d$/.test(id)).length, 3);
  assert.equal(ids.filter(id => id.startsWith('host-card-')).length, 36);
  assert.ok(presynthCatalog().every(item => item.text.trim()));
  const entry = ttsManifestEntry(presynthCatalog()[1], 'voice-host');
  assert.equal(entry.file, 'host-rules.mxop');
  assert.equal(entry.text.includes('规则很简单'), true);
  assert.equal(entry.voiceId, 'voice-host');
  assert.throws(() => decodeMxop(Buffer.from('nope')), /mxop/);
  assert.throws(() => pcmFromWav(Buffer.from('nope')), /WAV/);
  const dir = await mkdtemp(path.join(tmpdir(), 'mixin-audio-'));
  try {
    const manifest = { lines: [entry, { id: 'reveal-sfx', kind: 'sfx', file: 'reveal-sfx.wav', text: '', voiceId: null }] };
    await writeFile(path.join(dir, entry.file), packed);
    await writeFile(path.join(dir, 'reveal-sfx.wav'), wav);
    const assets = createFileAssets(dir, manifest);
    assert.ok((await assets.find({ voiceId: 'voice-host', text: entry.text }))?.length > 0);
    assert.equal(await assets.find({ voiceId: 'other', text: entry.text }), null);
    assert.ok((await assets.sfx())?.length > 0);
    const missing = createFileAssets(dir, { lines: [{ ...entry, file: 'gone.mxop' }] });
    assert.equal(await missing.find({ voiceId: 'voice-host', text: entry.text }), null);
    assert.equal(readFile, readFile);
  } finally {
    await rm(dir, { recursive: true });
  }
});
