import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, chmodSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { BridgeError, CodexDesktopUnavailable } from './adapters.mjs';

const ROLES = new Set(['codex', 'claude']);
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const peer = role => role === 'codex' ? 'claude' : 'codex';
const fail = (code, message) => { throw new BridgeError(code, message); };
function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_INPUT', `${label} must be 1–128 safe identifier characters.`);
  return value;
}
function integer(value, fallback, min, max, label) {
  const v = value ?? fallback;
  if (!Number.isSafeInteger(v) || v < min || v > max) fail('INVALID_INPUT', `${label} must be an integer from ${min} to ${max}.`);
  return v;
}
function role(value) {
  if (!ROLES.has(value)) fail('INVALID_INPUT', 'role must be codex or claude.');
  return value;
}

// Check before mkdir/open, including already-existing ancestors and SQLite sidecars.
// This is fail-closed path validation, not a same-user ACL or atomic no-follow guarantee.
function databasePathGuard(path) {
  for (const file of [path, path + '-wal', path + '-shm', path + '-journal']) {
    for (let current = file; ; current = dirname(current)) {
      let stat;
      try { stat = lstatSync(current); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat) {
        // Node lstat identifies Windows junctions as symbolic links as well.
        if (stat.isSymbolicLink())
          fail('UNSAFE_PATH', 'Database paths and ancestors must not redirect through symlinks or junctions.');
        if (current === file && !stat.isFile()) fail('UNSAFE_PATH', 'Existing database and sidecar paths must be regular files.');
        if (current !== file && !stat.isDirectory()) fail('UNSAFE_PATH', 'Database ancestors must be directories.');
      }
      if (dirname(current) === current) break;
    }
  }
}

/** Durable, bounded relay. IDs are routing locks, never proof of a live client identity. */
export class Relay {
  constructor(path, { now = () => Date.now() } = {}) {
    this.now = now;
    if (path !== ':memory:') {
      path = resolve(path);
      databasePathGuard(path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      databasePathGuard(path);
    }
    Object.defineProperty(this, 'path', { value: path });
    const fresh = path !== ':memory:' && !existsSync(path);
    this.db = new DatabaseSync(path, { timeout: 5000 });
    try { if (path !== ':memory:') databasePathGuard(path); }
    catch (error) { this.db.close(); throw error; }
    if (fresh) chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS pairs (
        id TEXT PRIMARY KEY, mode TEXT NOT NULL, codex_target TEXT NOT NULL,
        claude_target TEXT NOT NULL, status TEXT NOT NULL,
        created INTEGER NOT NULL, expires INTEGER NOT NULL,
        max_messages INTEGER NOT NULL, max_bytes INTEGER NOT NULL,
        max_hops INTEGER NOT NULL, delivery_timeout INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        pair_id TEXT NOT NULL REFERENCES pairs(id), sender TEXT NOT NULL,
        source_id TEXT NOT NULL, target_id TEXT NOT NULL, client_id TEXT NOT NULL,
        text TEXT NOT NULL, parent_id TEXT REFERENCES messages(id), root_id TEXT NOT NULL,
        hop INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT,
        created INTEGER NOT NULL, claimed INTEGER, owner TEXT, receipt TEXT,
        UNIQUE(pair_id, sender, client_id)
      );
      CREATE INDEX IF NOT EXISTS inbox ON messages(pair_id, status, seq);
      CREATE TABLE IF NOT EXISTS leases (
        pair_id TEXT NOT NULL REFERENCES pairs(id), role TEXT NOT NULL,
        owner TEXT NOT NULL, target_id TEXT NOT NULL, expires INTEGER NOT NULL,
        PRIMARY KEY(pair_id, role)
      );
      CREATE TABLE IF NOT EXISTS audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
        pair_id TEXT NOT NULL, message_id TEXT, event TEXT NOT NULL
      );
      PRAGMA user_version=1;
    `);
  }
  close() { this.db.close(); }
  tx(fn) {
    if (this.path !== ':memory:') databasePathGuard(this.path);
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); this.db.exec('COMMIT'); return out; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(pairId, event, messageId = null) {
    if (this.path !== ':memory:') databasePathGuard(this.path);
    this.db.prepare('INSERT INTO audit(at,pair_id,message_id,event) VALUES(?,?,?,?)')
      .run(this.now(), pairId, messageId, event);
  }
  createPair(input) {
    const pairId = id(input.id, 'pair');
    const mode = input.mode ?? 'live';
    if (!['live', 'simulation'].includes(mode)) fail('INVALID_INPUT', 'mode must be live or simulation.');
    const codex = id(input.codex, 'codex target');
    const claude = id(input.claude, 'claude target');
    const maxMessages = integer(input.maxMessages, 12, 1, 128, 'maxMessages');
    const maxBytes = integer(input.maxBytes, 16384, 1, 65536, 'maxBytes');
    const maxHops = integer(input.maxHops, 8, 0, 32, 'maxHops');
    const lifetimeSeconds = integer(input.lifetimeSeconds, 1800, 1, 86400, 'lifetimeSeconds');
    const deliveryTimeoutMs = integer(input.deliveryTimeoutMs, 30000, 100, 300000, 'deliveryTimeoutMs');
    return this.tx(() => {
      if (this.db.prepare('SELECT id FROM pairs WHERE id=?').get(pairId)) fail('PAIR_EXISTS', 'Pair already exists; targets and limits are immutable.');
      const t = this.now();
      this.db.prepare('INSERT INTO pairs VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(pairId, mode, codex, claude, mode === 'live' ? 'blocked' : 'active', t,
          t + lifetimeSeconds * 1000, maxMessages, maxBytes, maxHops, deliveryTimeoutMs);
      this.audit(pairId, 'pair_created');
      return this.pair(pairId);
    });
  }
  pair(pairId) {
    id(pairId, 'pair');
    const p = this.db.prepare('SELECT * FROM pairs WHERE id=?').get(pairId);
    if (!p) fail('PAIR_NOT_FOUND', 'Unknown bridge pair.');
    return { ...p };
  }
  target(pairId, actor, expected) {
    role(actor);
    const p = this.pair(pairId);
    if (p[`${actor}_target`] !== expected) fail('TARGET_MISMATCH', 'Exact locked target does not match.');
    return p;
  }
  liveGuard(p) {
    if (p.mode === 'live') fail('CODEX_GUI_UNAVAILABLE',
      'Live relay is blocked: the same existing Codex desktop chat has no verified adapter. No message was sent.');
  }
  activeGuard(p) {
    this.liveGuard(p);
    if (this.now() >= p.expires) fail('EXPIRED', 'Bridge lifetime has expired. Create a new explicitly bounded pair.');
    if (p.status !== 'active') fail('INACTIVE', `Bridge is ${p.status}.`);
  }
  housekeep(pairId) {
    return this.tx(() => {
      const p = this.pair(pairId), t = this.now();
      const stale = this.db.prepare("SELECT id FROM messages WHERE pair_id=? AND status IN ('dispatching','unconfirmed') AND claimed<=?")
        .all(pairId, t - p.delivery_timeout);
      for (const m of stale) {
        this.db.prepare("UPDATE messages SET status='unknown',reason='Delivery timeout; never automatically retried' WHERE id=?").run(m.id);
        this.audit(pairId, 'delivery_unknown', m.id);
      }
      if (stale.length && p.status === 'active') this.db.prepare("UPDATE pairs SET status='paused' WHERE id=?").run(pairId);
      if (t >= p.expires) {
        this.db.prepare("UPDATE messages SET status='expired',reason='Bridge lifetime expired before dispatch' WHERE pair_id=? AND status='queued'").run(pairId);
        if (!['stopped', 'blocked', 'expired'].includes(p.status)) {
          this.db.prepare("UPDATE pairs SET status='expired' WHERE id=?").run(pairId);
          this.audit(pairId, 'pair_expired');
        }
      }
    });
  }
  send({ pairId, sender, targetId, clientId, text, inReplyTo = null }) {
    role(sender); id(clientId, 'clientId'); id(targetId, 'targetId');
    if (typeof text !== 'string' || !text.trim() || text.includes('\u0000')) fail('INVALID_INPUT', 'text must be nonempty UTF-8 text without NUL.');
    if (inReplyTo !== null) id(inReplyTo, 'inReplyTo');
    this.housekeep(pairId);
    return this.tx(() => {
      const p = this.target(pairId, peer(sender), targetId);
      this.liveGuard(p);
      if (Buffer.byteLength(text, 'utf8') > p.max_bytes) fail('SIZE_LIMIT', 'Message exceeds the pair’s UTF-8 byte limit.');
      const previous = this.db.prepare('SELECT * FROM messages WHERE pair_id=? AND sender=? AND client_id=?').get(pairId, sender, clientId);
      if (previous) {
        if (previous.text !== text || previous.target_id !== targetId || previous.parent_id !== inReplyTo)
          fail('IDEMPOTENCY_CONFLICT', 'clientId was already used with different content or routing.');
        return { ...this.envelope(previous, p), duplicate: true };
      }
      this.activeGuard(p);
      const unresolved = this.db.prepare("SELECT id FROM messages WHERE pair_id=? AND status IN ('dispatching','unconfirmed','unknown') LIMIT 1").get(pairId);
      if (unresolved) fail('DELIVERY_UNCONFIRMED', 'A previous message has no confirmed receipt. Acknowledge it before continuing; never blindly resend.');
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE pair_id=?').get(pairId).n;
      if (count >= p.max_messages) fail('MESSAGE_LIMIT', 'Total pair message budget reached.');
      const messageId = randomUUID();
      let hop = 0, rootId = messageId;
      if (inReplyTo) {
        const parent = this.db.prepare('SELECT * FROM messages WHERE id=? AND pair_id=?').get(inReplyTo, pairId);
        if (!parent || parent.sender === sender || parent.target_id !== p[`${sender}_target`])
          fail('INVALID_PARENT', 'Reply must reference a peer message in this exact pair.');
        if (parent.status !== 'acknowledged') fail('PARENT_UNCONFIRMED', 'Acknowledge receipt before replying.');
        hop = parent.hop + 1; rootId = parent.root_id;
      }
      if (hop > p.max_hops) fail('HOP_LIMIT', 'Reply depth budget reached.');
      this.db.prepare(`INSERT INTO messages(id,pair_id,sender,source_id,target_id,client_id,text,parent_id,root_id,hop,status,created)
        VALUES(?,?,?,?,?,?,?,?,?,?,'queued',?)`).run(messageId, pairId, sender,
        p[`${sender}_target`], targetId, clientId, text, inReplyTo, rootId, hop, this.now());
      this.audit(pairId, 'message_queued', messageId);
      return { ...this.message(messageId), duplicate: false };
    });
  }
  envelope(m, p = this.pair(m.pair_id)) {
    return {
      id: m.id, pairId: m.pair_id, sender: m.sender, sourceId: m.source_id,
      targetId: m.target_id, clientId: m.client_id, text: m.text, inReplyTo: m.parent_id,
      rootId: m.root_id, hop: m.hop, status: m.status, reason: m.reason,
      createdAt: new Date(m.created).toISOString(), receipt: m.receipt,
      simulation: p.mode === 'simulation', trust: 'external_untrusted'
    };
  }
  message(messageId) {
    id(messageId, 'messageId');
    const m = this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
    if (!m) fail('MESSAGE_NOT_FOUND', 'Unknown message.');
    return this.envelope(m);
  }
  acquire(pairId, actor, targetId, owner) {
    id(owner, 'owner');
    return this.tx(() => {
      const p = this.target(pairId, actor, targetId);
      this.activeGuard(p);
      const old = this.db.prepare('SELECT * FROM leases WHERE pair_id=? AND role=?').get(pairId, actor);
      if (old && old.owner !== owner && old.expires > this.now()) fail('CONSUMER_BUSY', 'This exact target already has an active bridge consumer.');
      this.db.prepare('INSERT OR REPLACE INTO leases VALUES(?,?,?,?,?)').run(pairId, actor, owner, targetId, this.now() + 15000);
      return { owner, expires: this.now() + 15000 };
    });
  }
  release(pairId, actor, owner) {
    if (this.path !== ':memory:') databasePathGuard(this.path);
    this.db.prepare('DELETE FROM leases WHERE pair_id=? AND role=? AND owner=?').run(pairId, actor, owner);
  }
  claim(pairId, actor, targetId, owner) {
    this.housekeep(pairId);
    return this.tx(() => {
      const p = this.target(pairId, actor, targetId);
      this.activeGuard(p);
      const lease = this.db.prepare('SELECT * FROM leases WHERE pair_id=? AND role=?').get(pairId, actor);
      if (!lease || lease.owner !== owner || lease.expires <= this.now()) fail('LEASE_REQUIRED', 'An exclusive current target lease is required.');
      const pending = this.db.prepare("SELECT id FROM messages WHERE pair_id=? AND status IN ('dispatching','unconfirmed','unknown') LIMIT 1").get(pairId);
      if (pending) return null;
      const m = this.db.prepare("SELECT * FROM messages WHERE pair_id=? AND sender=? AND target_id=? AND status='queued' ORDER BY seq LIMIT 1")
        .get(pairId, peer(actor), targetId);
      if (!m) return null;
      this.db.prepare("UPDATE messages SET status='dispatching',claimed=?,owner=? WHERE id=?").run(this.now(), owner, m.id);
      this.audit(pairId, 'dispatch_claimed', m.id);
      return this.message(m.id);
    });
  }
  finish(messageId, owner, result) {
    if (!['acknowledged', 'unconfirmed', 'unknown', 'blocked'].includes(result.status)) fail('INVALID_INPUT', 'Invalid delivery outcome.');
    if (result.receipt != null) id(result.receipt, 'receipt');
    return this.tx(() => {
      const m = this.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId);
      if (!m || m.owner !== owner) fail('CLAIM_MISMATCH', 'Only the claiming consumer may finish a dispatch.');
      if (m.status === 'acknowledged') return this.message(messageId); // Fast receipt can precede transport completion.
      if (m.status === 'unknown') return this.message(messageId); // A concurrent timeout cannot be undone by a late transport result.
      if (m.status !== 'dispatching') fail('INVALID_STATE', 'Dispatch already finalized; it will not be retried.');
      this.db.prepare('UPDATE messages SET status=?,receipt=?,reason=? WHERE id=?')
        .run(result.status, result.receipt ?? null, result.status === 'unknown' ? 'Ambiguous transport outcome; manual reconciliation required' : null, messageId);
      if (result.status === 'unknown') this.db.prepare("UPDATE pairs SET status='paused' WHERE id=? AND status='active'").run(m.pair_id);
      this.audit(m.pair_id, `delivery_${result.status}`, messageId);
      return this.message(messageId);
    });
  }
  ack(pairId, actor, targetId, messageId) {
    return this.tx(() => {
      this.target(pairId, actor, targetId);
      const m = this.db.prepare('SELECT * FROM messages WHERE id=? AND pair_id=?').get(messageId, pairId);
      if (!m || m.sender === actor || m.target_id !== targetId) fail('ACK_MISMATCH', 'Only the locked recipient can acknowledge this pair’s message.');
      if (m.status === 'acknowledged') return this.message(messageId);
      if (!['dispatching', 'unconfirmed', 'unknown'].includes(m.status)) fail('INVALID_STATE', 'Only a dispatch attempt can be acknowledged.');
      this.db.prepare("UPDATE messages SET status='acknowledged',receipt=?,reason=NULL WHERE id=?").run(`recipient:${messageId}`, messageId);
      this.audit(pairId, 'recipient_acknowledged', messageId);
      return this.message(messageId);
    });
  }
  control(pairId, action) {
    if (!['pause', 'resume', 'stop'].includes(action)) fail('INVALID_INPUT', 'Unknown control action.');
    this.housekeep(pairId);
    return this.tx(() => {
      const p = this.pair(pairId);
      if (action === 'resume') {
        this.liveGuard(p);
        if (p.status !== 'paused') fail('INVALID_STATE', 'Only a paused pair can resume; stopped/expired pairs cannot restart.');
        if (this.now() >= p.expires) fail('EXPIRED', 'Pair lifetime expired.');
        if (this.db.prepare("SELECT id FROM messages WHERE pair_id=? AND status IN ('dispatching','unconfirmed','unknown') LIMIT 1").get(pairId))
          fail('DELIVERY_UNCONFIRMED', 'Resolve uncertain delivery with a recipient receipt, or stop and create a new pair.');
      }
      if (action === 'pause' && p.status !== 'active') return this.status(pairId, false);
      if (action === 'stop') {
        this.db.prepare("UPDATE messages SET status='cancelled',reason='Stopped before dispatch' WHERE pair_id=? AND status='queued'").run(pairId);
      }
      this.db.prepare('UPDATE pairs SET status=? WHERE id=?').run({ pause: 'paused', resume: 'active', stop: 'stopped' }[action], pairId);
      this.audit(pairId, `pair_${action}`);
      return this.status(pairId, false);
    });
  }
  status(pairId, housekeeping = true) {
    if (housekeeping) this.housekeep(pairId);
    const p = this.pair(pairId);
    const counts = Object.fromEntries(this.db.prepare('SELECT status,COUNT(*) AS n FROM messages WHERE pair_id=? GROUP BY status').all(pairId).map(r => [r.status, r.n]));
    return { pair: p, counts, liveReady: false,
      blocker: p.mode === 'live' ? 'CODEX_GUI_UNAVAILABLE' : null,
      note: 'Simulation IDs are routing labels. They do not prove live desktop/session identity.' };
  }
  list(pairId) {
    const p = this.pair(pairId);
    return this.db.prepare('SELECT * FROM messages WHERE pair_id=? ORDER BY seq').all(pairId).map(m => this.envelope(m, p));
  }
}

/** At-most-one attempt: persist the claim before I/O; never requeue on an error. */
export async function dispatchOne(relay, pairId, actor, targetId, owner, adapter) {
  const p = relay.target(pairId, actor, targetId);
  relay.liveGuard(p);
  const validated = await adapter.validateTarget(targetId);
  if (validated?.targetId !== targetId || (p.mode === 'simulation' && validated.simulation !== true))
    fail('TARGET_UNVERIFIED', 'Adapter did not verify the locked target and simulation mode.');
  relay.acquire(pairId, actor, targetId, owner);
  const message = relay.claim(pairId, actor, targetId, owner);
  if (!message) return null;
  const claimed = relay.db.prepare('SELECT claimed FROM messages WHERE id=?').get(message.id).claimed;
  const deadline = claimed + p.delivery_timeout;
  let timeout, closed = false, writeStarted = false;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => { closed = true; reject(new BridgeError('TIMEOUT', 'Delivery attempt timed out.')); }, Math.max(0, deadline - relay.now()));
    });
    const result = await Promise.race([
      adapter.deliver(message, { beforeWrite: () => {
        // Adapters MUST call this immediately before their irreversible I/O.
        const current = relay.pair(pairId);
        const now = relay.now();
        if (closed || writeStarted || now >= deadline)
          fail('DELIVERY_ABORTED', 'Delivery deadline passed or the single write attempt is no longer available.');
        const lease = relay.db.prepare('SELECT * FROM leases WHERE pair_id=? AND role=?').get(pairId, actor);
        if (current.status !== 'active' || now >= current.expires || relay.message(message.id).status !== 'dispatching')
          fail('DELIVERY_ABORTED', 'Bridge changed state before transport write.');
        if (!lease || lease.owner !== owner || lease.expires <= now)
          fail('DELIVERY_ABORTED', 'Target disconnected or its lease expired before transport write.');
        writeStarted = true;
      } }),
      timeoutPromise
    ]);
    if (!result || !['acknowledged', 'unconfirmed', 'blocked'].includes(result.status))
      fail('INVALID_RECEIPT', 'Transport returned no trustworthy outcome.');
    // Adapter acknowledgement is allowed only for the in-memory simulator.
    if (result.status === 'acknowledged' && adapter.name !== 'simulation')
      fail('INVALID_RECEIPT', 'Transport writes cannot masquerade as recipient acknowledgements.');
    return relay.finish(message.id, owner, result);
  } catch (error) {
    return relay.finish(message.id, owner, { status: error.code === 'DELIVERY_ABORTED' ? 'blocked' : 'unknown' });
  } finally { closed = true; clearTimeout(timeout); }
}

export { BridgeError, CodexDesktopUnavailable, peer };
