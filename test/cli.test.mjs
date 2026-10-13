import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
test('dependency-free demo proves two directions and live fail-closed guard', () => {
  const result = spawnSync(process.execPath, ['src/cli.mjs', 'demo'], { cwd: root, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SIMULATION ONLY/);
  assert.match(result.stdout, /Codex → Claude: acknowledged/);
  assert.match(result.stdout, /Claude → Codex: acknowledged/);
  assert.match(result.stdout, /duplicate=true; total messages=2/);
  assert.match(result.stdout, /CODEX_GUI_UNAVAILABLE/);
});
test('invalid command exits nonzero with readable error', () => {
  const result = spawnSync(process.execPath, ['src/cli.mjs', 'send-real'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ERROR:/);
});
