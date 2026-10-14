import fs from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
for (const directory of ['extension', 'demo', 'scripts', 'test']) {
  for (const name of fs.readdirSync(join(root, directory)).filter(name => name.endsWith('.mjs'))) {
    const result = spawnSync(process.execPath, ['--check', join(root, directory, name)], { stdio: 'inherit' });
    if (result.status) process.exit(result.status);
  }
}
const result = spawnSync(process.execPath, ['--test', 'test/*.test.mjs'], { cwd: root, stdio: 'inherit', shell: false });
process.exitCode = result.status ?? 1;
