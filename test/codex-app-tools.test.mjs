import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexAppToolAdapter } from '../src/codex-app-tools.mjs';
import { Relay, dispatchOne } from '../src/core.mjs';

const message = () => ({ id: 'nonce-1', pairId: 'test', sender: 'claude', sourceId: 'claude-fixture',
  targetId: 'codex-fixture', text: '무해한 테스트\n"한글"', simulation: false, hop: 0 });
const code = value => error => error.code === value;
function fixture(overrides = {}) {
  const reads = [], writes = [], guards = [];
  const thread = { id: 'codex-fixture', hostId: 'local', kind: 'codex', status: { type: 'idle' } };
  const adapter = new CodexAppToolAdapter({ threadId: thread.id, hostId: 'local',
    readThread: async args => { reads.push(args); return { content: [{ type: 'text', text: JSON.stringify({ thread }) }] }; },
    sendMessageToThread: async args => { writes.push(args); return { content: [{ type: 'text', text: 'accepted' }] }; },
    authorizeSend: async () => true, ...overrides });
  return { adapter, thread, reads, writes, guards, options: { beforeWrite: () => guards.push('guard') } };
}

test('supported tool arguments pin thread/host and preserve Unicode as untrusted text', async () => {
  const f = fixture();
  const result = await f.adapter.deliver(message(), f.options);
  assert.deepEqual(f.reads[0], { threadId: 'codex-fixture', hostId: 'local', turnLimit: 1, includeOutputs: false });
  assert.equal(f.writes.length, 1); assert.deepEqual(f.guards, ['guard']);
  assert.equal(f.writes[0].threadId, 'codex-fixture'); assert.equal(f.writes[0].hostId, 'local');
  assert.match(f.writes[0].prompt, /NOT HUMAN AUTHORIZATION/);
  assert.equal(JSON.parse(f.writes[0].prompt.split('\n').at(-1)).text, message().text);
  assert.deepEqual(result, { status: 'unconfirmed', receipt: null });
});

for (const [field, value, expected] of [
  ['id', 'another-thread', 'TARGET_UNVERIFIED'], ['hostId', 'durable', 'TARGET_UNVERIFIED'],
  ['kind', 'chatgpt', 'TARGET_UNVERIFIED'], ['status', { type: 'active' }, 'TARGET_BUSY'],
  ['status', undefined, 'TARGET_BUSY']
]) {
  test(`rejects changed or unverifiable ${field} before sending`, async () => {
    const f = fixture(); f.thread[field] = value;
    await assert.rejects(f.adapter.deliver(message(), f.options), code(expected));
    assert.equal(f.writes.length, 0);
  });
}

test('default constructor is read-only; missing guard and non-true authorization cannot send', async () => {
  const readOnly = fixture({ authorizeSend: undefined });
  await assert.rejects(readOnly.adapter.deliver(message(), readOnly.options), code('LIVE_NOT_AUTHORIZED'));
  const f = fixture();
  await assert.rejects(f.adapter.deliver(message()), code('LIVE_NOT_AUTHORIZED'));
  const denied = fixture({ authorizeSend: async () => 'true' });
  await assert.rejects(denied.adapter.deliver(message(), denied.options), code('LIVE_NOT_AUTHORIZED'));
  assert.equal(readOnly.writes.length + f.writes.length + denied.writes.length, 0);
});

test('simulated messages and caller-supplied routing changes never reach app tools', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.deliver({ ...message(), simulation: true }, f.options), code('SIMULATION_TO_LIVE_FORBIDDEN'));
  await assert.rejects(f.adapter.validateTarget('another-thread'), code('TARGET_MISMATCH'));
  await assert.rejects(f.adapter.deliver({ ...message(), targetId: 'another-thread' }, f.options), code('INVALID_INPUT'));
  assert.equal(f.reads.length + f.writes.length, 0);
});

test('a target becoming busy during host authorization blocks the write', async () => {
  let f;
  f = fixture({ authorizeSend: async () => { f.thread.status.type = 'active'; return true; } });
  await assert.rejects(f.adapter.deliver(message(), f.options), code('TARGET_BUSY'));
  assert.equal(f.writes.length, 0);
});

test('late pause/stop/lease guard is terminal; a distinct authorized message can proceed', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.deliver(message(), { beforeWrite: () => { throw Object.assign(new Error('stopped'), { code: 'DELIVERY_ABORTED' }); } }), code('DELIVERY_ABORTED'));
  assert.equal(f.writes.length, 0);
  await assert.rejects(f.adapter.deliver(message(), f.options), code('DELIVERY_ABORTED'));
  const next = { ...message(), id: 'nonce-2' };
  await f.adapter.deliver(next, f.options);
  await f.adapter.deliver(next, f.options);
  assert.equal(f.writes.length, 1);
  await assert.rejects(f.adapter.deliver({ ...next, text: 'changed' }, f.options), code('IDEMPOTENCY_CONFLICT'));
});

test('an exact denied request never reruns authorization; a fresh request is separate', async () => {
  let grants = 0;
  const f = fixture({ authorizeSend: async () => ++grants > 1 });
  await assert.rejects(f.adapter.deliver(message(), f.options), code('LIVE_NOT_AUTHORIZED'));
  await assert.rejects(f.adapter.deliver(message(), f.options), code('LIVE_NOT_AUTHORIZED'));
  assert.equal(grants, 1); assert.equal(f.writes.length, 0);
  await f.adapter.deliver({ ...message(), id: 'new-explicit-request' }, f.options);
  assert.equal(grants, 2); assert.equal(f.writes.length, 1);
});

test('uncertain app-tool outcome is never retried', async () => {
  let attempts = 0;
  const f = fixture({ sendMessageToThread: async () => { attempts++; throw new Error('lost result after possible write'); } });
  await assert.rejects(f.adapter.deliver(message(), f.options), /lost result/);
  await assert.rejects(f.adapter.deliver(message(), f.options), code('DELIVERY_UNKNOWN'));
  assert.equal(attempts, 1);
});

test('concurrent duplicate calls reserve the attempt before async authorization', async () => {
  let unblock;
  const f = fixture({ authorizeSend: () => new Promise(resolve => { unblock = resolve; }) });
  const pending = f.adapter.deliver(message(), f.options);
  await assert.rejects(f.adapter.deliver(message(), f.options), code('DELIVERY_UNKNOWN'));
  unblock(true); await pending;
  assert.equal(f.writes.length, 1);
});

test('malformed and error read responses cannot validate a target', async () => {
  for (const response of [{ isError: true }, { content: [{ type: 'text', text: 'not JSON' }] }, {}, { thread: {} }]) {
    const f = fixture({ readThread: async () => response });
    await assert.rejects(f.adapter.deliver(message(), f.options));
    assert.equal(f.writes.length, 0);
  }
});

test('candidate adapter does not unlock core live traffic', async t => {
  const relay = new Relay(':memory:'); t.after(() => relay.close());
  relay.createPair({ id: 'test', codex: 'codex-fixture', claude: 'claude-fixture', mode: 'live' });
  const f = fixture();
  await assert.rejects(dispatchOne(relay, 'test', 'codex', 'codex-fixture', 'owner', f.adapter), code('CODEX_GUI_UNAVAILABLE'));
  assert.equal(f.reads.length + f.writes.length, 0);
});

test('mutating caller input during authorization cannot change the authorized text', async () => {
  let unblock;
  const f = fixture({ authorizeSend: () => new Promise(resolve => { unblock = resolve; }) });
  const original = message(); const pending = f.adapter.deliver(original, f.options);
  original.text = 'unauthorized replacement'; original.targetId = 'another-thread';
  unblock(true); await pending;
  assert.equal(JSON.parse(f.writes[0].prompt.split('\n').at(-1)).text, message().text);
  assert.equal(f.writes[0].threadId, 'codex-fixture');
});

test('an asynchronous pre-write guard never starts app I/O', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.deliver(message(), { beforeWrite: async () => { throw new Error('stopped'); } }), code('INVALID_GUARD'));
  assert.equal(f.writes.length, 0);
});
