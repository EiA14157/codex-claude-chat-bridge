import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, relative, isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareExchange, emitExchange, recordExchangeReply, dispatchExchangeReturn,
  exchangeRoot, exchangeTargets } from '../src/one-shot-exchange.mjs';

const code = expected => error => error.code === expected;
const failure = value => Object.assign(new Error('synthetic callback failure'), { code: value });
const verified = () => ({ targetId: exchangeTargets.codex, hostId: 'local', simulation: false });
function ready(t, lifetimeMs = 10000) {
  const nonce = `lifecycle-${randomUUID()}`;
  const f = prepareExchange({ nonce, sourceTurnId: 'synthetic-turn', sourceMessageId: 'synthetic-message',
    sourceText: `CODEX_TO_CLAUDE:${nonce}`, now: 1000, lifetimeMs });
  const receipt = { requestId: f.requestId, nonce, text: `CLAUDE_TO_CODEX:${f.requestId}` };
  emitExchange(f.path, exchangeTargets.claude, () => {}, { now: 1001 });
  recordExchangeReply(f.path, exchangeTargets.claude, receipt, { now: 1002 });
  f.observation = { ...receipt, sourceSessionId: exchangeTargets.claude, operatorObservedReceipt: true };
  t.after(() => {
    const dir = resolve(dirname(f.path)), rel = relative(exchangeRoot, dir);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return f;
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(failure('TEST_WATCHDOG')), 1000);
  })]); } finally { clearTimeout(timer); }
}

test('N1 final guard is consumed before the first callback effect', async t => {
  const f = ready(t); let writes = 0;
  await dispatchExchangeReturn(f.path, f.observation, {
    validateTarget: async () => verified(),
    deliver: async (_, { beforeWrite }) => {
      beforeWrite(); writes++;
      assert.throws(beforeWrite, code('DELIVERY_ABORTED'));
      return { status: 'unconfirmed' };
    }
  }, { now: 1003 });
  assert.equal(writes, 1);
});

for (const outcome of ['success', 'unknown-failure', 'invalid-receipt']) {
  test(`N1 a retained guard closes after ${outcome}, including unconsumed guards on failure`, async t => {
    const f = ready(t); let guard, writes = 0;
    const pending = dispatchExchangeReturn(f.path, f.observation, {
      validateTarget: async () => verified(),
      deliver: async (_, { beforeWrite }) => {
        guard = beforeWrite;
        if (outcome === 'unknown-failure') throw failure('HOST_FAILED');
        if (outcome === 'invalid-receipt') return { status: 'acknowledged' };
        beforeWrite(); writes++; return { status: 'unconfirmed' };
      }
    }, { now: 1003 });
    if (outcome === 'success') await pending;
    else await assert.rejects(pending, code(outcome === 'unknown-failure' ? 'HOST_FAILED' : 'INVALID_RECEIPT'));
    assert.throws(guard, code('DELIVERY_ABORTED'));
    assert.equal(writes, outcome === 'success' ? 1 : 0);
  });
}

for (const denial of ['PERMISSION_DENIED', 'DENIED', 'LIVE_NOT_AUTHORIZED', 'REQUEST_DENIED']) {
  test(`N2 ${denial} during initial validation survives a fresh mock host`, async t => {
    const f = ready(t); let validations = 0;
    await assert.rejects(dispatchExchangeReturn(f.path, f.observation, {
      validateTarget: async () => { throw failure(denial); }, deliver: async () => assert.fail()
    }, { now: 1003 }), code(denial));
    assert.equal(JSON.parse(fs.readFileSync(f.path + '.terminal.json', 'utf8')).state, 'denied');
    await assert.rejects(dispatchExchangeReturn(f.path, f.observation, {
      validateTarget: async () => { validations++; return verified(); }, deliver: async () => assert.fail()
    }, { now: 1004 }), code('REQUEST_DENIED'));
    assert.equal(validations, 0);
  });
}

for (const phase of ['validation', 'delivery']) {
  test(`N3 cancellation promptly settles hung ${phase}, persists and closes later callbacks`, async t => {
    const f = ready(t), abort = new AbortController(); let release, guard, childSignal, writes = 0;
    const started = new Promise(start => {
      f.adapter = {
        validateTarget: (_, { signal }) => {
          childSignal = signal;
          if (phase === 'delivery') return Promise.resolve(verified());
          return new Promise(r => { release = r; start(); });
        },
        deliver: (_, { beforeWrite, signal }) => {
          guard = beforeWrite; childSignal = signal;
          return new Promise(r => { release = r; start(); });
        }
      };
    });
    const pending = dispatchExchangeReturn(f.path, f.observation, f.adapter, { now: 1003, signal: abort.signal });
    const outcome = pending.catch(error => error.code);
    await started; abort.abort();
    assert.equal(await bounded(outcome), 'CANCELLED');
    assert.ok(childSignal.aborted);
    assert.equal(JSON.parse(fs.readFileSync(f.path + '.terminal.json', 'utf8')).state, 'cancelled');
    await assert.rejects(dispatchExchangeReturn(f.path, f.observation, {
      validateTarget: async () => verified(), deliver: async () => { writes++; }
    }, { now: 1004 }), code('CANCELLED'));
    if (guard) assert.throws(guard, code('DELIVERY_ABORTED'));
    release(phase === 'validation' ? verified() : { status: 'unconfirmed' });
    await delay(0); assert.equal(writes, 0);
  });
}

for (const [lifetime, now, expected] of [[10000, 10990, 'EXPIRED'], [7200000, 300991, 'EXECUTION_EXPIRED']]) {
  test(`N3 ${expected} bounds a hung delivery and blocks its retained guard and retry`, async t => {
    const f = ready(t, lifetime); let release, guard, childSignal;
    const adapter = { validateTarget: async () => verified(), deliver: (_, options) => {
      guard = options.beforeWrite; childSignal = options.signal;
      return new Promise(r => { release = r; });
    } };
    await assert.rejects(bounded(dispatchExchangeReturn(f.path, f.observation, adapter, { now })), code(expected));
    assert.ok(childSignal.aborted); assert.throws(guard, code('DELIVERY_ABORTED'));
    await assert.rejects(dispatchExchangeReturn(f.path, f.observation, adapter, { now }), code('ALREADY_ATTEMPTED'));
    release({ status: 'unconfirmed' }); await delay(0);
  });
}

test('N3 reservation excludes a second host while the first validation still hangs', async t => {
  const f = ready(t), abort = new AbortController(); let release, secondReads = 0;
  const pending = dispatchExchangeReturn(f.path, f.observation, {
    validateTarget: () => new Promise(r => { release = r; }), deliver: async () => assert.fail()
  }, { now: 1003, signal: abort.signal }).catch(error => error.code);
  assert.ok(fs.existsSync(f.path + '.return-dispatch'));
  await assert.rejects(dispatchExchangeReturn(f.path, f.observation, {
    validateTarget: async () => { secondReads++; return verified(); }, deliver: async () => assert.fail()
  }, { now: 1003 }), code('ALREADY_ATTEMPTED'));
  assert.equal(secondReads, 0); abort.abort(); assert.equal(await bounded(pending), 'CANCELLED');
  release(verified()); await delay(0);
});

test('N3 a pre-aborted request persists without invoking any host callback', async t => {
  const f = ready(t), abort = new AbortController(); abort.abort();
  await assert.rejects(dispatchExchangeReturn(f.path, f.observation, {
    validateTarget: async () => assert.fail(), deliver: async () => assert.fail()
  }, { now: 1003, signal: abort.signal }), code('CANCELLED'));
  assert.ok(!fs.existsSync(f.path + '.return-dispatch'));
  assert.equal(JSON.parse(fs.readFileSync(f.path + '.terminal.json', 'utf8')).state, 'cancelled');
});

test('N3 host ABORT_ERR persists cancellation in the same lifecycle as denial', async t => {
  const f = ready(t);
  await assert.rejects(dispatchExchangeReturn(f.path, f.observation, {
    validateTarget: async () => { throw failure('ABORT_ERR'); }, deliver: async () => assert.fail()
  }, { now: 1003 }), code('ABORT_ERR'));
  assert.equal(JSON.parse(fs.readFileSync(f.path + '.terminal.json', 'utf8')).state, 'cancelled');
});

test('N3 caller abort listener is removed after completed dispatch', async t => {
  const f = ready(t), abort = new AbortController(); let removed = 0, added = 0;
  const signal = abort.signal, add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => { added++; return add(...args); };
  signal.removeEventListener = (...args) => { removed++; return remove(...args); };
  await dispatchExchangeReturn(f.path, f.observation, {
    validateTarget: async () => verified(), deliver: async (_, { beforeWrite }) => {
      beforeWrite(); return { status: 'unconfirmed' };
    }
  }, { now: 1003, signal });
  assert.equal(added, 1); assert.equal(removed, 1); abort.abort();
  assert.ok(!fs.existsSync(f.path + '.terminal.json'));
});
