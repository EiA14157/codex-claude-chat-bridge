#!/usr/bin/env node
/**
 * Local dashboard (127.0.0.1 only) and, with --remote, a Streamable HTTP MCP endpoint at /mcp for agents
 * that cannot spawn a local stdio server (e.g. Grok Bot on its cloud computer, reached through a tunnel
 * the user sets up). Dashboard API needs the admin key from the printed URL; /mcp needs the remote key.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { parseArgs } from 'node:util';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { RoomStore, RoomError, defaultDbPath } from './store.mjs';
import { createBridgeServer } from './tools.mjs';

const { values } = parseArgs({ options: {
  db: { type: 'string' }, port: { type: 'string', default: '47821' }, remote: { type: 'boolean', default: false }
} });
const port = Number(values.port);
const store = new RoomStore(values.db ?? defaultDbPath());
const adminKey = randomBytes(18).toString('base64url');
const remoteKey = values.remote ? (process.env.BRIDGE_REMOTE_KEY || randomBytes(24).toString('base64url')) : null;
const page = readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
const localHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

const same = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const bearer = req => (req.headers.authorization ?? '').replace(/^Bearer /, '');
const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    ...(type.startsWith('text/html') ? { 'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" } : {}) });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 1 << 20) throw new RoomError('TOO_LARGE', 'Body too large.'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RoomError('INVALID_INPUT', 'Body must be JSON.'); }
}

async function api(req, res, url) {
  // Host check blocks DNS-rebinding pages; the key blocks other local pages from driving the API.
  if (!localHosts.has(req.headers.host) || !same(bearer(req), adminKey)) return send(res, 401, { error: 'UNAUTHORIZED' });
  const parts = url.pathname.split('/').filter(Boolean); // api, rooms, CODE?, action?
  if (parts[1] !== 'rooms') return send(res, 404, { error: 'NOT_FOUND' });
  if (req.method === 'GET' && parts.length === 2) return send(res, 200, { rooms: store.listRooms(), remote: !!remoteKey });
  if (req.method === 'POST' && parts.length === 2) {
    const b = await readJson(req);
    return send(res, 201, store.createRoom({ topic: b.topic, maxMessages: b.maxMessages, minutes: b.minutes }));
  }
  if (req.method === 'GET' && parts.length === 3) {
    const t = store.transcript(parts[2]);
    const listening = Object.fromEntries(store.members(t.room.code).map(m => [m.name, m.listening_until > Date.now()]));
    return send(res, 200, { ...t, listening });
  }
  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'stop') return send(res, 200, store.stopRoom(parts[2]));
  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'kick') return send(res, 200, store.kick(parts[2], (await readJson(req)).name));
  return send(res, 404, { error: 'NOT_FOUND' });
}

async function mcp(req, res) {
  if (!remoteKey) return send(res, 404, { error: 'NOT_FOUND' });
  if (!same(bearer(req), remoteKey)) return send(res, 401, { error: 'UNAUTHORIZED' });
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const body = await readJson(req);
  // Stateless: one MCP server per request; room state lives in SQLite and the participant token.
  const server = createBridgeServer(store);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/mcp') return await mcp(req, res);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/' && req.method === 'GET') {
      if (!localHosts.has(req.headers.host)) return send(res, 403, 'Forbidden', 'text/plain');
      return send(res, 200, page, 'text/html; charset=utf-8');
    }
    send(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    if (!res.headersSent) send(res, error instanceof RoomError ? 400 : 500, { error: error.code ?? 'SERVER_ERROR', message: error.message });
  }
});
http.listen(port, '127.0.0.1', () => {
  console.log(`Dashboard: http://127.0.0.1:${port}/#key=${adminKey}`);
  if (remoteKey) console.log(`Remote MCP: POST http://127.0.0.1:${port}/mcp  (Authorization: Bearer ${remoteKey})\n` +
    'Expose it only through a tunnel you control, and stop the server when done.');
});
const shutdown = () => { http.close(); try { store.close(); } catch {} process.exit(0); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
