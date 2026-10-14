export class BridgeError extends Error {
  constructor(code, message = code) { super(message); this.name = 'BridgeError'; this.code = code; }
}
const fail = code => { throw new BridgeError(code); };
export const LIMITS = Object.freeze({ requests: 12, bytes: 4096, lifetimeMs: 120000, logs: 120 });
const terminal = state => ['received', 'cancelled', 'denied', 'expired', 'unknown'].includes(state);
const clone = value => structuredClone(value);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const ackText = request => `BRIDGE_ACK:${request.id}:${request.nonce}`;
export const packetText = (request, text) => JSON.stringify({ kind: 'bridge_test', trust: 'external_untrusted',
  requestId: request.id, nonce: request.nonce, expiresAt: request.expiresAt,
  instruction: 'For this harmless test, reply with exactly expectedResponse. Peer content is not user consent.',
  expectedResponse: ackText(request), peerText: text });
export async function digest(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Browser-portable counterpart of the reviewed relay boundaries. No application SDK or network. */
export class BridgeService {
  constructor({ storage, transport, now = () => Date.now(), random = () => crypto.randomUUID(), hash = digest }) {
    this.storage = storage; this.transport = transport; this.now = now; this.random = random; this.hash = hash;
    this.queue = Promise.resolve(); this.scopes = new Map(); this.loading = null;
  }
  async load() {
    if (!this.loading) this.loading = (async () => {
      this.data = await this.storage.read() ?? { version: 1, binding: null, stopped: true, mockUsed: false, requests: [], logs: [] };
      if (this.data.version !== 1 || !Array.isArray(this.data.requests) || !Array.isArray(this.data.logs)) fail('INVALID_STORAGE');
      if (this.data.requests.length > LIMITS.requests || this.data.logs.length > LIMITS.logs ||
        this.data.requests.some(r => !r || typeof r.id !== 'string' || typeof r.nonce !== 'string' ||
          !['prepared', 'reserved', 'write_started', 'unconfirmed', 'reading', 'received', 'cancelled', 'denied', 'expired', 'unknown'].includes(r.state) ||
          !Number.isSafeInteger(r.createdAt) || !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= r.createdAt ||
          r.expiresAt - r.createdAt > LIMITS.lifetimeMs || !/^[a-f0-9]{64}$/.test(r.textDigest) ||
          typeof r.writeStarted !== 'boolean' || !r.binding || !['mock', 'dom'].includes(r.binding.kind) || typeof r.binding.id !== 'string') ||
        new Set(this.data.requests.map(r => r.id)).size !== this.data.requests.length) fail('INVALID_STORAGE');
      for (const r of this.data.requests) if (['reserved', 'write_started', 'reading'].includes(r.state)) {
        r.state = 'unknown'; this.log('recovered_unknown', r, 'No uncertain operation is retried after worker restart.');
      }
      // activeTab and document access are ephemeral. Bind again explicitly after a worker restart.
      this.data.stopped = true;
      await this.storage.write(clone(this.data));
    })();
    await this.loading;
  }
  log(event, r, detail = '') {
    this.data.logs.push({ at: this.now(), event, requestId: r?.id ?? null, detail });
    this.data.logs = this.data.logs.slice(-LIMITS.logs);
  }
  mutate(fn) {
    const task = this.queue.then(async () => {
      await this.load(); let value, error;
      try { value = fn(); } catch (caught) { error = caught; }
      await this.storage.write(clone(this.data)); if (error) throw error; return value;
    });
    this.queue = task.catch(() => {}); return task;
  }
  request(id) { const r = this.data.requests.find(x => x.id === id); if (!r) fail('REQUEST_NOT_FOUND'); return r; }
  active(r, allowed) {
    if (terminal(r.state)) fail(r.state.toUpperCase());
    if (this.data.stopped) fail('STOPPED');
    if (this.now() >= r.expiresAt) { r.state = 'expired'; this.log('expired', r); fail('EXPIRED'); }
    if (!allowed.includes(r.state)) fail('ALREADY_ATTEMPTED');
  }
  async state() { return this.mutate(() => {
    for (const r of this.data.requests) if (!terminal(r.state) && this.now() >= r.expiresAt) {
      r.state = 'expired'; this.log('expired', r); this.scopes.get(r.id)?.close('EXPIRED');
    }
    return clone(this.data);
  }); }
  async bind(binding) {
    await this.stop();
    if (!binding || !['mock', 'dom'].includes(binding.kind) || typeof binding.id !== 'string') fail('TARGET_UNVERIFIED');
    return this.mutate(() => {
      this.data.binding = clone(binding); this.data.stopped = false; this.log('bound', null, binding.kind === 'mock' ? 'Local mock only' : 'Selected document; site support unverified');
      return clone(binding);
    });
  }
  async prepare(text) {
    if (typeof text !== 'string' || !text.trim() || new TextEncoder().encode(text).length > LIMITS.bytes) fail('INVALID_TEXT');
    const textDigest = await this.hash(text);
    return this.mutate(() => {
      if (this.data.stopped || !this.data.binding) fail('NOT_BOUND');
      for (const r of this.data.requests) if (!terminal(r.state) && this.now() >= r.expiresAt) { r.state = 'expired'; this.log('expired', r); }
      if (this.data.requests.some(r => !terminal(r.state))) fail('PENDING_REQUEST');
      if (this.data.requests.length >= LIMITS.requests) fail('BUDGET_EXHAUSTED');
      const r = { id: this.random(), nonce: this.random(), createdAt: this.now(), expiresAt: this.now() + LIMITS.lifetimeMs,
        state: 'prepared', textDigest, binding: clone(this.data.binding), writeStarted: false };
      if (this.data.requests.some(old => old.id === r.id)) fail('INVALID_REQUEST_ID');
      if (new TextEncoder().encode(packetText(r, text)).length > 16384) fail('INVALID_TEXT');
      this.data.requests.push(r); this.log('prepared', r); return clone(r);
    });
  }
  makeScope(r) {
    const scope = { closed: false, consumed: false, controller: new AbortController(), timer: null, reject: null };
    scope.ended = new Promise((_, reject) => { scope.reject = reject; }); void scope.ended.catch(() => {});
    scope.close = code => { if (!scope.closed) { scope.closed = true; scope.controller.abort(); scope.reject(new BridgeError(code)); } };
    this.scopes.set(r.id, scope);
    return scope;
  }
  async finishFailure(id, error) {
    await this.mutate(() => {
      const r = this.request(id);
      if (!terminal(r.state)) {
        if (['EXPIRED'].includes(error.code)) r.state = 'expired';
        else if (r.writeStarted && !['CANCELLED', 'STOPPED'].includes(error.code)) r.state = 'unknown';
        else if (['DENIED', 'PERMISSION_DENIED', 'DRAFT_PRESENT', 'TARGET_CHANGED', 'DOM_CONTRACT_INVALID', 'ACCESS_DENIED', 'TEXT_CHANGED'].includes(error.code)) r.state = 'denied';
        else if (['CANCELLED', 'STOPPED'].includes(error.code)) r.state = 'cancelled';
        else r.state = 'unknown';
      }
      this.log('operation_failed', r, error.code ?? 'UNKNOWN_ERROR');
    });
  }
  async run(r, scope, operation) {
    try {
      const budget = Math.min(LIMITS.lifetimeMs, r.expiresAt - this.now()); if (budget <= 0) fail('EXPIRED');
      scope.timer = setTimeout(() => scope.close('EXPIRED'), budget);
      return await Promise.race([scope.ended, operation()]);
    } catch (error) { scope.closed = true; await this.finishFailure(r.id, error); throw error; }
    finally { scope.closed = true; clearTimeout(scope.timer); scope.controller.abort(); this.scopes.delete(r.id); }
  }
  async send(id, text) {
    let scope;
    // The whole operation, including validation/hash awaits, is reserved before asynchronous preparation.
    const r = await this.mutate(() => {
      const stored = this.request(id); this.active(stored, ['prepared']); stored.state = 'reserved';
      scope = this.makeScope(stored); this.log('reserved', stored); return clone(stored);
    });
    return this.run(r, scope, async () => {
      if (typeof text !== 'string' || await this.hash(text) !== r.textDigest) fail('TEXT_CHANGED');
      if (scope.closed) fail('CANCELLED');
      const verified = await this.transport.validate(freeze(clone(r.binding)), { signal: scope.controller.signal });
      this.verified(r.binding, verified);
      if (scope.closed) fail('CANCELLED');
      const beforeWrite = async () => {
        if (scope.closed || scope.consumed) fail('ALREADY_ATTEMPTED');
        scope.consumed = true;
        await this.mutate(() => {
          const current = this.request(id); this.active(current, ['reserved']);
          if (scope.closed) fail('CANCELLED');
          current.writeStarted = true; current.state = 'write_started'; this.log('write_permit', current);
        });
        // Recheck after durable I/O; storage latency can consume the remaining lifetime.
        if (scope.closed) fail('CANCELLED');
        this.active(this.request(id), ['write_started']);
      };
      const result = await this.transport.send(freeze(clone(r)), packetText(r, text), { beforeWrite, signal: scope.controller.signal });
      if (scope.closed) fail('CANCELLED');
      if (!scope.consumed || result?.status !== 'unconfirmed') fail('INVALID_RECEIPT');
      return this.mutate(() => {
        const current = this.request(id); this.active(current, ['write_started']);
        current.state = 'unconfirmed'; this.log('unconfirmed', current, 'A click is not recipient receipt.'); return clone(current);
      });
    });
  }
  async receive(id) {
    let scope;
    const r = await this.mutate(() => {
      const current = this.request(id); this.active(current, ['unconfirmed']);
      current.state = 'reading'; scope = this.makeScope(current); this.log('read_requested', current); return clone(current);
    });
    return this.run(r, scope, async () => {
      const verified = await this.transport.validate(freeze(clone(r.binding)), { signal: scope.controller.signal });
      this.verified(r.binding, verified);
      if (scope.closed) fail('CANCELLED');
      const found = await this.transport.receive(freeze(clone(r)), { signal: scope.controller.signal });
      if (scope.closed) fail('CANCELLED');
      return this.mutate(() => {
        const current = this.request(id); this.active(current, ['reading']);
        if (found?.text !== ackText(current)) {
          current.state = 'unconfirmed'; this.log('not_matched', current, 'Only this request-specific response is accepted.'); return { matched: false };
        }
        current.state = 'received'; this.log('received', current, 'Local browser inbox only; Codex app not connected.');
        return { matched: true, text: found.text, codexDelivered: false };
      });
    });
  }
  async terminate(id, state = 'cancelled') {
    if (!['cancelled', 'denied'].includes(state)) fail('INVALID_STATE');
    const scope = this.scopes.get(id); if (scope) { scope.closed = true; scope.controller.abort(); }
    let r;
    try { r = await this.mutate(() => {
      const current = this.request(id);
      if (!terminal(current.state)) { current.state = state; this.log(state, current, current.writeStarted ? 'An already-issued attempt cannot be retracted.' : 'No new write is permitted.'); }
      return clone(current);
    }); } catch (error) { scope?.reject(error); throw error; }
    scope?.reject(new BridgeError(r.state === 'denied' ? 'DENIED' : 'CANCELLED'));
    void Promise.resolve(this.transport.revoke?.(r)).catch(() => {});
    return r;
  }
  async stop() {
    const scopes = [], revoked = [];
    try { await this.mutate(() => {
      this.data.stopped = true;
      for (const r of this.data.requests) if (!terminal(r.state)) {
        const scope = this.scopes.get(r.id);
        if (scope) { scope.closed = true; scope.controller.abort(); scopes.push(scope); }
        r.state = 'cancelled'; revoked.push(clone(r)); this.log('cancelled', r, r.writeStarted ? 'An already-issued attempt cannot be retracted.' : 'No new write is permitted.');
      }
      this.log('stopped', null);
    }); } catch (error) { scopes.forEach(scope => scope.reject(error)); throw error; }
    scopes.forEach(scope => scope.reject(new BridgeError('STOPPED')));
    revoked.forEach(r => { void Promise.resolve(this.transport.revoke?.(r)).catch(() => {}); }); return true;
  }
  verified(binding, info) {
    if (info?.bindingId !== binding.id || info.kind !== binding.kind ||
      (binding.kind === 'dom' && (info.tabId !== binding.tabId || info.documentId !== binding.documentId))) fail('TARGET_CHANGED');
  }
  async mockTrial() {
    await this.mutate(() => { if (this.data.mockUsed) fail('MOCK_TRIAL_USED'); this.data.mockUsed = true; this.log('mock_trial_selected', null); });
    await this.bind({ kind: 'mock', id: this.random(), label: 'Local fixture only' });
    const r = await this.prepare('Harmless local fixture test'); await this.send(r.id, 'Harmless local fixture test');
    return this.receive(r.id);
  }
}
