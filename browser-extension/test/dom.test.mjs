import test from 'node:test';
import assert from 'node:assert/strict';
import { domOperation } from '../extension/dom-operation.mjs';
import { BrowserTransport } from '../extension/transports.mjs';
import { BridgeService, ackText } from '../extension/service.mjs';
import { createHandler } from '../extension/commands.mjs';

const contract = { input: '#composer', send: '#send', response: '#response', context: '#chat-title', contextText: 'Chosen fixture conversation' };
function page(t) {
  const names = ['document', 'location', 'chrome', 'HTMLTextAreaElement', 'HTMLInputElement', '__selectedTabBridgeCandidate'];
  const saved = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  t.after(() => { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  class Input {
    constructor() { this._value = ''; this.tagName = 'TEXTAREA'; this.type = 'text'; this.disabled = false; this.readOnly = false; this.isConnected = true; this.hidden = false; this.events = []; }
    get value() { return this._value; } set value(value) { this._value = value; }
    getClientRects() { return this.hidden ? [] : [{}]; }
    dispatchEvent(event) { this.events.push(event.type); this.onEvent?.(event); return true; }
  }
  const input = new Input(); let clicks = 0;
  const button = { tagName: 'BUTTON', disabled: false, isConnected: true, getClientRects: () => [{}], getAttribute: () => null,
    click() { clicks++; button.onClick?.(); } };
  const response = { textContent: '', isConnected: true, getClientRects: () => [{}] };
  const title = { textContent: contract.contextText };
  const nodes = new Map([['#composer', [input]], ['#send', [button]], ['#response', [response]], ['#chat-title', [title]]]);
  globalThis.document = { querySelectorAll: selector => { if (selector === 'bad[') throw Error('bad selector'); return nodes.get(selector) ?? []; } };
  globalThis.location = { href: 'https://fixture.example/chat/exact' };
  globalThis.HTMLTextAreaElement = Input; globalThis.HTMLInputElement = Input;
  globalThis.chrome = { runtime: { sendMessage: async message => ({ ok: true, requestId: message.requestId }) } };
  const args = { bindingId: 'binding-fixture', contract, expectedUrl: location.href, requestId: 'request-fixture',
    expiresAt: Date.now() + 60000, payload: 'harmless payload', expectedResponse: 'BRIDGE_ACK:request-fixture:nonce-fixture' };
  return { args, input, button, response, title, nodes, clicks: () => clicks,
    inspect: () => domOperation({ ...args, mode: 'inspect' }), run: (mode, extra = {}) => domOperation({ ...args, mode, ...extra }) };
}
test('DOM binding is explicit, preserves an empty composer and sends once with a worker permit', async t => {
  const f = page(t); assert.equal((await f.inspect()).bindingId, f.args.bindingId);
  assert.equal(f.input.value, ''); assert.equal(f.clicks(), 0);
  assert.equal((await f.run('send')).status, 'unconfirmed'); assert.equal(f.clicks(), 1);
  assert.deepEqual(f.input.events, ['input', 'change']);
  assert.equal((await f.run('send')).error, 'ALREADY_ATTEMPTED'); assert.equal(f.clicks(), 1);
});
test('preexisting user draft is never read out, replaced or submitted at selection', async t => {
  const f = page(t); f.input.value = 'unsaved secret-looking draft';
  const result = await f.inspect(); assert.deepEqual(result, { error: 'DRAFT_PRESENT' });
  assert.equal(f.input.value, 'unsaved secret-looking draft'); assert.equal(f.clicks(), 0);
});
test('a draft typed during asynchronous permit is preserved without click', async t => {
  const f = page(t); await f.inspect();
  chrome.runtime.sendMessage = async message => { f.input.value = 'new user draft'; return { ok: true, requestId: message.requestId }; };
  assert.equal((await f.run('send')).error, 'DRAFT_PRESENT'); assert.equal(f.input.value, 'new user draft'); assert.equal(f.clicks(), 0);
});
test('revocation during asynchronous gate refuses all DOM writes', async t => {
  const f = page(t); await f.inspect();
  chrome.runtime.sendMessage = async message => { await f.run('revoke'); return { ok: true, requestId: message.requestId }; };
  assert.equal((await f.run('send')).error, 'CANCELLED'); assert.equal(f.input.value, ''); assert.equal(f.clicks(), 0);
});
test('deadline equality after permission gate refuses all DOM writes', async t => {
  const f = page(t); await f.inspect(); const original = Date.now; let clock = f.args.expiresAt - 1;
  Date.now = () => clock; t.after(() => { Date.now = original; });
  chrome.runtime.sendMessage = async message => { clock = f.args.expiresAt; return { ok: true, requestId: message.requestId }; };
  assert.equal((await f.run('send')).error, 'EXPIRED'); assert.equal(f.input.value, ''); assert.equal(f.clicks(), 0);
});
for (const change of ['url', 'title', 'element']) {
  test(`changed ${change} after gate cannot send to an unintended conversation`, async t => {
    const f = page(t); await f.inspect();
    chrome.runtime.sendMessage = async message => {
      if (change === 'url') location.href = 'https://fixture.example/chat/other';
      if (change === 'title') f.title.textContent = 'Different conversation';
      if (change === 'element') f.nodes.set('#composer', []);
      return { ok: true, requestId: message.requestId };
    };
    assert.equal((await f.run('send')).error, change === 'element' ? 'DOM_CONTRACT_INVALID' : 'TARGET_CHANGED'); assert.equal(f.clicks(), 0);
  });
}
test('navigation triggered by input event leaves the attempt consumed but does not click', async t => {
  const f = page(t); await f.inspect(); f.input.onEvent = () => { location.href = 'https://fixture.example/chat/changed'; };
  assert.equal((await f.run('send')).error, 'TARGET_CHANGED'); assert.equal(f.clicks(), 0);
  assert.equal(globalThis.__selectedTabBridgeCandidate.consumed.has(f.args.requestId), true);
});
test('only the exact selected request acknowledgement leaves the page', async t => {
  const f = page(t); await f.inspect(); f.response.textContent = 'unrelated transcript and credentials';
  assert.deepEqual(await f.run('receive'), { text: null });
  f.response.textContent = f.args.expectedResponse; assert.deepEqual(await f.run('receive'), { text: f.args.expectedResponse });
  f.title.textContent = 'Wrong conversation'; assert.equal((await f.run('receive')).error, 'TARGET_CHANGED');
});
test('broad, ambiguous, hidden and unsupported composer selectors fail closed', async t => {
  const f = page(t);
  assert.equal((await f.run('inspect', { contract: { ...contract, response: 'body' } })).error, 'DOM_CONTRACT_INVALID');
  f.nodes.set('#response', [f.response, f.response]); assert.equal((await f.inspect()).error, 'DOM_CONTRACT_INVALID'); f.nodes.set('#response', [f.response]);
  f.input.hidden = true; assert.equal((await f.inspect()).error, 'DOM_CONTRACT_INVALID'); f.input.hidden = false;
  f.input.tagName = 'DIV'; assert.equal((await f.inspect()).error, 'DOM_CONTRACT_INVALID'); assert.equal(f.clicks(), 0);
});
for (const url of ['https://fixture.example/chat?a=secret', 'https://fixture.example/#token', 'http://remote.example/chat', 'https://user:password@fixture.example/chat']) {
  test('unsafe or unstable target URL is rejected without returning URL contents: ' + new URL(url).protocol, async t => {
    const f = page(t); location.href = url; const result = await f.inspect(); assert.deepEqual(result, { error: 'UNSUPPORTED_URL' });
  });
}
test('worker permission refusal never changes the composer', async t => {
  const f = page(t); await f.inspect(); chrome.runtime.sendMessage = async () => ({ ok: false, code: 'DENIED' });
  assert.equal((await f.run('send')).error, 'DENIED'); assert.equal(f.input.value, ''); assert.equal(f.clicks(), 0);
});
test('Chrome API fixture exercises exact document binding, spoofed sender rejection and one local DOM roundtrip', async t => {
  const f = page(t), calls = []; let docId = 'selected-document';
  const api = { tabs: { query: async filter => { assert.deepEqual(filter, { active: true, currentWindow: true }); return [{ id: 17 }]; } },
    scripting: { executeScript: async call => { calls.push(call.target); if (call.target.documentIds && call.target.documentIds[0] !== docId) return [];
      return [{ documentId: docId, result: await call.func(call.args[0]) }]; } } };
  const transport = new BrowserTransport(api);
  const storage = { value: null, read: async () => storage.value, write: async value => { storage.value = structuredClone(value); } };
  const service = new BridgeService({ storage, transport });
  const handle = createHandler({ service, transport, extensionId: 'fixture-extension', popupUrl: 'chrome-extension://fixture-extension/popup.html' });
  const binding = await transport.bindCurrent(contract); await service.bind(binding);
  const r = await service.prepare('fixture ping');
  chrome.runtime.sendMessage = async message => {
    await assert.rejects(transport.permit(message, { tab: { id: 99 }, documentId: docId, frameId: 0, url: location.href }), error => error.code === 'TARGET_CHANGED');
    return handle(message, { id: 'fixture-extension', tab: { id: 17 }, documentId: docId, frameId: 0, url: location.href });
  };
  f.button.onClick = () => { const packet = JSON.parse(f.input.value); f.response.textContent = packet.expectedResponse; f.input.value = ''; };
  await service.send(r.id, 'fixture ping'); assert.equal(f.clicks(), 1); assert.equal((await service.receive(r.id)).text, ackText(r));
  assert.ok(calls.slice(1).every(target => target.documentIds?.[0] === docId));
  docId = 'changed-document'; const next = await service.prepare('new');
  await assert.rejects(service.send(next.id, 'new'), error => error.code === 'TARGET_CHANGED'); assert.equal(f.clicks(), 1);
});
