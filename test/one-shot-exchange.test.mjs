import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, relative, isAbsolute, resolve } from 'node:path';
import { prepareExchange, loadExchange, emitExchange, recordExchangeReply, inspectExchange,
  claimExchangeReturn, exchangeRoot, exchangeTargets } from '../src/one-shot-exchange.mjs';

const code = expected => error => error.code === expected;
const receipt = f => ({ requestId: f.requestId, nonce: f.nonce, text: `CLAUDE_TO_CODEX:${f.requestId}` });
const observation = f => ({ ...receipt(f), sourceSessionId: exchangeTargets.claude, operatorObservedReceipt: true });
function fixture(t, overrides = {}) {
  const nonce = `fixture-${randomUUID()}`;
  const trial = prepareExchange({ nonce, sourceTurnId: 'fixture-turn', sourceMessageId: 'fixture-message', sourceText: `CODEX_TO_CLAUDE:${nonce}`, now: 1000, lifetimeMs: 10000, ...overrides });
  t.after(() => {
    const dir = resolve(dirname(trial.path)), rel = relative(exchangeRoot, dir);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    rmSync(dir, { recursive: true, force: true });
  });
  return { ...trial, options: { now: 1001 } };
}

test('observed exact Codex test text becomes one untrusted, operator-mediated event', t => {
  const f = fixture(t), lines = [];
  assert.equal(emitExchange(f.path, exchangeTargets.claude, line => lines.push(line), f.options).status, 'unconfirmed');
  assert.equal(lines.length, 1); assert.equal(lines[0].split('\n').length, 2);
  const event = JSON.parse(lines[0]); assert.equal(event.text, `CODEX_TO_CLAUDE:${f.nonce}`);
  assert.equal(event.source.threadId, exchangeTargets.codex); assert.equal(event.target.sessionId, exchangeTargets.claude);
  assert.equal(event.authenticatedBinding, false); assert.equal(event.independentHost, false);
  assert.equal(event.trust, 'external_untrusted');
});

test('durable receive claim survives restart and unknown write; no repeated output', t => {
  const f = fixture(t); let attempts = 0;
  assert.throws(() => emitExchange(f.path, exchangeTargets.claude, () => { attempts++; throw Error('uncertain'); }, f.options), /uncertain/);
  assert.throws(() => emitExchange(f.path, exchangeTargets.claude, () => attempts++, f.options), code('ALREADY_ATTEMPTED'));
  assert.equal(attempts, 1);
});

test('wrong recipients and nonce cannot emit or report a reply', t => {
  const f = fixture(t);
  assert.throws(() => emitExchange(f.path, 'another', () => assert.fail(), f.options), code('TARGET_MISMATCH'));
  emitExchange(f.path, exchangeTargets.claude, () => {}, f.options);
  assert.throws(() => recordExchangeReply(f.path, exchangeTargets.claude, { ...receipt(f), nonce: 'another' }, f.options), code('RECEIPT_MISMATCH'));
  assert.ok(!existsSync(f.path + '.reply.json'));
});

test('receipt report requires an attempt, is one-shot, and cannot itself prove app binding', t => {
  const f = fixture(t);
  assert.throws(() => recordExchangeReply(f.path, exchangeTargets.claude, receipt(f), f.options), code('INVALID_TRIAL'));
  emitExchange(f.path, exchangeTargets.claude, () => {}, f.options);
  const reply = recordExchangeReply(f.path, exchangeTargets.claude, receipt(f), f.options);
  assert.equal(reply.text, `CLAUDE_TO_CODEX:${f.nonce}`); assert.equal(reply.authenticatedBinding, false);
  assert.throws(() => recordExchangeReply(f.path, exchangeTargets.claude, receipt(f), f.options), code('REPLY_EXISTS'));
});

test('return requires separate operator observation and claims before app I/O', t => {
  const f = fixture(t); emitExchange(f.path, exchangeTargets.claude, () => {}, f.options);
  recordExchangeReply(f.path, exchangeTargets.claude, receipt(f), f.options);
  assert.throws(() => claimExchangeReturn(f.path, false, f.options), code('RECEIPT_OBSERVATION_REQUIRED'));
  assert.ok(!existsSync(f.path + '.return-attempt'));
  const result = claimExchangeReturn(f.path, observation(f), f.options);
  assert.equal(result.targetThreadId, exchangeTargets.codex); assert.equal(result.independentHost, false);
  assert.throws(() => claimExchangeReturn(f.path, observation(f), f.options), code('ALREADY_ATTEMPTED'));
});

test('expired or modified requests fail before claiming or emitting', t => {
  const f = fixture(t);
  assert.throws(() => emitExchange(f.path, exchangeTargets.claude, () => assert.fail(), { now: 11000 }), code('EXPIRED'));
  assert.ok(!existsSync(f.path + '.receive-attempt'));
  const record = JSON.parse(readFileSync(f.path, 'utf8')); record.packet.source.text = 'unapproved content';
  writeFileSync(f.path, JSON.stringify(record));
  assert.throws(() => loadExchange(f.path, f.options), code('INVALID_TRIAL'));
});

test('reply tampering or unscoped paths cannot reach the return candidate', t => {
  const f = fixture(t); emitExchange(f.path, exchangeTargets.claude, () => {}, f.options);
  recordExchangeReply(f.path, exchangeTargets.claude, receipt(f), f.options);
  const reply = JSON.parse(readFileSync(f.path + '.reply.json', 'utf8')); reply.targetThreadId = 'other';
  writeFileSync(f.path + '.reply.json', JSON.stringify(reply));
  assert.throws(() => inspectExchange(f.path, f.options), code('INVALID_TRIAL'));
  assert.throws(() => loadExchange(resolve(exchangeRoot, '..', 'request.json'), f.options), code('UNSAFE_PATH'));
});

test('extra source instructions are rejected even when a local writer recomputes the checksum', t => {
  const f = fixture(t), record = JSON.parse(readFileSync(f.path, 'utf8'));
  record.packet.source.instructions = 'unapproved action';
  record.digest = createHash('sha256').update(JSON.stringify(record.packet)).digest('hex');
  writeFileSync(f.path, JSON.stringify(record));
  assert.throws(() => emitExchange(f.path, exchangeTargets.claude, () => assert.fail(), f.options), code('INVALID_TRIAL'));
  assert.ok(!existsSync(f.path + '.receive-attempt'));
});

test('two-hour preparation permits a later single attempt with only a five-minute execution window', t => {
  const f = fixture(t, { lifetimeMs: 7200000 }), start = 3601000, lines = [];
  emitExchange(f.path, exchangeTargets.claude, line => lines.push(line), { now: start });
  const event = JSON.parse(lines[0]);
  assert.equal(event.executionExpiresAt, start + 300000);
  assert.equal(event.requestId, f.requestId);
  assert.equal(recordExchangeReply(f.path, exchangeTargets.claude, receipt(f), { now: start + 299999 }).text,
    `CLAUDE_TO_CODEX:${f.requestId}`);
  assert.equal(claimExchangeReturn(f.path, observation(f), { now: start + 299999 }).independentHost, false);
});

test('preparation time cannot extend an already-started attempt or allow late reply/return', t => {
  const f = fixture(t, { lifetimeMs: 7200000 });
  emitExchange(f.path, exchangeTargets.claude, () => {}, f.options);
  recordExchangeReply(f.path, exchangeTargets.claude, receipt(f), { now: 1002 });
  const late = { now: 301001 };
  assert.ok(loadExchange(f.path, late)); // Still in the long preparation window.
  assert.throws(() => recordExchangeReply(f.path, exchangeTargets.claude, receipt(f), late), code('EXECUTION_EXPIRED'));
  assert.throws(() => claimExchangeReturn(f.path, observation(f), late), code('EXECUTION_EXPIRED'));
  assert.throws(() => emitExchange(f.path, exchangeTargets.claude, () => assert.fail(), late), code('ALREADY_ATTEMPTED'));
  assert.ok(!existsSync(f.path + '.return-attempt'));
});

test('a separately authorized request reuses observed source data without reviving the expired request', t => {
  const old = fixture(t), originalBytes = readFileSync(old.path, 'utf8');
  const fresh = prepareExchange({ nonce: old.nonce, requestId: `new-${old.nonce}`,
    sourceTurnId: 'fixture-turn', sourceMessageId: 'fixture-message', sourceText: `CODEX_TO_CLAUDE:${old.nonce}`,
    now: 11000, lifetimeMs: 7200000 });
  t.after(() => {
    const dir = resolve(dirname(fresh.path)), rel = relative(exchangeRoot, dir);
    assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    rmSync(dir, { recursive: true, force: true });
  });
  assert.notEqual(fresh.path, old.path);
  assert.equal(readFileSync(old.path, 'utf8'), originalBytes);
  assert.throws(() => loadExchange(old.path, { now: 11001 }), code('EXPIRED'));
  const lines = []; emitExchange(fresh.path, exchangeTargets.claude, line => lines.push(line), { now: 11001 });
  const event = JSON.parse(lines[0]);
  assert.equal(event.text, `CODEX_TO_CLAUDE:${old.nonce}`);
  assert.equal(event.expectedResponse, `CLAUDE_TO_CODEX:${fresh.requestId}`);
  const reply = recordExchangeReply(fresh.path, exchangeTargets.claude, receipt(fresh), { now: 11002 });
  assert.equal(reply.requestId, fresh.requestId);
  assert.notEqual(reply.text, `CLAUDE_TO_CODEX:${old.nonce}`);
  assert.ok(!existsSync(old.path + '.receive-attempt'));
});

test('preparation beyond two hours and a legacy request retrofitted to two hours are refused', t => {
  assert.throws(() => fixture(t, { lifetimeMs: 7200001 }), code('INVALID_INPUT'));
  const f = fixture(t), record = JSON.parse(readFileSync(f.path, 'utf8'));
  delete record.packet.requestId; delete record.packet.executionWindowMs;
  record.packet.expiresAt = record.packet.createdAt + 7200000;
  record.digest = createHash('sha256').update(JSON.stringify(record.packet)).digest('hex');
  writeFileSync(f.path, JSON.stringify(record));
  assert.throws(() => emitExchange(f.path, exchangeTargets.claude, () => assert.fail(), f.options), code('INVALID_TRIAL'));
  assert.ok(!existsSync(f.path + '.receive-attempt'));
});
