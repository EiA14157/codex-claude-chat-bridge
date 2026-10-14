import fs from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
if (result.status) throw Error('Cannot list publication candidates');
const files = [...new Set(result.stdout.trim().split(/\r?\n/).filter(Boolean))];
const allowed = file => ['.gitattributes', '.gitignore', 'README.md', 'SHA256SUMS', 'package.json', 'package-lock.json'].includes(file) ||
  /^(src|test|integration|scripts)\/[^/]+\.mjs$/.test(file) || /^docs\/[A-Z0-9_-]+\.md$/.test(file) ||
  ['browser-extension/.gitignore', 'browser-extension/README.md', 'browser-extension/package.json'].includes(file) ||
  /^browser-extension\/(extension|demo|docs|scripts|test)\/[^/]+\.(mjs|html|css|json|md)$/.test(file);
const patterns = [
  ['home_path', /[A-Za-z]:(?:\\+|\/)(?:Users|Documents and Settings)(?:\\+|\/)[^\s]/],
  ['personal_thread_id', /\b01[a-f0-9]{6}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/i],
  ['key_material', /-----BEGIN(?:[ A-Z]+)?PRIVATE KEY-----/],
  ['credential_shape', /(?:xai-|sk-(?:proj-|ant-)?|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{16,}/]
];
const findings = [];
for (const file of files) {
  if (!allowed(file)) { findings.push({ file, kind: 'unexpected_artifact' }); continue; }
  const stat = fs.lstatSync(join(root, file)); if (!stat.isFile() || stat.isSymbolicLink()) { findings.push({ file, kind: 'nonregular_file' }); continue; }
  const text = fs.readFileSync(join(root, file), 'utf8');
  for (const [kind, pattern] of patterns) if (pattern.test(text)) findings.push({ file, kind });
  for (const id of text.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi) ?? []) {
    if (!/^([0-9a-f])\1{7}-\1{4}-(?:[1-5]\1{3}|\1{4})-(?:[89ab]\1{3}|\1{4})-\1{12}$/i.test(id)) findings.push({ file, kind: 'nonfixture_uuid' });
  }
}
if (findings.length) { console.error(JSON.stringify({ findings })); process.exitCode = 1; }
else console.log(JSON.stringify({ auditedFiles: files.length, findings: 0, scope: 'Source allowlist and high-confidence private-path/ID/credential patterns; logs/caches/requests/profiles excluded' }));
