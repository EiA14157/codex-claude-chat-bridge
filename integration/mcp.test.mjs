import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { Relay } from '../src/core.mjs';

// Fail visibly if the SDK dependency was not installed; never count a skip as a pass.
await import('@modelcontextprotocol/sdk/server/index.js');
const root = resolve(import.meta.dirname, '..');
class FakeMcpClient {
  constructor(db, role, modeArgs = ['--allow-simulation'], nodeArgs = []) {
    this.events = []; this.responses = new Map(); this.nextId = 0; this.stderr = '';
    this.process = spawn(process.execPath, [...nodeArgs, 'src/mcp.mjs', '--db', db, '--pair', 'test',
      '--role', role, '--target', `sim-${role}`, ...modeArgs], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.stderr.on('data', chunk => { this.stderr += chunk; });
    createInterface({ input: this.process.stdout }).on('line', line => {
      let value;
      try { value = JSON.parse(line); } catch { this.events.push({ invalidStdout: line }); return; }
      if (Object.hasOwn(value, 'id')) {
        const callback = this.responses.get(value.id);
        if (callback) { this.responses.delete(value.id); callback(value); }
      } else this.events.push(value);
    });
  }
  notify(method) { this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`); }
  request(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.responses.delete(id); reject(new Error(`MCP timeout: ${method}; ${this.stderr}`)); }, 5000);
      this.responses.set(id, result => { clearTimeout(timeout); resolve(result); });
      this.process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async initialize(ready = true) {
    const response = await this.request('initialize', { protocolVersion: '2025-11-25',
      capabilities: {}, clientInfo: { name: 'local-fake-client', version: '0.1.0' } });
    assert.equal(response.result.protocolVersion, '2025-11-25');
    if (ready) this.notify('notifications/initialized');
    return response.result;
  }
  async call(name, args = {}) {
    const response = await this.request('tools/call', { name, arguments: args });
    assert.ok(response.result, JSON.stringify(response));
    return { ...response.result, data: JSON.parse(response.result.content[0].text) };
  }
  async event(method) {
    for (let i = 0; i < 100; i++) {
      const found = this.events.find(e => e.method === method);
      if (found) return found;
      await delay(20);
    }
    throw new Error(`Missing ${method}; ${this.stderr}`);
  }
  async close() {
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    this.process.stdin.end();
    for (let i = 0; i < 50 && this.process.exitCode === null; i++) await delay(20);
    if (this.process.exitCode === null) {
      this.process.kill();
      for (let i = 0; i < 100 && this.process.exitCode === null && this.process.signalCode === null; i++) await delay(20);
      assert.ok(this.process.exitCode !== null || this.process.signalCode !== null, 'Fixture child did not exit after cleanup');
    }
  }
}

function setup(t, mode = 'simulation') {
  const directory = mkdtempSync(join(tmpdir(), 'bridge MCP 한글-')), db = join(directory, 'state.sqlite');
  const relay = new Relay(db);
  relay.createPair({ id: 'test', mode, codex: 'sim-codex', claude: 'sim-claude' });
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); relay.close(); rmSync(directory, { recursive: true, force: true }); });
  return { relay, db, start: (role, args, nodeArgs) => { const client = new FakeMcpClient(db, role, args, nodeArgs); clients.push(client); return client; } };
}

test('official SDK stdio: initialized gating, Claude notifications, explicit two-way tools', async t => {
  const { relay, start } = setup(t);
  const claude = start('claude'), codex = start('codex');
  const capabilities = (await claude.initialize(false)).capabilities;
  assert.deepEqual(capabilities.experimental['claude/channel'], {});
  assert.equal(capabilities.experimental['claude/channel/permission'], undefined);
  await codex.initialize();
  const text = '무해한 테스트 "한글"\nCompare options if useful.';
  const first = await codex.call('bridge_send', { clientId: 'first', text });
  assert.equal(first.data.status, 'queued');
  await delay(350);
  assert.equal(claude.events.length, 0, 'Nothing emitted before notifications/initialized');
  claude.notify('notifications/initialized');
  const event = await claude.event('notifications/claude/channel');
  assert.equal(event.params.meta.message_id, first.data.id);
  assert.equal(event.params.meta.simulation, 'true');
  assert.equal(JSON.parse(event.params.content.split('\n').at(-1)).text, text);
  // The other process can read the notification while its guarded finish is still in progress.
  // Require the durable final transport state within a bound, rather than accepting dispatching.
  const finishDeadline = Date.now() + 2000;
  while (relay.message(first.data.id).status === 'dispatching' && Date.now() < finishDeadline) await delay(10);
  assert.equal(relay.message(first.data.id).status, 'unconfirmed');
  assert.equal((await claude.call('bridge_ack', { messageId: first.data.id })).data.status, 'acknowledged');
  const reply = await claude.call('bridge_send', { clientId: 'reply', text: 'Here is one trade-off.', inReplyTo: first.data.id });
  assert.equal(reply.data.status, 'queued');
  const received = await codex.call('bridge_receive_simulated');
  assert.equal(received.data.messageId, reply.data.id);
  assert.match(received.data.content, /UNTRUSTED DATA/);
  assert.equal((await codex.call('bridge_ack', { messageId: reply.data.id })).data.status, 'acknowledged');
  assert.equal(relay.status('test').counts.acknowledged, 2);
  const spoof = await codex.call('bridge_send', { clientId: 'spoof', text: 'x', sender: 'claude' });
  assert.equal(spoof.isError, true);
  assert.equal(spoof.data.code, 'INVALID_INPUT');
  const approval = await claude.call('bridge_approve', { messageId: first.data.id });
  assert.equal(approval.isError, true);
  assert.equal(approval.data.code, 'UNKNOWN_TOOL');
  assert.ok(!claude.events.some(e => e.invalidStdout));
  assert.ok(!codex.events.some(e => e.invalidStdout));
});

test('live pair refuses MCP startup even with simulation flag', async t => {
  const { start } = setup(t, 'live'); const client = start('claude');
  for (let i = 0; i < 100 && client.process.exitCode === null; i++) await delay(20);
  assert.equal(client.process.exitCode, 2);
  assert.match(client.stderr, /CODEX_GUI_UNAVAILABLE/);
  assert.equal(client.events.length, 0);
});

test('simulation MCP requires explicit startup opt-in', async t => {
  const { start } = setup(t); const client = start('codex', []);
  for (let i = 0; i < 100 && client.process.exitCode === null; i++) await delay(20);
  assert.equal(client.process.exitCode, 2);
  assert.match(client.stderr, /SIMULATION_OPT_IN_REQUIRED/);
});

test('stdio EOF exits naturally without a lingering polling interval', async t => {
  const { start } = setup(t); const client = start('claude');
  await client.initialize();
  client.process.stdin.end();
  for (let i = 0; i < 100 && client.process.exitCode === null; i++) await delay(20);
  assert.equal(client.process.exitCode, 0, `Client EOF did not exit naturally: ${client.stderr}`);
  assert.equal(client.process.signalCode, null);
});

test('unsafe lease-release failure still closes SDK transport and exits naturally on EOF', async t => {
  const { db, start } = setup(t);
  const preload = join(dirname(db), 'mock-release-failure.mjs');
  writeFileSync(preload, `import { Relay, BridgeError } from ${JSON.stringify(pathToFileURL(join(root, 'src/core.mjs')).href)};\n` +
    `Relay.prototype.release = function () { throw new BridgeError('UNSAFE_PATH', 'synthetic path change'); };\n`);
  const client = start('claude', ['--allow-simulation'], ['--import', pathToFileURL(preload).href]);
  await client.initialize(); client.process.stdin.end();
  for (let i = 0; i < 100 && client.process.exitCode === null; i++) await delay(20);
  assert.equal(client.process.exitCode, 1, client.stderr);
  assert.equal(client.process.signalCode, null);
  assert.match(client.stderr, /bridge cleanup: UNSAFE_PATH/);
});

test('unsupported 2026 MCP revision negotiates the Claude-compatible pinned revision', async t => {
  const { start } = setup(t); const client = start('claude');
  const response = await client.request('initialize', { protocolVersion: '2026-07-28',
    capabilities: {}, clientInfo: { name: 'local-fake-client', version: '0.1.0' } });
  assert.equal(response.result.protocolVersion, '2025-11-25');
  client.notify('notifications/initialized');
});
