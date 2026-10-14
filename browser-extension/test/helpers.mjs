import { BridgeService, ackText } from '../extension/service.mjs';
export const errorCode = code => error => error.code === code;
export const failure = code => Object.assign(new Error('Synthetic failure'), { code });
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
export function fixture(overrides = {}) {
  const storage = { data: null, failWrites: false, afterWrite: null,
    async read() { return structuredClone(this.data); },
    async write(data) { if (this.failWrites) throw failure('STORAGE_FAILED'); this.data = structuredClone(data); this.afterWrite?.(data); }
  };
  const observed = { writes: 0, validations: 0, reads: 0, guard: null, inbox: new Map() };
  const transport = {
    async validate(binding) { observed.validations++; return { kind: binding.kind, bindingId: binding.id }; },
    async send(r, _payload, { beforeWrite }) { observed.guard = beforeWrite; await beforeWrite(); observed.writes++; observed.inbox.set(r.id, ackText(r)); return { status: 'unconfirmed' }; },
    async receive(r) { observed.reads++; return { text: observed.inbox.get(r.id) }; },
    async revoke() {}, ...overrides
  };
  let clock = 1000, next = 0;
  const service = new BridgeService({ storage, transport, now: () => clock, random: () => `synthetic-${++next}` });
  return { service, storage, transport, observed, advance: now => { clock = now; } };
}
export async function ready(f) { await f.service.bind({ kind: 'mock', id: 'selected-mock', label: 'Fixture' }); return f.service.prepare('harmless'); }
export async function bounded(promise, ms = 1000) { let timer; try { return await Promise.race([promise,
  new Promise((_, reject) => { timer = setTimeout(() => reject(failure('TEST_TIMEOUT')), ms); })]); } finally { clearTimeout(timer); } }
