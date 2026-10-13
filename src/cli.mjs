#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay, dispatchOne } from './core.mjs';
import { SimulationAdapter } from './adapters.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  db: { type: 'string' }, pair: { type: 'string' }, mode: { type: 'string', default: 'live' },
  codex: { type: 'string' }, claude: { type: 'string' },
  'max-messages': { type: 'string' }, 'max-bytes': { type: 'string' },
  'max-hops': { type: 'string' }, 'lifetime-seconds': { type: 'string' },
  help: { type: 'boolean', short: 'h' }
} });
const help = `codex-claude-chat-bridge (local prototype)

  node src/cli.mjs demo
  node src/cli.mjs init --db FILE --pair ID --codex ID --claude ID [--mode live|simulation]
  node src/cli.mjs status|pause|resume|stop --db FILE --pair ID

Optional init limits: --max-messages 12 --max-bytes 16384 --max-hops 8 --lifetime-seconds 1800
Live pairs fail closed. No verified existing Codex GUI adapter is available.
Simulation does not launch or message Codex, Claude, or any paid API.
`;
async function demo() {
  const directory = mkdtempSync(join(tmpdir(), 'chat-bridge-demo-'));
  const relay = new Relay(join(directory, 'demo.sqlite'));
  try {
    relay.createPair({ id: 'demo', codex: 'sim-codex-chat', claude: 'sim-claude-session', mode: 'simulation' });
    const claude = new SimulationAdapter('sim-claude-session');
    const codex = new SimulationAdapter('sim-codex-chat');
    console.log('SIMULATION ONLY — no live app/session or paid API is contacted.');
    const first = relay.send({ pairId: 'demo', sender: 'codex', targetId: 'sim-claude-session',
      clientId: 'demo-1', text: 'Can you compare the two approaches? Reply only if useful.' });
    const there = await dispatchOne(relay, 'demo', 'claude', 'sim-claude-session', 'demo-claude-worker', claude);
    console.log(`Codex → Claude: ${there.status} (${there.id})`);
    relay.send({ pairId: 'demo', sender: 'claude', targetId: 'sim-codex-chat', clientId: 'demo-2',
      text: 'Here is a trade-off to consider. You choose the next step.', inReplyTo: first.id });
    const back = await dispatchOne(relay, 'demo', 'codex', 'sim-codex-chat', 'demo-codex-worker', codex);
    console.log(`Claude → Codex: ${back.status} (${back.id})`);
    const duplicate = relay.send({ pairId: 'demo', sender: 'codex', targetId: 'sim-claude-session',
      clientId: 'demo-1', text: 'Can you compare the two approaches? Reply only if useful.' });
    console.log(`Same-key retry: duplicate=${duplicate.duplicate}; total messages=${relay.list('demo').length}`);
    relay.control('demo', 'pause');
    console.log(`Pause: ${relay.status('demo').pair.status}`);
    relay.control('demo', 'resume');
    relay.control('demo', 'stop');
    console.log(`Stop: ${relay.status('demo').pair.status}`);
    relay.createPair({ id: 'live-check', codex: 'existing-desktop-chat', claude: 'existing-claude-session', mode: 'live' });
    try {
      relay.send({ pairId: 'live-check', sender: 'claude', targetId: 'existing-desktop-chat', clientId: 'blocked', text: 'Must not leave the relay.' });
    } catch (error) { console.log(`Live GUI guard: ${error.code} (expected; zero live messages sent)`); }
  } finally { relay.close(); rmSync(directory, { recursive: true, force: true }); }
}
try {
  const command = positionals[0];
  if (values.help || !command) console.log(help);
  else if (command === 'demo') await demo();
  else {
    if (!values.db || !values.pair) throw new Error('--db and --pair are required.');
    if (!['init', 'status', 'pause', 'resume', 'stop'].includes(command)) throw new Error('Unknown command. Use --help.');
    const relay = new Relay(values.db);
    try {
      let result;
      if (command === 'init') {
        const number = key => values[key] === undefined ? undefined : Number(values[key]);
        result = relay.createPair({ id: values.pair, codex: values.codex, claude: values.claude, mode: values.mode,
          maxMessages: number('max-messages'), maxBytes: number('max-bytes'), maxHops: number('max-hops'),
          lifetimeSeconds: number('lifetime-seconds') });
      } else if (command === 'status') result = relay.status(values.pair);
      else result = relay.control(values.pair, command);
      console.log(JSON.stringify(result, null, 2));
    } finally { relay.close(); }
  }
} catch (error) {
  console.error(`${error.code ?? 'ERROR'}: ${error.message}`);
  process.exitCode = 1;
}
