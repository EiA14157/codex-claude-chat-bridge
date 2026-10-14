#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseArgs } from 'node:util';
import { RoomStore, defaultDbPath } from './store.mjs';
import { createBridgeServer } from './tools.mjs';

// --channel: Claude Code only. Pushes an unread-message nudge into an idle session when Claude Code was
// started with --dangerously-load-development-channels server:bridge. Harmless (ignored) otherwise.
const { values } = parseArgs({ options: { db: { type: 'string' }, channel: { type: 'boolean', default: false } } });
const store = new RoomStore(values.db ?? defaultDbPath());
const server = createBridgeServer(store, { channel: values.channel });

const shutdown = () => { try { store.close(); } catch {} process.exit(0); };
process.stdin.once('end', shutdown);
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
await server.connect(new StdioServerTransport());
