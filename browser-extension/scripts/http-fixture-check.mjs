import assert from 'node:assert/strict';
import { once } from 'node:events';
import { server } from './serve.mjs';
if (!server.listening) await once(server, 'listening');
try {
const origin = 'http://127.0.0.1:43127';
const page = await fetch(origin + '/demo/'); assert.equal(page.status, 200); const html = await page.text();
assert.match(html, /로컬 Fixture 미리보기/); assert.match(html, /Codex 데스크톱 앱 미연결/);
assert.match(html, /src="\/demo\/demo.mjs"/); assert.match(html, /id="fixture"/);
for (const path of ['/demo/fixture.html', '/demo/fixture.mjs', '/demo/demo.mjs', '/extension/ui.mjs', '/extension/commands.mjs', '/extension/popup.css']) {
  const response = await fetch(origin + path); assert.equal(response.status, 200, path);
  assert.ok((await response.text()).length > 0, path);
}
for (const path of ['/package.json', '/README.md', '/%2e%2e/README.md', '/extension/%E0%A4%A']) {
  const response = await fetch(origin + path); assert.ok([400, 404].includes(response.status), path);
}
const denied = await fetch(origin + '/demo/', { method: 'POST' }); assert.equal(denied.status, 403);
console.log(JSON.stringify({ passed: 12, scope: 'Owned localhost HTTP assets and access restrictions; no browser rendering, extension installation or app connection', externalRequests: 0 }));
} finally { await new Promise(resolve => server.close(resolve)); }
