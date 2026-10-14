import { BridgeError, ackText } from './service.mjs';
import { domOperation } from './dom-operation.mjs';
const fail = code => { throw new BridgeError(code); };
export class BrowserTransport {
  constructor(api) { this.api = api; this.permits = new Map(); this.mockInbox = new Map(); }
  async invoke(binding, args) {
    let output;
    try { output = await this.api.scripting.executeScript({ target: binding.documentId ?
      { tabId: binding.tabId, documentIds: [binding.documentId] } : { tabId: binding.tabId, frameIds: [0] },
      func: domOperation, args: [{ ...args, bindingId: binding.id, expectedUrl: binding.url, contract: binding.contract }] }); }
    catch { fail('ACCESS_DENIED'); }
    const result = output?.[0];
    if (!Array.isArray(output) || output.length !== 1 || !result?.documentId || (binding.documentId && result.documentId !== binding.documentId)) fail('TARGET_CHANGED');
    if (result.result?.error) fail(result.result.error);
    if (!result.result) fail('DOM_OPERATION_FAILED');
    return { data: result.result, documentId: result.documentId };
  }
  async bindCurrent(contract) {
    const tabs = await this.api.tabs.query({ active: true, currentWindow: true });
    if (tabs.length !== 1 || !Number.isInteger(tabs[0].id)) fail('TARGET_UNVERIFIED');
    const binding = { kind: 'dom', id: crypto.randomUUID(), tabId: tabs[0].id, contract };
    // Capture only the explicitly selected document's safe clean URL; tab lists/history are not read.
    const result = await this.invoke(binding, { mode: 'inspect' });
    return { ...binding, documentId: result.documentId, url: result.data.url, label: result.data.context };
  }
  async validate(binding) {
    if (binding.kind === 'mock') return { kind: 'mock', bindingId: binding.id };
    await this.invoke(binding, { mode: 'validate', requestId: '', expiresAt: Date.now() + 1000 });
    return { kind: 'dom', bindingId: binding.id, tabId: binding.tabId, documentId: binding.documentId };
  }
  async send(r, payload, { beforeWrite, signal }) {
    if (r.binding.kind === 'mock') {
      await beforeWrite(); if (signal.aborted) fail('CANCELLED');
      this.mockInbox.set(r.id, ackText(r)); return { status: 'unconfirmed' };
    }
    const remove = () => this.permits.delete(r.id);
    this.permits.set(r.id, { r, beforeWrite }); signal.addEventListener('abort', remove, { once: true });
    try { return (await this.invoke(r.binding, { mode: 'send', requestId: r.id, expiresAt: r.expiresAt, payload })).data; }
    finally { remove(); signal.removeEventListener('abort', remove); }
  }
  async permit(message, sender) {
    const pending = this.permits.get(message.requestId), binding = pending?.r.binding;
    if (!pending || message.bindingId !== binding.id || sender.tab?.id !== binding.tabId ||
      sender.documentId !== binding.documentId || sender.frameId !== 0 || sender.url !== binding.url) fail('TARGET_CHANGED');
    await pending.beforeWrite(); return { ok: true, requestId: message.requestId };
  }
  async receive(r) {
    if (r.binding.kind === 'mock') return { text: this.mockInbox.get(r.id) ?? null };
    return (await this.invoke(r.binding, { mode: 'receive', requestId: r.id, expiresAt: r.expiresAt, expectedResponse: ackText(r) })).data;
  }
  async revoke(r) { if (r.binding.kind === 'dom') await this.invoke(r.binding, { mode: 'revoke', requestId: r.id }); }
}
