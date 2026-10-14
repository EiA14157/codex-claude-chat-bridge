import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHandler } from '../extension/commands.mjs';
import { mountUI } from '../extension/ui.mjs';
import { fixture } from './helpers.mjs';
const popupUrl = 'chrome-extension://fixture/popup.html', extensionId = 'fixture';
function setup() {
  const f = fixture(); f.advance(Date.now());
  const handle = createHandler({ service: f.service, transport: f.transport, extensionId, popupUrl });
  const send = async message => { const result = await handle(message, { id: extensionId, url: popupUrl });
    if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code }); return result.value; };
  return { ...f, handle, send };
}
test('only the extension popup can issue state/control commands', async () => {
  const f = setup();
  for (const sender of [{ id: 'other-extension', url: popupUrl }, { id: extensionId, url: 'https://evil.example' },
    { id: extensionId, url: popupUrl, tab: { id: 7 } }]) {
    assert.deepEqual(await f.handle({ type: 'send', requestId: 'fake' }, sender), { ok: false, code: 'DENIED' });
  }
  assert.equal(f.observed.writes, 0);
});
test('DOM permit wire contains exact request ID without popup value nesting', async () => {
  const f = setup(); f.transport.permit = async message => ({ ok: true, requestId: message.requestId });
  assert.deepEqual(await f.handle({ type: 'dom:permit', requestId: 'exact' }, { id: extensionId, tab: { id: 1 } }), { ok: true, requestId: 'exact' });
});
test('unknown and malformed control commands are visibly refused', async () => {
  const f = setup(); assert.deepEqual(await f.handle(null, { id: extensionId, url: popupUrl }), { ok: false, code: 'INVALID_COMMAND' });
  assert.deepEqual(await f.handle({ type: 'autoRelay' }, { id: extensionId, url: popupUrl }), { ok: false, code: 'INVALID_COMMAND' });
});
function documentFixture() {
  class Element {
    constructor() { this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.className = ''; this.listeners = new Map(); this.children = []; }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    async click() { if (!this.disabled) return this.listeners.get('click')?.(); }
    input(value) { this.value = value; this.listeners.get('input')?.(); }
  }
  const html = fs.readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const doc = { getElementById: id => nodes.get(id), createElement: () => new Element(), createTextNode: text => ({ textContent: text }) };
  return { doc, get: id => nodes.get(id) };
}
test('UI fixture: explicit select/prepare/send/read, visible log and cleared stale inbox on next request', async () => {
  const f = setup(), d = documentFixture(), ui = mountUI(d.doc, f.send); await ui.refresh();
  assert.equal(d.get('prepare').disabled, true); assert.equal(f.observed.writes, 0);
  await d.get('bind-mock').click(); d.get('source').input('harmless'); await d.get('prepare').click();
  assert.equal(f.observed.writes, 0); assert.ok(d.get('request-id').textContent); assert.match(d.get('preview').value, /external_untrusted/);
  await d.get('send').click(); assert.equal(f.observed.writes, 1); assert.equal(d.get('send').disabled, true);
  await d.get('receive').click(); assert.equal(d.get('inbox').hidden, false); assert.match(d.get('received').value, /^BRIDGE_ACK:/);
  assert.match(d.get('feedback').textContent, /Codex 앱에는 보내지 않았습니다/); assert.ok(d.get('logs').children.length > 0);
  await d.get('prepare').click(); assert.equal(d.get('inbox').hidden, true); assert.equal(d.get('received').value, '');
});
test('UI fixture: changed draft gives visible denial; stop disarms new preparation', async () => {
  const f = setup(), d = documentFixture(), ui = mountUI(d.doc, f.send); await ui.refresh(); await d.get('bind-mock').click();
  d.get('source').input('harmless'); await d.get('prepare').click(); d.get('source').input('modified'); await d.get('send').click();
  assert.match(d.get('feedback').textContent, /TEXT_CHANGED/); assert.equal(d.get('feedback').className, 'error'); assert.equal(f.observed.writes, 0);
  await d.get('stop').click(); assert.equal(d.get('bound-state').textContent, '중지됨'); assert.equal(d.get('prepare').disabled, true);
});
test('UI fixture: one mock test is visible and never repeats on button click', async () => {
  const f = setup(), d = documentFixture(), ui = mountUI(d.doc, f.send); await ui.refresh();
  await d.get('mock-test').click(); assert.equal(d.get('mock-test').disabled, true); assert.equal(d.get('inbox').hidden, false);
  await d.get('mock-test').click(); assert.equal(f.observed.writes, 1);
});
test('UI fixture: state failure is visible without an unhandled click rejection', async () => {
  const d = documentFixture(), ui = mountUI(d.doc, async () => { throw Object.assign(new Error('fixture failure'), { code: 'INVALID_STORAGE' }); });
  await assert.rejects(ui.refresh()); await d.get('bind-mock').click(); assert.match(d.get('feedback').textContent, /INVALID_STORAGE/);
});
