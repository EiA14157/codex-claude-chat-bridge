import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomInt } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export class RoomError extends Error {
  constructor(code, message = code) { super(message); this.name = 'RoomError'; this.code = code; }
}
const fail = (code, message) => { throw new RoomError(code, message); };

export const DEFAULTS = Object.freeze({ maxMessages: 20, maxBytes: 16384, minutes: 30, waitSeconds: 45 });
export const MAX_WAIT_SECONDS = 50;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE = /^[A-Z2-9]{6}$/;
const NAME = /^[\p{L}\p{N} _.:-]{1,40}$/u;

export const defaultDbPath = () => process.env.BRIDGE_DB || join(homedir(), '.bridge', 'rooms.sqlite');

function int(value, fallback, min, max, label) {
  const v = value ?? fallback;
  if (!Number.isSafeInteger(v) || v < min || v > max) fail('INVALID_INPUT', `${label} must be an integer from ${min} to ${max}.`);
  return v;
}
function code(value) {
  const c = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!CODE.test(c)) fail('INVALID_CODE', 'Room code must be 6 letters/digits.');
  return c;
}

/**
 * A room links exactly two participants (e.g. one Claude Code session and one Codex conversation)
 * that the user chose by typing the room code into each conversation. Shared through one SQLite file;
 * no network listener.
 */
export class RoomStore {
  constructor(path = defaultDbPath(), { now = () => Date.now() } = {}) {
    this.now = now;
    if (path !== ':memory:') { path = resolve(path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); }
    this.path = path;
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY, topic TEXT NOT NULL, status TEXT NOT NULL,
        created INTEGER NOT NULL, expires INTEGER NOT NULL,
        max_messages INTEGER NOT NULL, max_bytes INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS participants (
        token TEXT PRIMARY KEY, room_code TEXT NOT NULL REFERENCES rooms(code),
        name TEXT NOT NULL, joined INTEGER NOT NULL, left_at INTEGER,
        cursor INTEGER NOT NULL DEFAULT 0, listening_until INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        room_code TEXT NOT NULL REFERENCES rooms(code), sender TEXT NOT NULL REFERENCES participants(token),
        sender_name TEXT NOT NULL, client_id TEXT, text TEXT NOT NULL, reply_to TEXT,
        created INTEGER NOT NULL, UNIQUE(room_code, sender, client_id)
      );
      CREATE INDEX IF NOT EXISTS room_seq ON messages(room_code, seq);
    `);
    // join_order/left_order come from one monotonic counter, so "left after I joined" never depends on clock ties.
    const cols = new Set(this.db.prepare('PRAGMA table_info(participants)').all().map(c => c.name));
    for (const [col, def] of [['join_order', 'INTEGER NOT NULL DEFAULT 0'], ['left_order', 'INTEGER'], ['last_seen', 'INTEGER NOT NULL DEFAULT 0']])
      if (!cols.has(col)) this.db.exec(`ALTER TABLE participants ADD COLUMN ${col} ${def}`);
  }
  nextOrder() {
    return this.db.prepare('SELECT MAX(COALESCE(MAX(join_order), 0), COALESCE(MAX(left_order), 0)) + 1 n FROM participants').get().n;
  }
  close() { this.db.close(); }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); this.db.exec('COMMIT'); return out; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  createRoom({ topic = '', maxMessages, maxBytes, minutes } = {}) {
    if (typeof topic !== 'string' || topic.length > 200) fail('INVALID_INPUT', 'topic must be at most 200 characters.');
    const mm = int(maxMessages, DEFAULTS.maxMessages, 1, 200, 'maxMessages');
    const mb = int(maxBytes, DEFAULTS.maxBytes, 64, 65536, 'maxBytes');
    const min = int(minutes, DEFAULTS.minutes, 1, 24 * 60, 'minutes');
    return this.tx(() => {
      let c;
      do c = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      while (this.db.prepare('SELECT 1 FROM rooms WHERE code=?').get(c));
      const t = this.now();
      this.db.prepare('INSERT INTO rooms VALUES(?,?,?,?,?,?,?)').run(c, topic, 'active', t, t + min * 60000, mm, mb);
      return this.room(c);
    });
  }
  room(c) {
    const r = this.db.prepare('SELECT * FROM rooms WHERE code=?').get(code(c));
    if (!r) fail('ROOM_NOT_FOUND', 'No room with that code.');
    if (r.status === 'active' && this.now() >= r.expires) {
      this.db.prepare("UPDATE rooms SET status='expired' WHERE code=? AND status='active'").run(r.code);
      r.status = 'expired';
    }
    const used = this.db.prepare('SELECT COUNT(*) n FROM messages WHERE room_code=?').get(r.code).n;
    return { code: r.code, topic: r.topic, status: r.status, created: r.created, expires: r.expires,
      maxMessages: r.max_messages, maxBytes: r.max_bytes, messagesUsed: used };
  }
  listRooms() {
    return this.db.prepare('SELECT code FROM rooms ORDER BY created DESC').all().map(r => this.room(r.code));
  }
  stopRoom(c) {
    return this.tx(() => {
      const r = this.room(c);
      if (r.status === 'active') this.db.prepare("UPDATE rooms SET status='stopped' WHERE code=?").run(r.code);
      return this.room(r.code);
    });
  }
  active(c) {
    const r = this.room(c);
    if (r.status !== 'active') fail(`ROOM_${r.status.toUpperCase()}`, `Room is ${r.status}.`);
    return r;
  }
  members(c) {
    return this.db.prepare('SELECT * FROM participants WHERE room_code=? AND left_at IS NULL ORDER BY joined').all(c);
  }
  participant(token) {
    if (typeof token !== 'string') fail('INVALID_TOKEN', 'token is required.');
    const p = this.db.prepare('SELECT * FROM participants WHERE token=?').get(token);
    if (!p) fail('INVALID_TOKEN', 'Unknown participant token. Join the room again.');
    if (p.left_at !== null) fail('LEFT', 'This participant already left the room.');
    return p;
  }

  join(c, name) {
    if (typeof name !== 'string' || !NAME.test(name.trim())) fail('INVALID_INPUT', 'name must be 1-40 letters, digits, spaces or _.:-');
    return this.tx(() => {
      const r = this.active(c);
      const members = this.members(r.code);
      if (members.length >= 2) fail('ROOM_FULL', 'Room already has two participants.');
      if (members.some(m => m.name === name.trim())) fail('NAME_TAKEN', 'Another participant already uses that name.');
      const token = randomUUID();
      // Start after existing history so a late joiner still sees everything sent so far.
      this.db.prepare('INSERT INTO participants(token,room_code,name,joined,join_order,last_seen) VALUES(?,?,?,?,?,?)')
        .run(token, r.code, name.trim(), this.now(), this.nextOrder(), this.now());
      return { token, room: r, peer: this.peerView(r.code, token) };
    });
  }
  leave(token) {
    return this.tx(() => {
      const p = this.participant(token);
      this.markLeft(token);
      return { left: true, room: p.room_code };
    });
  }
  markLeft(token) {
    this.db.prepare('UPDATE participants SET left_at=?, left_order=?, listening_until=0 WHERE token=?').run(this.now(), this.nextOrder(), token);
  }
  /**
   * User-side recovery for a participant whose conversation crashed or lost its token: frees the slot.
   * Deliberately manual (CLI / dashboard): an agent that merely stopped waiting is not treated as gone.
   */
  kick(c, name) {
    return this.tx(() => {
      const r = this.room(c);
      const m = this.members(r.code).find(x => x.name === name);
      if (!m) fail('NOT_A_MEMBER', `No active participant named ${name}.`);
      this.markLeft(m.token);
      return { kicked: name, room: r.code };
    });
  }
  peerView(c, token) {
    const peer = this.members(c).find(m => m.token !== token);
    return peer ? { name: peer.name, listening: peer.listening_until > this.now() } : null;
  }

  /** True when nobody else is here now, but someone left after this participant joined (i.e. a peer we had). */
  peerLeft(c, token) {
    if (this.peerView(c, token)) return false;
    const me = this.db.prepare('SELECT join_order FROM participants WHERE token=?').get(token);
    return !!this.db.prepare('SELECT 1 FROM participants WHERE room_code=? AND token<>? AND left_order > ?').get(c, token, me.join_order);
  }

  send(token, text, { replyTo, clientId } = {}) {
    if (typeof text !== 'string' || !text.trim()) fail('INVALID_INPUT', 'text is required.');
    return this.tx(() => {
      const p = this.participant(token);
      const r = this.active(p.room_code);
      if (clientId !== undefined) {
        const prior = this.db.prepare('SELECT id FROM messages WHERE room_code=? AND sender=? AND client_id=?').get(r.code, token, clientId);
        if (prior) return { id: prior.id, duplicate: true, room: this.room(r.code) };
      }
      if (Buffer.byteLength(text, 'utf8') > r.maxBytes) fail('TOO_LARGE', `Message exceeds ${r.maxBytes} bytes.`);
      if (r.messagesUsed >= r.maxMessages) fail('BUDGET_EXHAUSTED', 'Room message budget is used up.');
      if (!this.peerView(r.code, token)) fail('NO_PEER', 'Nobody else has joined yet. Use bridge_wait until the peer joins.');
      if (replyTo !== undefined && !this.db.prepare('SELECT 1 FROM messages WHERE id=? AND room_code=?').get(replyTo, r.code))
        fail('INVALID_INPUT', 'replyTo is not a message in this room.');
      const id = randomUUID();
      this.db.prepare('UPDATE participants SET last_seen=? WHERE token=?').run(this.now(), token);
      this.db.prepare('INSERT INTO messages(id,room_code,sender,sender_name,client_id,text,reply_to,created) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, r.code, token, p.name, clientId ?? null, text, replyTo ?? null, this.now());
      return { id, duplicate: false, room: this.room(r.code) };
    });
  }

  /**
   * Non-blocking: returns peer messages after the cursor and advances it. Pass afterSeq (the last seq you
   * actually received) to get messages again if an earlier result was lost in transit.
   */
  poll(token, { afterSeq } = {}) {
    if (afterSeq !== undefined) int(afterSeq, 0, 0, Number.MAX_SAFE_INTEGER, 'afterSeq');
    return this.tx(() => {
      const p = this.participant(token);
      const from = afterSeq ?? p.cursor;
      const rows = this.db.prepare('SELECT * FROM messages WHERE room_code=? AND seq>? AND sender<>? ORDER BY seq').all(p.room_code, from, token);
      const cursor = Math.max(p.cursor, rows.at(-1)?.seq ?? 0);
      this.db.prepare('UPDATE participants SET cursor=?, last_seen=? WHERE token=?').run(cursor, this.now(), token);
      return {
        messages: rows.map(m => ({ seq: m.seq, id: m.id, from: m.sender_name, text: m.text, replyTo: m.reply_to, at: m.created })),
        lastSeq: cursor, room: this.room(p.room_code), peer: this.peerView(p.room_code, token)
      };
    });
  }
  /** Read-only: unseen peer messages for this participant, without advancing the cursor. */
  pending(token) {
    const p = this.participant(token);
    const row = this.db.prepare('SELECT COUNT(*) n, MAX(seq) last, MAX(sender_name) sender FROM messages WHERE room_code=? AND seq>? AND sender<>?')
      .get(p.room_code, p.cursor, token);
    return { room: p.room_code, count: row.n, lastSeq: row.last ?? 0, from: row.sender };
  }
  /**
   * Blocks up to timeoutSec for peer messages, or returns early if the room ends or the peer leaves.
   * Writes only when starting, delivering and finishing; the polling itself is read-only (no write lock).
   */
  async wait(token, timeoutSec = DEFAULTS.waitSeconds, { signal, intervalMs = 300, afterSeq } = {}) {
    const seconds = int(timeoutSec, DEFAULTS.waitSeconds, 0, MAX_WAIT_SECONDS, 'timeoutSec');
    const deadline = this.now() + seconds * 1000;
    const p = this.participant(token);
    this.db.prepare('UPDATE participants SET listening_until=?, last_seen=? WHERE token=?').run(deadline + 2000, this.now(), token);
    const unread = this.db.prepare('SELECT 1 FROM messages WHERE room_code=? AND seq>? AND sender<>? LIMIT 1');
    try {
      for (;;) {
        const me = this.participant(token);
        const room = this.room(p.room_code);
        const peerLeft = this.peerLeft(p.room_code, token);
        if (unread.get(p.room_code, afterSeq ?? me.cursor, token) || room.status !== 'active' || peerLeft || this.now() >= deadline || signal?.aborted) {
          const out = this.poll(token, { afterSeq });
          return { ...out, timedOut: !out.messages.length && out.room.status === 'active' && !peerLeft, peerLeft };
        }
        await new Promise(r => setTimeout(r, intervalMs));
      }
    } finally {
      this.db.prepare('UPDATE participants SET listening_until=0 WHERE token=? AND left_at IS NULL').run(token);
    }
  }

  transcript(c) {
    const r = this.room(c);
    return { room: r,
      participants: this.db.prepare('SELECT name, joined, left_at, last_seen FROM participants WHERE room_code=? ORDER BY joined').all(r.code),
      messages: this.db.prepare('SELECT id, sender_name AS "from", text, reply_to AS replyTo, created AS at FROM messages WHERE room_code=? ORDER BY seq').all(r.code) };
  }
}
