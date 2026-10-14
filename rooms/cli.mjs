#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { RoomStore, defaultDbPath } from './store.mjs';
import { callTool } from './tools.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  db: { type: 'string' }, topic: { type: 'string' }, 'max-messages': { type: 'string' },
  minutes: { type: 'string' }, json: { type: 'boolean', default: false },
  name: { type: 'string' }, token: { type: 'string' }, text: { type: 'string' }, 'reply-to': { type: 'string' }, timeout: { type: 'string' }, 'after-seq': { type: 'string' }, wait: { type: 'boolean', default: false }, all: { type: 'boolean', default: false }
} });
const [command, code] = positionals;
const usage = `Usage:
  node rooms/cli.mjs create [--topic TEXT] [--max-messages N] [--minutes N]
  node rooms/cli.mjs list
  node rooms/cli.mjs show CODE        (transcript)
  node rooms/cli.mjs stop CODE
  node rooms/cli.mjs kick CODE NAME   (free the slot of a crashed conversation)
  node rooms/cli.mjs purge CODE | purge --all   (permanently delete rooms and their messages)
Agent commands (same as the MCP tools; JSON output, for agents that can run commands but not MCP):
  node rooms/cli.mjs join CODE --name NAME
  node rooms/cli.mjs send --token T --text TEXT [--reply-to ID] [--wait [--timeout SEC]]   (--wait: send, then wait for the reply)
  node rooms/cli.mjs wait --token T [--timeout SEC] [--after-seq N]
  node rooms/cli.mjs status|leave --token T
Options: --db FILE (default ${defaultDbPath()}, or BRIDGE_DB), --json`;

const store = new RoomStore(values.db ?? defaultDbPath());
const num = v => v === undefined ? undefined : Number(v);
const time = t => new Date(t).toLocaleTimeString();
const line = r => `${r.code}  ${r.status.padEnd(7)}  ${r.messagesUsed}/${r.maxMessages} msgs  until ${time(r.expires)}${r.topic ? '  ' + r.topic : ''}`;
try {
  let out;
  switch (command) {
    case 'create': {
      const r = store.createRoom({ topic: values.topic, maxMessages: num(values['max-messages']), minutes: num(values.minutes) });
      out = values.json ? r : `Room ${r.code} created (${r.maxMessages} messages, until ${time(r.expires)}).\n` +
        `Tell each conversation: "브리지 방 ${r.code}에 참가해" / "Join bridge room ${r.code}".`;
      break;
    }
    case 'list': { const rs = store.listRooms(); out = values.json ? rs : rs.map(line).join('\n') || 'No rooms.'; break; }
    case 'show': {
      const t = store.transcript(code);
      out = values.json ? t : [line(t.room),
        'Participants: ' + (t.participants.map(p => p.name + (p.left_at ? ' (left)' : '')).join(', ') || 'none'), '',
        ...t.messages.map(m => `[${time(m.at)}] ${m.from}: ${m.text}`)].join('\n');
      break;
    }
    case 'stop': { const r = store.stopRoom(code); out = values.json ? r : line(r); break; }
    case 'purge': {
      if (!code && !values.all) throw Object.assign(new Error('Give a room code or --all.'), { code: 'INVALID_INPUT' });
      out = store.purge(values.all ? undefined : code); break;
    }
    case 'kick': out = store.kick(code, positionals[2]); break;
    case 'join': out = await callTool(store, 'bridge_join', { code, name: values.name }); break;
    case 'send': {
      const sent = await callTool(store, 'bridge_send', { token: values.token, text: values.text, replyTo: values['reply-to'] });
      // One command per round trip halves approvals for agents that confirm every local command (Grok Bot's suggestion).
      out = values.wait ? { sent, ...(await callTool(store, 'bridge_wait', { token: values.token, timeoutSec: num(values.timeout) })) } : sent;
      break;
    }
    case 'wait': out = await callTool(store, 'bridge_wait', { token: values.token, timeoutSec: num(values.timeout), afterSeq: num(values['after-seq']) }); break;
    case 'status': case 'leave': out = await callTool(store, 'bridge_' + command, { token: values.token }); break;
    default: console.error(usage); process.exitCode = 2;
  }
  if (out !== undefined) console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
} catch (error) {
  console.error(`${error.code ?? 'ERROR'}: ${error.message}`); process.exitCode = 1;
} finally { store.close(); }
