import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyClaudeSession } from '../src/claude-session-metadata.mjs';

const expected = { title: 'Fixture Code Chat', cwd: 'C:\\fixture-project', sessionId: 'fixture-session' };
const info = () => ({ sessionId: expected.sessionId, customTitle: expected.title, cwd: expected.cwd });
const code = value => error => error.code === value;
function readers(sessions = [info()], current = info()) {
  const calls = [];
  return { calls, sdk: {
    listSessions: async () => { calls.push('list'); return sessions; },
    getSessionInfo: async (id, options) => { calls.push({ id, options }); return current; },
    query: () => { throw new Error('must never create or resume an agent'); },
    getSessionMessages: () => { throw new Error('must never read a transcript'); }
  } };
}

test('exact official metadata is reread without querying an agent or claiming live readiness', async () => {
  const f = readers(); const result = await identifyClaudeSession(f.sdk, expected);
  assert.equal(result.sessionId, expected.sessionId); assert.equal(result.title, expected.title);
  assert.equal(result.readOnly, true); assert.equal(result.liveVerified, false);
  assert.deepEqual(f.calls, ['list', { id: expected.sessionId, options: { dir: expected.cwd } }]);
});

test('duplicate exact titles are ambiguous even across different project paths', async () => {
  const f = readers([info(), { ...info(), sessionId: 'another', cwd: 'D:\\other' }]);
  await assert.rejects(identifyClaudeSession(f.sdk, expected), code('AMBIGUOUS_TARGET'));
  assert.deepEqual(f.calls, ['list']);
});

test('no fuzzy title selection or automatic recent-session fallback', async () => {
  const f = readers([{ ...info(), customTitle: 'Fixture Code Chat 다른 대화' }]);
  await assert.rejects(identifyClaudeSession(f.sdk, expected), code('TARGET_NOT_FOUND'));
});

test('different pinned ID or project is rejected before individual lookup', async () => {
  for (const candidate of [{ ...info(), sessionId: 'another' }, { ...info(), cwd: 'D:\\other' }]) {
    const f = readers([candidate]);
    await assert.rejects(identifyClaudeSession(f.sdk, expected), code('TARGET_MISMATCH'));
    assert.deepEqual(f.calls, ['list']);
  }
});

test('disappearing or changed session metadata fails closed', async () => {
  for (const current of [undefined, { ...info(), customTitle: 'changed' }, { ...info(), cwd: 'D:\\other' }, { ...info(), sessionId: 'another' }]) {
    const f = readers([info()], current);
    // Pass undefined through explicitly, instead of the fixture default argument.
    f.sdk.getSessionInfo = async () => current;
    await assert.rejects(identifyClaudeSession(f.sdk, expected), code('SESSION_UNVERIFIED'));
  }
});

test('Windows path casing and separators preserve the same project identity', async () => {
  const f = readers([{ ...info(), cwd: 'C:/fixture-project' }], { ...info(), cwd: 'C:\\fixture-project' });
  assert.equal((await identifyClaudeSession(f.sdk, expected)).liveVerified, false);
});

test('malformed readers, paths and SDK list results are rejected', async () => {
  await assert.rejects(identifyClaudeSession({}, expected), code('INVALID_INPUT'));
  await assert.rejects(identifyClaudeSession(readers().sdk, { ...expected, cwd: 'relative' }), code('INVALID_INPUT'));
  await assert.rejects(identifyClaudeSession(readers({}).sdk, expected), code('SESSION_UNVERIFIED'));
});
