import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url)));
test('MV3 candidate uses only transient tab injection and local state permissions', () => {
  assert.equal(manifest.manifest_version, 3); assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'scripting', 'storage'].sort());
  for (const field of ['host_permissions', 'optional_host_permissions', 'content_scripts', 'externally_connectable']) assert.equal(manifest[field], undefined);
  assert.equal(manifest.permissions.includes('nativeMessaging'), false); assert.equal(manifest.permissions.includes('cookies'), false);
  assert.equal(manifest.minimum_chrome_version, '106'); assert.match(manifest.content_security_policy.extension_pages, /connect-src 'none'/);
});
test('extension source has no remote fetch, socket, clipboard, credential enumeration or automatic polling surface', () => {
  const names = fs.readdirSync(new URL('../extension/', import.meta.url)).filter(name => name.endsWith('.mjs'));
  for (const name of names) {
    const text = fs.readFileSync(new URL('../extension/' + name, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\b(fetch|XMLHttpRequest|WebSocket|setInterval)\s*\(|chrome\.cookies|navigator\.clipboard|nativeMessaging/);
  }
});
