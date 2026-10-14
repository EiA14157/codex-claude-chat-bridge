import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeService, ackText, LIMITS } from '../extension/service.mjs';
import { fixture, ready, errorCode, failure, deferred, delay, bounded } from './helpers.mjs';

test('explicit mock send and read produce one local receipt without a native Codex send', async () => {
  const f = fixture(), r = await ready(f);
  assert.equal((await f.service.send(r.id, 'harmless')).state, 'unconfirmed');
  const received = await f.service.receive(r.id);
  assert.deepEqual(received, { matched: true, text: ackText(r), codexDelivered: false });
  assert.equal(f.observed.writes, 1); assert.equal(f.observed.reads, 1);
  const saved = JSON.stringify(f.storage.data); assert.ok(!saved.includes('harmless')); assert.ok(!saved.includes(ackText(r)));
  await assert.rejects(f.service.send(r.id, 'harmless'), errorCode('RECEIVED'));
});
test('wrong request response is not exported or treated as receipt; explicit later read remains possible', async () => {
  const f = fixture(), r = await ready(f); await f.service.send(r.id, 'harmless');
  f.observed.inbox.set(r.id, 'unrelated private transcript');
  assert.deepEqual(await f.service.receive(r.id), { matched: false });
  assert.ok(!JSON.stringify(f.storage.data).includes('unrelated private transcript'));
  f.observed.inbox.set(r.id, ackText(r)); assert.equal((await f.service.receive(r.id)).matched, true);
  assert.equal(f.observed.writes, 1);
});
test('changed source is terminally denied and cannot validate or write', async () => {
  const f = fixture(), r = await ready(f);
  await assert.rejects(f.service.send(r.id, 'modified'), errorCode('TEXT_CHANGED'));
  await assert.rejects(f.service.send(r.id, 'harmless'), errorCode('DENIED'));
  assert.equal(f.observed.validations, 0); assert.equal(f.observed.writes, 0);
});
test('initial validation refusal is durably denied across a fresh service instance', async () => {
  const f = fixture({ validate: async () => { throw failure('PERMISSION_DENIED'); } }), r = await ready(f);
  await assert.rejects(f.service.send(r.id, 'harmless'), errorCode('PERMISSION_DENIED'));
  assert.equal(f.storage.data.requests[0].state, 'denied');
  const fresh = new BridgeService({ storage: f.storage, transport: f.transport, now: () => 1003 });
  await assert.rejects(fresh.send(r.id, 'harmless'), errorCode('DENIED')); assert.equal(f.observed.writes, 0);
});
test('wrong verified identity is denied before any transport effect', async () => {
  const f = fixture({ validate: async () => ({ kind: 'mock', bindingId: 'wrong' }) }), r = await ready(f);
  await assert.rejects(f.service.send(r.id, 'harmless'), errorCode('TARGET_CHANGED')); assert.equal(f.observed.writes, 0);
});
test('duplicate and retained write guards never allow another effect', async () => {
  const f = fixture(), r = await ready(f);
  f.transport.send = async (_, __, { beforeWrite }) => { f.observed.guard = beforeWrite; await beforeWrite(); f.observed.writes++;
    await assert.rejects(beforeWrite(), errorCode('ALREADY_ATTEMPTED')); return { status: 'unconfirmed' }; };
  await f.service.send(r.id, 'harmless');
  await assert.rejects(f.observed.guard(), errorCode('ALREADY_ATTEMPTED'));
  await assert.rejects(f.service.send(r.id, 'harmless'), errorCode('ALREADY_ATTEMPTED')); assert.equal(f.observed.writes, 1);
});
test('exclusive reservation prevents concurrent sends while initial validation hangs', async () => {
  const gate = deferred(), started = deferred();
  const f = fixture({ validate: async binding => { started.resolve(); await gate.promise; return { kind: binding.kind, bindingId: binding.id }; } }), r = await ready(f);
  const pending = f.service.send(r.id, 'harmless').catch(e => e.code); await started.promise;
  await assert.rejects(f.service.send(r.id, 'harmless'), errorCode('ALREADY_ATTEMPTED'));
  await f.service.terminate(r.id); assert.equal(await bounded(pending), 'CANCELLED');
  gate.resolve(); await delay(0); assert.equal(f.observed.writes, 0);
});
for (const phase of ['validation', 'delivery', 'receive']) {
  test(`cancellation promptly persists during hung ${phase} and blocks late effects`, async () => {
    const f = fixture(), r = await ready(f), gate = deferred(), started = deferred(); let guard;
    if (phase === 'validation') f.transport.validate = async binding => { started.resolve(); await gate.promise; return { kind: binding.kind, bindingId: binding.id }; };
    if (phase === 'delivery') f.transport.send = async (_, __, options) => { guard = options.beforeWrite; started.resolve(); await gate.promise; await guard(); f.observed.writes++; return { status: 'unconfirmed' }; };
    if (phase === 'receive') { await f.service.send(r.id, 'harmless'); f.transport.receive = async () => { started.resolve(); await gate.promise; return { text: ackText(r) }; }; }
    const pending = (phase === 'receive' ? f.service.receive(r.id) : f.service.send(r.id, 'harmless')).catch(e => e.code);
    await started.promise; await f.service.terminate(r.id);
    assert.equal(f.storage.data.requests[0].state, 'cancelled'); assert.equal(await bounded(pending), 'CANCELLED');
    gate.resolve(); await delay(0); if (guard) await assert.rejects(guard(), errorCode('ALREADY_ATTEMPTED'));
    assert.equal(f.observed.writes, phase === 'receive' ? 1 : 0);
  });
}
test('full stop is effective while a send hangs and explicit binding is required afterward', async () => {
  const f = fixture(), r = await ready(f), started = deferred(), gate = deferred();
  f.transport.validate = async binding => { started.resolve(); await gate.promise; return { kind: 'mock', bindingId: binding.id }; };
  const pending = f.service.send(r.id, 'harmless').catch(e => e.code); await started.promise;
  await f.service.stop(); assert.equal(await bounded(pending), 'STOPPED');
  await assert.rejects(f.service.prepare('new'), errorCode('NOT_BOUND')); gate.resolve(); await delay(0);
  assert.equal(f.observed.writes, 0); assert.equal(f.storage.data.requests[0].state, 'cancelled');
});
test('finite deadline bounds hung host preparation and retained callbacks', async () => {
  const f = fixture(), r = await ready(f), gate = deferred();
  f.advance(r.expiresAt - 10); f.transport.validate = async binding => { await gate.promise; return { kind: binding.kind, bindingId: binding.id }; };
  await assert.rejects(bounded(f.service.send(r.id, 'harmless')), errorCode('EXPIRED'));
  assert.equal(f.storage.data.requests[0].state, 'expired'); gate.resolve(); await delay(0); assert.equal(f.observed.writes, 0);
});
test('expiry after durable permit I/O prevents the first transport write', async () => {
  const f = fixture(), r = await ready(f);
  f.storage.afterWrite = data => { if (data.requests[0]?.state === 'write_started') f.advance(r.expiresAt); };
  await assert.rejects(f.service.send(r.id, 'harmless'), errorCode('EXPIRED'));
  assert.equal(f.observed.writes, 0); assert.equal(f.storage.data.requests[0].state, 'expired');
});
test('prepared expiry is persisted at equality and releases the pending slot without resetting the old request', async () => {
  const f = fixture(), r = await ready(f); f.advance(r.expiresAt);
  await assert.rejects(f.service.send(r.id, 'harmless'), errorCode('EXPIRED'));
  assert.equal(f.storage.data.requests[0].state, 'expired'); const next = await f.service.prepare('another'); assert.notEqual(next.id, r.id);
});
test('storage failure before reservation prevents any host work', async () => {
  const f = fixture(), r = await ready(f); f.storage.failWrites = true;
  await assert.rejects(f.service.send(r.id, 'harmless'), errorCode('STORAGE_FAILED'));
  assert.equal(f.observed.validations, 0); assert.equal(f.observed.writes, 0);
});
test('unknown effect is retained; worker restart never retries and always disarms', async () => {
  const f = fixture(), r = await ready(f); f.transport.send = async (_, __, { beforeWrite }) => { await beforeWrite(); f.observed.writes++; throw failure('TRANSPORT_FAILED'); };
  await assert.rejects(f.service.send(r.id, 'harmless'), errorCode('TRANSPORT_FAILED')); assert.equal(f.storage.data.requests[0].state, 'unknown');
  const fresh = new BridgeService({ storage: f.storage, transport: f.transport, now: () => 1003 });
  const state = await fresh.state(); assert.equal(state.stopped, true);
  await assert.rejects(fresh.send(r.id, 'harmless'), errorCode('UNKNOWN')); assert.equal(f.observed.writes, 1);
});
test('an interrupted persisted operation becomes unknown on restart', async () => {
  const f = fixture(), r = await ready(f); f.storage.data.requests[0].state = 'reserved';
  const fresh = new BridgeService({ storage: f.storage, transport: f.transport, now: () => 1003 });
  assert.equal((await fresh.state()).requests[0].state, 'unknown'); await assert.rejects(fresh.send(r.id, 'harmless'), errorCode('UNKNOWN'));
});
test('malformed persistent expiry fails closed', async () => {
  const f = fixture(); await ready(f); f.storage.data.requests[0].expiresAt = null;
  const fresh = new BridgeService({ storage: f.storage, transport: f.transport }); await assert.rejects(fresh.state(), errorCode('INVALID_STORAGE'));
});
test('first terminal decision wins and cannot be reset by later cancellation or denial', async () => {
  const f = fixture(), r = await ready(f); await f.service.terminate(r.id, 'denied'); await f.service.terminate(r.id);
  assert.equal(f.storage.data.requests[0].state, 'denied'); await f.service.bind({ kind: 'mock', id: 'new-bind', label: 'Mock' });
  await assert.rejects(f.service.send(r.id, 'harmless'), errorCode('DENIED'));
});
test('12 request budget is cumulative across new bindings; no automatic loop or budget reset', async () => {
  const f = fixture(); await f.service.bind({ kind: 'mock', id: 'mock', label: 'Mock' });
  for (let i = 0; i < LIMITS.requests; i++) { const r = await f.service.prepare('harmless'); await f.service.terminate(r.id); }
  await f.service.bind({ kind: 'mock', id: 'other', label: 'Other' }); await assert.rejects(f.service.prepare('harmless'), errorCode('BUDGET_EXHAUSTED'));
  assert.equal(f.observed.writes, 0);
});
test('mock trial is available once and performs no second write on a repeat or restart', async () => {
  const f = fixture(); assert.equal((await f.service.mockTrial()).codexDelivered, false);
  await assert.rejects(f.service.mockTrial(), errorCode('MOCK_TRIAL_USED'));
  const fresh = new BridgeService({ storage: f.storage, transport: f.transport, now: () => 1003 });
  await assert.rejects(fresh.mockTrial(), errorCode('MOCK_TRIAL_USED')); assert.equal(f.observed.writes, 1);
});
test('UTF-8 and serialized packet limits reject oversize input before storing a request', async () => {
  const f = fixture(); await f.service.bind({ kind: 'mock', id: 'mock', label: 'Mock' });
  await assert.rejects(f.service.prepare('한'.repeat(2000)), errorCode('INVALID_TEXT'));
  await assert.rejects(f.service.prepare('a' + '\u0000'.repeat(4000)), errorCode('INVALID_TEXT'));
  assert.equal(f.storage.data.requests.length, 0); assert.equal(f.observed.writes, 0);
});
for (const action of ['cancel', 'stop']) {
  test(`${action} persistence failure closes and promptly settles hung work without permitting any late effect`, async () => {
    const f = fixture(), r = await ready(f), gate = deferred(), started = deferred();
    f.transport.validate = async binding => { started.resolve(); await gate.promise; return { kind: binding.kind, bindingId: binding.id }; };
    const pending = f.service.send(r.id, 'harmless').catch(error => error.code); await started.promise; f.storage.failWrites = true;
    await assert.rejects(action === 'stop' ? f.service.stop() : f.service.terminate(r.id), errorCode('STORAGE_FAILED'));
    assert.equal(await bounded(pending), 'STORAGE_FAILED'); assert.equal(f.storage.data.requests[0].state, 'reserved');
    f.storage.failWrites = false; gate.resolve(); await delay(0); assert.equal(f.observed.writes, 0);
    const fresh = new BridgeService({ storage: f.storage, transport: f.transport, now: () => 1003 });
    assert.equal((await fresh.state()).requests[0].state, 'unknown');
  });
}
test('a colliding request ID is rejected without replacing a terminal record', async () => {
  const f = fixture(); f.service.random = () => 'fixed-id'; const r = await ready(f); await f.service.terminate(r.id);
  await assert.rejects(f.service.prepare('new'), errorCode('INVALID_REQUEST_ID'));
  assert.equal(f.storage.data.requests.length, 1); assert.equal(f.storage.data.requests[0].state, 'cancelled');
});
