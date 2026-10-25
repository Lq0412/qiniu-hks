import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(root, '..', 'coverage'), { recursive: true });
const testDir = join(root, '..', 'test');
const files = readdirSync(testDir)
  .filter(file => file.endsWith('.test.mjs'))
  .sort()
  .map(file => join('test', file));
const result = spawnSync(process.execPath, [
  '--test',
  '--experimental-test-coverage',
  '--test-coverage-include=*.mjs',
  '--test-coverage-lines=80',
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
  '--test-reporter=lcov',
  '--test-reporter-destination=coverage/lcov.info',
  ...files,
], { cwd: join(root, '..'), stdio: 'inherit' });

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
