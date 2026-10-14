import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, relative, isAbsolute, resolve, join } from 'node:path';
import { Relay, dispatchOne } from '../src/core.mjs';
import { CodexAppToolAdapter } from '../src/codex-app-tools.mjs';
import { prepareExchange, emitExchange, recordExchangeReply, claimExchangeReturn,
  terminateExchange, validateExchangeReturn, dispatchExchangeReturn, exchangeRoot, exchangeTargets } from '../src/one-shot-exchange.mjs';

const code = expected => error => error.code === expected;
function trial(t, overrides = {}) {
  const nonce = `regression-${randomUUID()}`;
  const f = prepareExchange({ nonce, sourceTurnId: 'mock-turn', sourceMessageId: 'mock-message',
    sourceText: `CODEX_TO_CLAUDE:${nonce}`, now: 1000, lifetimeMs: 10000, ...overrides });
  t.after(() => {
    const dir = resolve(dirname(f.path)), rel = relative(exchangeRoot, dir);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  f.receipt = { requestId: f.requestId, nonce: f.nonce, text: `CLAUDE_TO_CODEX:${f.requestId}` };
  f.observation = { ...f.receipt, sourceSessionId: exchangeTargets.claude, operatorObservedReceipt: true };
  return f;
}
function ready(t) {
  const f = trial(t); emitExchange(f.path, exchangeTargets.claude, () => {}, { now: 1001 });
  recordExchangeReply(f.path, exchangeTargets.claude, f.receipt, { now: 1002 });
  return f;
}
function mockHost(overrides = {}) {
  const writes = [];
  const adapter = new CodexAppToolAdapter({ threadId: exchangeTargets.codex, hostId: 'local',
    readThread: async () => ({ thread: { id: exchangeTargets.codex, hostId: 'local', kind: 'codex', status: { type: 'idle' } } }),
    authorizeSend: async () => true,
    sendMessageToThread: async args => { writes.push(args); return { accepted: true }; }, ...overrides });
  return { adapter, writes };
}
function interceptWrite(match, after, run) {
  const original = fs.writeFileSync;
  fs.writeFileSync = function(file, ...args) {
    const result = original.call(this, file, ...args);
    if (String(file) === match) after();
    return result;
  };
  syncBuiltinESMExports();
  try { return run(); }
  finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
}

for (const advance of [100, 101]) {
  test(`F2 persisted deadline blocks a first write at +${advance}ms before the timer callback`, async t => {
    let now = 1000, writes = 0;
    const relay = new Relay(':memory:', { now: () => now }); t.after(() => relay.close());
    relay.createPair({ id: 'mock', mode: 'simulation', codex: 'c', claude: 'a', deliveryTimeoutMs: 100 });
    relay.send({ pairId: 'mock', sender: 'codex', targetId: 'a', clientId: 'x', text: 'mock' });
    const result = await dispatchOne(relay, 'mock', 'claude', 'a', 'owner', {
      name: 'mock', validateTarget: async () => ({ targetId: 'a', simulation: true }),
      deliver: async (_, { beforeWrite }) => { now += advance; beforeWrite(); writes++; return { status: 'unconfirmed' }; }
    });
    assert.equal(writes, 0); assert.equal(result.status, 'blocked');
  });
}

test('F2 a second pre-write guard cannot start a second transport effect', async t => {
  const relay = new Relay(':memory:'); t.after(() => relay.close());
  relay.createPair({ id: 'mock', mode: 'simulation', codex: 'c', claude: 'a' });
  relay.send({ pairId: 'mock', sender: 'codex', targetId: 'a', clientId: 'x', text: 'mock' });
  let writes = 0;
  await dispatchOne(relay, 'mock', 'claude', 'a', 'owner', {
    name: 'mock', validateTarget: async () => ({ targetId: 'a', simulation: true }),
    deliver: async (_, { beforeWrite }) => {
      beforeWrite(); writes++;
      assert.throws(() => beforeWrite(), code('DELIVERY_ABORTED'));
      return { status: 'unconfirmed' };
    }
  });
  assert.equal(writes, 1);
});

test('F3 default clock rechecks expiry after durable marker I/O', t => {
  const f = trial(t, { lifetimeMs: 1000 }); let now = 1001, writes = 0;
  const originalNow = Date.now; Date.now = () => now;
  try {
    interceptWrite(f.path + '.receive-attempt', () => { now = 2000; }, () => {
      assert.throws(() => emitExchange(f.path, exchangeTargets.claude, () => writes++), code('EXPIRED'));
    });
  } finally { Date.now = originalNow; }
  assert.equal(writes, 0); assert.ok(fs.existsSync(f.path + '.receive-attempt'));
  assert.throws(() => emitExchange(f.path, exchangeTargets.claude, () => writes++, { now: 1001 }), code('ALREADY_ATTEMPTED'));
});

test('F3 return claim is not authority after slow claim I/O consumes the deadline', t => {
  const f = ready(t); let now = 1003;
  interceptWrite(f.path + '.return-attempt', () => { now = 11000; }, () => {
    assert.throws(() => claimExchangeReturn(f.path, f.observation, { now: () => now }), code('EXPIRED'));
  });
  assert.ok(fs.existsSync(f.path + '.return-attempt'));
  assert.throws(() => validateExchangeReturn(f.path, f.observation, { now: () => now }), code('EXPIRED'));
});

test('F4 an aborted signal durably cancels a pending request before output', t => {
  const f = trial(t), controller = new AbortController(); controller.abort(); let writes = 0;
  assert.throws(() => emitExchange(f.path, exchangeTargets.claude, () => writes++, { now: 1001, signal: controller.signal }), code('CANCELLED'));
  assert.equal(writes, 0); assert.ok(!fs.existsSync(f.path + '.receive-attempt'));
  assert.equal(JSON.parse(fs.readFileSync(f.path + '.terminal.json', 'utf8')).state, 'cancelled');
  assert.throws(() => emitExchange(f.path, exchangeTargets.claude, () => writes++, { now: 1002 }), code('CANCELLED'));
});

for (const state of ['cancelled', 'denied']) {
  test(`F4 persisted ${state} blocks receive, reply and return across later calls`, t => {
    const f = ready(t); claimExchangeReturn(f.path, f.observation, { now: 1003 });
    terminateExchange(f.path, f.requestId, state, { now: 1004 });
    const expected = state === 'denied' ? 'REQUEST_DENIED' : 'CANCELLED';
    assert.throws(() => emitExchange(f.path, exchangeTargets.claude, () => assert.fail(), { now: 1005 }), code(expected));
    assert.throws(() => recordExchangeReply(f.path, exchangeTargets.claude, f.receipt, { now: 1005 }), code(expected));
    assert.throws(() => validateExchangeReturn(f.path, f.observation, { now: 1005 }), code(expected));
    assert.equal(terminateExchange(f.path, f.requestId, state === 'denied' ? 'cancelled' : 'denied', { now: 1006 }).state, state);
  });
}

test('F4 cancellation between receive claim and stdout leaves the claim but emits nothing', t => {
  const f = trial(t); let writes = 0;
  interceptWrite(f.path + '.receive-attempt', () => terminateExchange(f.path, f.requestId, 'cancelled', { now: 1002 }), () => {
    assert.throws(() => emitExchange(f.path, exchangeTargets.claude, () => writes++, { now: 1001 }), code('CANCELLED'));
  });
  assert.equal(writes, 0); assert.ok(fs.existsSync(f.path + '.receive-attempt'));
});

test('F4 cancellation during the final attempt-file read is checked before stdout', t => {
  const f = trial(t); let writes = 0, stopped = false;
  const original = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    const result = original.call(this, file, ...args);
    if (String(file) === f.path + '.receive-attempt' && !stopped) {
      stopped = true; terminateExchange(f.path, f.requestId, 'cancelled', { now: 1002 });
    }
    return result;
  };
  syncBuiltinESMExports();
  try { assert.throws(() => emitExchange(f.path, exchangeTargets.claude, () => writes++, { now: 1001 }), code('CANCELLED')); }
  finally { fs.readFileSync = original; syncBuiltinESMExports(); }
  assert.equal(writes, 0); assert.ok(fs.existsSync(f.path + '.receive-attempt'));
});

test('a signal abort after return claim and before host write persists cancellation', async t => {
  const f = ready(t), controller = new AbortController();
  const host = mockHost({ authorizeSend: async () => { controller.abort(); return true; } });
  await assert.rejects(dispatchExchangeReturn(f.path, f.observation, host.adapter, { now: 1003, signal: controller.signal }), code('CANCELLED'));
  assert.equal(host.writes.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.path + '.terminal.json', 'utf8')).state, 'cancelled');
});

test('cancel CLI revokes only the explicitly named mock request and persists across new processes', t => {
  const f = trial(t, { now: Date.now(), lifetimeMs: 60000 });
  const args = ['src/one-shot-exchange.mjs', 'cancel', '--file', f.path, '--request-id', f.requestId];
  const options = { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 5000 };
  const denied = spawnSync(process.execPath, [...args.slice(0, -1), 'wrong-request-id'], options);
  assert.equal(denied.status, 1); assert.ok(!fs.existsSync(f.path + '.terminal.json'));
  assert.equal(spawnSync(process.execPath, args, options).status, 0);
  const receive = spawnSync(process.execPath, ['src/one-shot-exchange.mjs', 'receive', '--file', f.path,
    '--session', exchangeTargets.claude], options);
  assert.equal(receive.status, 1); assert.match(receive.stderr, /CANCELLED/);
  assert.equal(receive.stdout, ''); assert.ok(!fs.existsSync(f.path + '.receive-attempt'));
});

test('F4 cancellation during asynchronous host authorization is checked immediately before mock send', async t => {
  const f = ready(t);
  const host = mockHost({ authorizeSend: async () => { terminateExchange(f.path, f.requestId, 'cancelled', { now: 1003 }); return true; } });
  await assert.rejects(dispatchExchangeReturn(f.path, f.observation, host.adapter, { now: 1003 }), code('CANCELLED'));
  assert.equal(host.writes.length, 0); assert.ok(fs.existsSync(f.path + '.return-attempt'));
});

test('F3 expiry during asynchronous host authorization blocks mock app I/O', async t => {
  const f = ready(t); let now = 1003;
  const host = mockHost({ authorizeSend: async () => { now = 11000; return true; } });
  await assert.rejects(dispatchExchangeReturn(f.path, f.observation, host.adapter, { now: () => now }), code('EXPIRED'));
  assert.equal(host.writes.length, 0);
});

test('F1/F4 host denial becomes a durable terminal request without an automatic retry', async t => {
  const f = ready(t); let grants = 0;
  const host = mockHost({ authorizeSend: async () => { grants++; return false; } });
  await assert.rejects(dispatchExchangeReturn(f.path, f.observation, host.adapter, { now: 1003 }), code('LIVE_NOT_AUTHORIZED'));
  await assert.rejects(dispatchExchangeReturn(f.path, f.observation, host.adapter, { now: 1004 }), code('REQUEST_DENIED'));
  assert.equal(grants, 1); assert.equal(host.writes.length, 0);
  const freshHost = mockHost({ authorizeSend: async () => { grants++; return true; } });
  await assert.rejects(dispatchExchangeReturn(f.path, f.observation, freshHost.adapter, { now: 1004 }), code('REQUEST_DENIED'));
  assert.equal(grants, 1); assert.equal(freshHost.writes.length, 0);
});

test('F5 a same-source receipt from another request cannot produce this request reply or return', t => {
  const f = trial(t); emitExchange(f.path, exchangeTargets.claude, () => {}, { now: 1001 });
  const other = { ...f.receipt, requestId: 'other-request', text: 'CLAUDE_TO_CODEX:other-request' };
  assert.throws(() => recordExchangeReply(f.path, exchangeTargets.claude, other, { now: 1002 }), code('RECEIPT_MISMATCH'));
  assert.throws(() => recordExchangeReply(f.path, exchangeTargets.claude, f.nonce, { now: 1002 }), code('INVALID_INPUT'));
  assert.ok(!fs.existsSync(f.path + '.reply.json'));
  recordExchangeReply(f.path, exchangeTargets.claude, f.receipt, { now: 1002 });
  assert.throws(() => claimExchangeReturn(f.path, { ...f.observation, ...other }, { now: 1003 }), code('RECEIPT_MISMATCH'));
  assert.throws(() => claimExchangeReturn(f.path, true, { now: 1003 }), code('RECEIPT_OBSERVATION_REQUIRED'));
  assert.ok(!fs.existsSync(f.path + '.return-attempt'));
});

test('F5 CLI rejects wrong request ID with otherwise complete exact response input', t => {
  const f = trial(t, { now: Date.now(), lifetimeMs: 60000 });
  emitExchange(f.path, exchangeTargets.claude, () => {});
  const child = spawnSync(process.execPath, ['src/one-shot-exchange.mjs', 'reply', '--file', f.path,
    '--session', exchangeTargets.claude, '--nonce', f.nonce, '--request-id', 'wrong-request-id', '--response', f.receipt.text],
    { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1); assert.match(child.stderr, /RECEIPT_MISMATCH/);
  assert.ok(!fs.existsSync(f.path + '.reply.json'));
});

test('F5 action-specific CLI options never get silently ignored', t => {
  const f = trial(t, { now: Date.now(), lifetimeMs: 60000 });
  const child = spawnSync(process.execPath, ['src/one-shot-exchange.mjs', 'receive', '--file', f.path,
    '--session', exchangeTargets.claude, '--request-id', f.requestId],
    { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1); assert.match(child.stderr, /INVALID_INPUT/);
  assert.ok(!fs.existsSync(f.path + '.receive-attempt'));
});

test('complete request-scoped CLI receipt and return claims remain usable in fake-only fixtures', t => {
  const f = trial(t, { now: Date.now(), lifetimeMs: 60000 });
  const options = { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 5000 };
  const received = spawnSync(process.execPath, ['src/one-shot-exchange.mjs', 'receive', '--file', f.path,
    '--session', exchangeTargets.claude], options);
  assert.equal(received.status, 0); const event = JSON.parse(received.stdout);
  const receiptArgs = ['--file', f.path, '--session', exchangeTargets.claude,
    '--request-id', event.requestId, '--nonce', event.nonce, '--response', event.expectedResponse];
  const replied = spawnSync(process.execPath, ['src/one-shot-exchange.mjs', 'reply', ...receiptArgs], options);
  assert.equal(replied.status, 0); assert.equal(JSON.parse(replied.stdout).text, event.expectedResponse);
  const returnArgs = ['src/one-shot-exchange.mjs', 'claim-return', ...receiptArgs, '--operator-observed-receipt'];
  const claimed = spawnSync(process.execPath, returnArgs, options);
  assert.equal(claimed.status, 0); assert.equal(JSON.parse(claimed.stdout).text, event.expectedResponse);
  assert.equal(JSON.parse(claimed.stdout).independentHost, false);
  const again = spawnSync(process.execPath, returnArgs, options);
  assert.equal(again.status, 1); assert.match(again.stderr, /ALREADY_ATTEMPTED/);
});

test('a correctly observed mock return is guarded and attempted at most once', async t => {
  const f = ready(t), host = mockHost();
  const result = await dispatchExchangeReturn(f.path, f.observation, host.adapter, { now: 1003 });
  assert.equal(result.status, 'unconfirmed'); assert.equal(host.writes.length, 1);
  assert.equal(JSON.parse(host.writes[0].prompt.split('\n').at(-1)).text, f.receipt.text);
  await assert.rejects(dispatchExchangeReturn(f.path, f.observation, host.adapter, { now: 1004 }), code('ALREADY_ATTEMPTED'));
  assert.equal(host.writes.length, 1);
});

test('a disappearing reply between claim and send is not inferred from the old claim', t => {
  const f = ready(t); claimExchangeReturn(f.path, f.observation, { now: 1003 });
  fs.unlinkSync(f.path + '.reply.json');
  assert.throws(() => validateExchangeReturn(f.path, f.observation, { now: 1004 }), code('REPLY_REQUIRED'));
});

test('F6 existing directory sidecars are rejected before a database is created', t => {
  const root = fs.mkdtempSync(join(resolve(import.meta.dirname), 'path-fixture-'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(import.meta.dirname) + '\\path-fixture-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const db = join(root, `mock${suffix}.sqlite`); fs.mkdirSync(db + suffix);
    assert.throws(() => new Relay(db), code('UNSAFE_PATH'));
    assert.ok(!fs.existsSync(db));
  }
});
