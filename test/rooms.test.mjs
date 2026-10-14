import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../rooms/store.mjs';

/** Opens n stores on one temp file; closes them before deleting it (Windows keeps open files locked). */
const tempStores = (t, n) => {
  const dir = mkdtempSync(join(tmpdir(), 'rooms-'));
  const stores = Array.from({ length: n }, () => new RoomStore(join(dir, 'rooms.sqlite')));
  t.after(() => { stores.forEach(s => s.close()); rmSync(dir, { recursive: true, force: true }); });
  return stores;
};

test('two participants exchange messages through one shared file', async t => {
  const [a, b] = tempStores(t, 2); // separate connections, like two MCP processes
  const room = a.createRoom({ topic: 'demo' });
  const claude = a.join(room.code, 'claude-code');
  assert.equal(claude.peer, null);
  assert.throws(() => a.send(claude.token, 'hi'), { code: 'NO_PEER' });
  const codex = b.join(room.code.toLowerCase(), 'codex');
  assert.equal(codex.peer.name, 'claude-code');

  const waiting = a.wait(claude.token, 5, { intervalMs: 20 });
  const sent = b.send(codex.token, 'hello from codex');
  const got = await waiting;
  assert.deepEqual(got.messages.map(m => [m.from, m.text]), [['codex', 'hello from codex']]);
  assert.equal(got.timedOut, false);

  a.send(claude.token, 'hi codex', { replyTo: sent.id });
  const back = await b.wait(codex.token, 1, { intervalMs: 20 });
  assert.equal(back.messages[0].replyTo, sent.id);
  // Already-delivered messages are not repeated.
  assert.equal((await b.wait(codex.token, 0)).messages.length, 0);
});

test('room limits: two members, unique names, budget, idempotency', () => {
  const s = new RoomStore(':memory:');
  const room = s.createRoom({ maxMessages: 2 });
  const x = s.join(room.code, 'x');
  assert.throws(() => s.join(room.code, 'x'), { code: 'NAME_TAKEN' });
  const y = s.join(room.code, 'y');
  assert.throws(() => s.join(room.code, 'z'), { code: 'ROOM_FULL' });
  const first = s.send(x.token, 'one', { clientId: 'k1' });
  assert.equal(s.send(x.token, 'one', { clientId: 'k1' }).id, first.id);
  s.send(y.token, 'two');
  assert.throws(() => s.send(x.token, 'three'), { code: 'BUDGET_EXHAUSTED' });
  s.close();
});

test('stop, expiry and leave end waits promptly', async () => {
  let clock = 1_000_000;
  const s = new RoomStore(':memory:', { now: () => clock });
  const room = s.createRoom({ minutes: 1 });
  const x = s.join(room.code, 'x'), y = s.join(room.code, 'y');
  s.leave(y.token);
  const left = await s.wait(x.token, 5, { intervalMs: 1 });
  assert.equal(left.peerLeft, true);
  assert.throws(() => s.send(y.token, 'late'), { code: 'LEFT' });

  const z = s.join(room.code, 'z'); // the freed slot can be reused
  s.stopRoom(room.code);
  assert.equal((await s.wait(x.token, 5)).room.status, 'stopped');
  assert.throws(() => s.send(z.token, 'x'), { code: 'ROOM_STOPPED' });

  const r2 = s.createRoom({ minutes: 1 });
  s.join(r2.code, 'a');
  clock += 61_000;
  assert.throws(() => s.join(r2.code, 'b'), { code: 'ROOM_EXPIRED' });
  s.close();
});

test('peer listening flag is visible while waiting', async t => {
  const [a, b] = tempStores(t, 2);
  const room = a.createRoom();
  const x = a.join(room.code, 'x'), y = b.join(room.code, 'y');
  assert.equal(b.peerView(room.code, y.token).listening, false);
  const w = a.wait(x.token, 2, { intervalMs: 20 });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(b.peerView(room.code, y.token).listening, true);
  b.send(y.token, 'ping');
  await w;
  assert.equal(b.peerView(room.code, y.token).listening, false);
});
