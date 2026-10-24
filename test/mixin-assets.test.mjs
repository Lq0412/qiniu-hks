import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createApp } from '../server.mjs';

test('mixin assets: image MIME, missing files and raw/encoded traversal', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mixin-assets-'));
  const server = createApp({ assetDir: dir });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise(r => server.close(r)); await rm(dir, { recursive: true }); });
  const get = (path, method = 'GET') => new Promise((resolve, reject) => {
    http.get({ method, hostname: '127.0.0.1', port: server.address().port, path }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => { res.body = body; resolve(res); });
    }).on('error', reject);
  });
  for (const [ext, mime] of Object.entries({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif' })) {
    await writeFile(join(dir, 'test.' + ext), 'fixture');
    const res = await get('/mixin/assets/test.' + ext);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], mime);
    assert.equal(res.headers['content-security-policy'], 'sandbox');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.body, 'fixture');
  }
  await writeFile(join(dir, 'test.svg'), '<svg/>');
  assert.equal((await get('/mixin/assets/test.svg')).statusCode, 404);
  const queried = await get('/mixin/assets/test.png?v=1#ignored');
  assert.equal(queried.statusCode, 200);
  assert.equal(queried.body, 'fixture');
  const head = await get('/mixin/assets/test.png?v=1', 'HEAD');
  assert.equal(head.statusCode, 200);
  for (const key of ['content-type', 'content-length', 'content-security-policy', 'x-content-type-options']) {
    assert.equal(head.headers[key], queried.headers[key], key);
  }
  assert.equal(head.headers['content-length'], '7');
  assert.equal(head.body, '');
  // 使用同名前缀的相邻目录，确保校验的是目录边界。
  const outside = dir + '-outside';
  await mkdir(outside);
  t.after(() => rm(outside, { recursive: true }));
  await writeFile(join(outside, 'secret.png'), 'outside');
  await symlink(join(outside, 'secret.png'), join(dir, 'escape.png'));
  assert.equal((await get('/mixin/assets/escape.png')).statusCode, 404);
  await symlink(outside, join(dir, 'escape-dir'));
  assert.equal((await get('/mixin/assets/escape-dir/secret.png')).statusCode, 404);
  await symlink(join(dir, 'test.png'), join(dir, 'inside.png'));
  assert.equal((await get('/mixin/assets/inside.png')).statusCode, 200);
  for (const path of ['missing.png', '../missing.png', '%2e%2e/missing.png', '%2e%2e%2fapp.js', '%2fetc/passwd', 'C:%5csecret.png', '%ZZ', '%00.png']) {
    assert.equal((await get('/mixin/assets/' + path)).statusCode, 404, path);
  }
});
