import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { RoomStore } from '../rooms/store.mjs';

const file = name => new URL(`../rooms/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const parse = r => { const v = JSON.parse(r.content[0].text); if (r.isError) throw Object.assign(new Error(v.message), { code: v.error }); return v; };
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rooms-x-'));
  const db = join(dir, 'rooms.sqlite');
  const cleanups = [];
  t.after(async () => { for (const c of cleanups.reverse()) await c(); rmSync(dir, { recursive: true, force: true }); });
  const store = new RoomStore(db); cleanups.push(() => store.close());
  return { db, store, cleanups };
}

test('--channel pushes an unread nudge (no body) only while not waiting', async t => {
  const { db, store, cleanups } = setup(t);
  const { code } = store.createRoom();
  const client = new Client({ name: 'claude-like', version: '0' });
  const nudges = [];
  client.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') nudges.push(n.params); };
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [file('mcp.mjs'), '--db', db, '--channel'] }));
  cleanups.push(() => client.close());
  assert.ok(client.getServerCapabilities().experimental['claude/channel']);

  const me = parse(await client.callTool({ name: 'bridge_join', arguments: { code, name: 'claude-code' } }));
  const peer = store.join(code, 'codex');
  store.send(peer.token, 'secret-ish body should not be in the nudge');
  const deadline = Date.now() + 8000;
  while (!nudges.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  assert.equal(nudges.length, 1);
  assert.match(nudges[0].content, new RegExp(`Bridge room ${code}: 1 unread`));
  assert.doesNotMatch(nudges[0].content, /secret-ish/);
  assert.equal(nudges[0].meta.room, code);

  const got = parse(await client.callTool({ name: 'bridge_wait', arguments: { token: me.token, timeoutSec: 1 } }));
  assert.equal(got.messages[0].text, 'secret-ish body should not be in the nudge');
  await new Promise(r => setTimeout(r, 2000));
  assert.equal(nudges.length, 1); // read messages are not re-announced
});

test('HTTP server: dashboard API needs admin key and local Host; /mcp needs remote key', async t => {
  const { db, cleanups } = setup(t);
  const port = 40000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [file('server.mjs'), '--db', db, '--port', String(port), '--remote'],
    { env: { ...process.env, BRIDGE_REMOTE_KEY: 'remote-test-key-0123456789' } });
  cleanups.push(async () => { proc.kill(); await once(proc, 'exit'); });
  let out = '';
  for await (const chunk of proc.stdout) { out += chunk; if (out.includes('Remote MCP')) break; }
  const adminKey = out.match(/#key=([\w-]+)/)[1];
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' };

  assert.equal((await fetch(`${base}/api/rooms`)).status, 401);
  assert.equal((await fetch(`${base}/`)).status, 200);
  const room = await (await fetch(`${base}/api/rooms`, { method: 'POST', headers: auth, body: JSON.stringify({ topic: 'http' }) })).json();
  assert.match(room.code, /^[A-Z2-9]{6}$/);

  // Remote agent over Streamable HTTP MCP.
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status, 401);
  const remote = new Client({ name: 'grok-like', version: '0' });
  await remote.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),
    { requestInit: { headers: { authorization: 'Bearer remote-test-key-0123456789' } } }));
  cleanups.push(() => remote.close());
  const g = parse(await remote.callTool({ name: 'bridge_join', arguments: { code: room.code, name: 'grok-bot' } }));

  // Local agent through the CLI agent commands (same tools, JSON output).
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, [file('cli.mjs'), ...args, '--db', db], { encoding: 'utf8' }));
  const c = cli('join', room.code, '--name', 'codex');
  assert.equal(c.peer.name, 'grok-bot');
  cli('send', '--token', c.token, '--text', 'hello grok');
  const w = parse(await remote.callTool({ name: 'bridge_wait', arguments: { token: g.token, timeoutSec: 3 } }));
  assert.equal(w.messages[0].text, 'hello grok');
  parse(await remote.callTool({ name: 'bridge_send', arguments: { token: g.token, text: 'hi codex' } }));
  assert.equal(cli('wait', '--token', c.token, '--timeout', '3').messages[0].from, 'grok-bot');
  // send --wait: one command sends and returns the reply (here: times out because nobody answers).
  const sw = cli('send', '--token', c.token, '--text', 'bye', '--wait', '--timeout', '1');
  assert.ok(sw.sent.id); assert.equal(sw.timedOut, true);
  assert.equal(parse(await remote.callTool({ name: 'bridge_wait', arguments: { token: g.token, timeoutSec: 1 } })).messages[0].text, 'bye');

  const detail = await (await fetch(`${base}/api/rooms/${room.code}`, { headers: auth })).json();
  assert.deepEqual(detail.messages.map(m => m.from), ['codex', 'grok-bot', 'codex']);
  assert.equal((await fetch(`${base}/api/rooms/${room.code}/stop`, { method: 'POST', headers: auth })).status, 200);
  // fetch drops custom Host headers, so use node:http to simulate a DNS-rebinding page.
  const rebound = await new Promise((resolve, reject) => request(`${base}/api/rooms`, { headers: { ...auth, host: `evil.example:${port}` } },
    res => { res.resume(); resolve(res.statusCode); }).on('error', reject).end());
  assert.equal(rebound, 401);
});
