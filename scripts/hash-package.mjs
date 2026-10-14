import fs from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
if (result.status) throw Error('Cannot list source files');
const files = [...new Set(result.stdout.trim().split(/\r?\n/).filter(Boolean))].filter(name => name !== 'SHA256SUMS').sort();
const lines = files.map(file => {
  const stat = fs.lstatSync(join(root, file)); if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Nonregular publication file');
  return createHash('sha256').update(fs.readFileSync(join(root, file))).digest('hex') + '  ' + file;
});
fs.writeFileSync(join(root, 'SHA256SUMS'), lines.join('\n') + '\n');
console.log(JSON.stringify({ hashedFiles: files.length }));
