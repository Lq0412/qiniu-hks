import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createApp } from '../server.mjs';

test('mixin assets: image MIME, missing files and raw/encoded traversal', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mixin-assets-'));
  const server = createApp({ assetDir: dir });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise(r => server.close(r)); await rm(dir, { recursive: true }); });
  const get = path => new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: server.address().port, path }, res => {
      res.resume(); res.on('end', () => resolve(res));
    }).on('error', reject);
  });
  for (const [ext, mime] of Object.entries({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' })) {
    await writeFile(join(dir, 'test.' + ext), 'fixture');
    const res = await get('/mixin/assets/test.' + ext);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], mime);
  }
  for (const path of ['missing.png', '../app.js', '%2e%2e/app.js', '%2e%2e%2fapp.js', '%2fetc/passwd', 'C:%5csecret.png', '%ZZ', '%00.png']) {
    assert.equal((await get('/mixin/assets/' + path)).statusCode, 404, path);
  }
});
