import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RoomStore } from '../rooms/store.mjs';

const server = new URL('../rooms/mcp.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

async function connect(db) {
  const client = new Client({ name: 'fake-agent', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server, '--db', db] }));
  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const value = JSON.parse(r.content[0].text);
    if (r.isError) throw Object.assign(new Error(value.message), { code: value.error });
    return value;
  };
  return { client, call };
}

test('two MCP server processes relay a conversation through a room', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rooms-mcp-'));
  const db = join(dir, 'rooms.sqlite');
  const store = new RoomStore(db); const { code } = store.createRoom({ topic: 'mcp test' }); store.close();
  const claude = await connect(db), codex = await connect(db);
  t.after(async () => { await claude.client.close(); await codex.client.close(); rmSync(dir, { recursive: true, force: true }); });

  const tools = (await claude.client.listTools()).tools.map(t => t.name).sort();
  assert.deepEqual(tools, ['bridge_join', 'bridge_leave', 'bridge_send', 'bridge_status', 'bridge_wait']);
  assert.match(claude.client.getInstructions(), /untrusted/);

  const a = await claude.call('bridge_join', { code, name: 'claude-code' });
  const b = await codex.call('bridge_join', { code, name: 'codex' });
  assert.equal(b.peer.name, 'claude-code');

  const waiting = claude.call('bridge_wait', { token: a.token, timeoutSec: 10 });
  await codex.call('bridge_send', { token: b.token, text: '안녕, 나는 Codex야' });
  const got = await waiting;
  assert.equal(got.messages[0].text, '안녕, 나는 Codex야');
  assert.equal(got.messages[0].trust, 'external_untrusted_peer_text');

  await claude.call('bridge_send', { token: a.token, text: 'hi', replyTo: got.messages[0].id });
  assert.equal((await codex.call('bridge_wait', { token: b.token, timeoutSec: 2 })).messages[0].from, 'claude-code');
  await assert.rejects(codex.call('bridge_status', { token: 'nope' }), { code: 'INVALID_TOKEN' });
  await claude.call('bridge_leave', { token: a.token });
  assert.equal((await codex.call('bridge_wait', { token: b.token, timeoutSec: 2 })).peerLeft, true);
});
