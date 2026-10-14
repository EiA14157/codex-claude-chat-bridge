import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectClaudeChildCapabilities } from '../src/claude-live-capabilities.mjs';

const session = '11111111-1111-4111-8111-111111111111';
test('missing session environment remains read-only and cannot enable a live route', () => {
  const result = inspectClaudeChildCapabilities({}, session);
  assert.equal(result.socketAdvertised, false); assert.equal(result.sessionTokenAdvertised, false);
  assert.equal(result.sessionBindingVerified, false); assert.equal(result.liveSendEnabled, false);
});

test('advertised socket and token never escape and do not certify an identity', () => {
  const result = inspectClaudeChildCapabilities({
    CLAUDE_CODE_MESSAGING_SOCKET: 'fixture-private-socket-address',
    CLAUDE_CODE_MESSAGING_TOKEN: 'fixture-secret-token',
    ANTHROPIC_API_KEY: 'fixture-unrelated-secret'
  }, session);
  const serialized = JSON.stringify(result);
  assert.equal(result.socketAdvertised, true); assert.equal(result.sessionTokenAdvertised, true);
  assert.equal(result.readOnly, true); assert.equal(result.sessionBindingVerified, false);
  assert.equal(result.liveSendEnabled, false);
  for (const value of ['fixture-private-socket-address', 'fixture-secret-token', 'fixture-unrelated-secret'])
    assert.ok(!serialized.includes(value));
});

test('the probe never enumerates unrelated environment variables', () => {
  const env = { CLAUDE_CODE_MESSAGING_SOCKET: '', CLAUDE_CODE_MESSAGING_TOKEN: '' };
  Object.defineProperty(env, 'UNRELATED_AUTH', { enumerable: true, get() { throw new Error('must not read'); } });
  assert.equal(inspectClaudeChildCapabilities(env, session).sessionTokenAdvertised, false);
});

test('invalid session identifiers and environment shapes are rejected', () => {
  assert.throws(() => inspectClaudeChildCapabilities({}, 'another-target'));
  assert.throws(() => inspectClaudeChildCapabilities([], session));
  assert.throws(() => inspectClaudeChildCapabilities(null, session));
});
