import test from 'node:test';
import assert from 'node:assert/strict';
test('MV3 entry fixture restricts storage to trusted contexts and routes visible popup commands without startup sends', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'chrome', original); else delete globalThis.chrome; });
  let listener, data, isolation, scriptCalls = 0;
  const id = 'owned-mv3-fixture', popupUrl = `chrome-extension://${id}/popup.html`;
  globalThis.chrome = {
    runtime: { id, getURL: name => `chrome-extension://${id}/${name}`, onMessage: { addListener: fn => { listener = fn; } } },
    storage: { local: {
      setAccessLevel: async value => { isolation = value; }, get: async () => ({ bridge: data }), set: async value => { data = structuredClone(value.bridge); }
    } }, scripting: { executeScript: async () => { scriptCalls++; throw Error('No page access expected'); } }
  };
  await import('../extension/background.mjs?entry-fixture');
  assert.deepEqual(isolation, { accessLevel: 'TRUSTED_CONTEXTS' }); assert.equal(scriptCalls, 0);
  const command = (message, sender = { id, url: popupUrl }) => new Promise(resolve => { assert.equal(listener(message, sender, resolve), true); });
  assert.deepEqual(await command({ type: 'state' }, { id, url: 'https://foreign.example' }), { ok: false, code: 'DENIED' });
  assert.equal((await command({ type: 'state' })).value.stopped, true);
  const trial = await command({ type: 'mockTrial' }); assert.equal(trial.ok, true); assert.equal(trial.value.codexDelivered, false);
  assert.match(trial.value.text, /^BRIDGE_ACK:/); assert.equal(scriptCalls, 0);
  assert.deepEqual(await command({ type: 'mockTrial' }), { ok: false, code: 'MOCK_TRIAL_USED' });
});
