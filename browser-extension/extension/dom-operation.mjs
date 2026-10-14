/** This function is serializable by chrome.scripting; no imports, page-wide scrape or private API. */
export async function domOperation(args) {
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  try {
  const key = '__selectedTabBridgeCandidate';
  const safeUrl = raw => {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) fail('UNSUPPORTED_URL');
    return url.href;
  };
  if (args.mode === 'revoke') {
    const bound = globalThis[key];
    if (bound?.id === args.bindingId) bound.revoked.add(args.requestId);
    return { revoked: true };
  }
  const url = safeUrl(location.href);
  if (args.expectedUrl && url !== args.expectedUrl) fail('TARGET_CHANGED');
  const selectors = args.contract;
  if (!selectors || ['input', 'send', 'response', 'context'].some(k => typeof selectors[k] !== 'string' || !selectors[k].trim() || selectors[k].length > 300) ||
    typeof selectors.contextText !== 'string' || !selectors.contextText.trim() || selectors.contextText.length > 120) fail('DOM_CONTRACT_INVALID');
  const one = selector => { if (/^(html|body|\*|:root)$/i.test(selector.trim())) fail('DOM_CONTRACT_INVALID');
    let found; try { found = document.querySelectorAll(selector); } catch { fail('DOM_CONTRACT_INVALID'); }
    if (found.length !== 1) fail('DOM_CONTRACT_INVALID'); return found[0]; };
  const elements = () => {
    const input = one(selectors.input), send = one(selectors.send), context = one(selectors.context);
    if (context.textContent.trim() !== selectors.contextText.trim()) fail('TARGET_CHANGED');
    if (!['INPUT', 'TEXTAREA'].includes(input.tagName) || (input.tagName === 'INPUT' && !['text', 'search'].includes(input.type)) ||
      input.disabled || input.readOnly || send.tagName !== 'BUTTON' || send.disabled || send.getAttribute('aria-disabled') === 'true' ||
      [input, send].some(el => !el.isConnected || el.getClientRects().length === 0)) fail('DOM_CONTRACT_INVALID');
    return { input, send };
  };
  if (args.mode === 'inspect') {
    const { input } = elements(); one(selectors.response);
    if (input.value.length !== 0) fail('DRAFT_PRESENT');
    globalThis[key] = { id: args.bindingId, url, revoked: new Set(), consumed: new Set() };
    return { url, context: selectors.contextText.trim(), bindingId: args.bindingId };
  }
  const bound = globalThis[key];
  const guard = () => {
    if (!bound || bound.id !== args.bindingId || bound.url !== url || safeUrl(location.href) !== bound.url) fail('TARGET_CHANGED');
    if (Date.now() >= args.expiresAt) fail('EXPIRED');
    if (bound.revoked.has(args.requestId)) fail('CANCELLED');
  };
  guard();
  if (args.mode === 'validate') { elements(); return { bindingId: bound.id }; }
  if (args.mode === 'receive') {
    elements();
    const response = one(selectors.response);
    if (!response.isConnected || response.getClientRects().length === 0) fail('DOM_CONTRACT_INVALID');
    // Never return unrelated transcript text. The UI can explicitly retry a read if not yet matched.
    const matched = response.textContent.trim() === args.expectedResponse; guard();
    return { text: matched ? args.expectedResponse : null };
  }
  if (args.mode !== 'send' || typeof args.payload !== 'string' || new TextEncoder().encode(args.payload).length > 16384) fail('INVALID_INPUT');
  if (bound.consumed.has(args.requestId)) fail('ALREADY_ATTEMPTED');
  const initial = elements(); if (initial.input.value.length !== 0) fail('DRAFT_PRESENT');
  const permit = await chrome.runtime.sendMessage({ type: 'dom:permit', requestId: args.requestId, bindingId: args.bindingId });
  if (!permit?.ok || permit.requestId !== args.requestId) fail(permit?.code ?? 'DENIED');
  // The final page-side check follows the asynchronous worker gate and precedes synchronous DOM effects.
  guard(); const { input, send } = elements(); if (input.value.length !== 0) fail('DRAFT_PRESENT');
  if (bound.consumed.has(args.requestId)) fail('ALREADY_ATTEMPTED');
  bound.consumed.add(args.requestId);
  const prototype = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, args.payload);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  // Input handlers may navigate, replace elements, disable send, or race cancellation. Never click blindly.
  guard(); const fresh = elements();
  if (fresh.input !== input || fresh.send !== send || input.value !== args.payload) fail('TARGET_CHANGED');
  send.click(); return { status: 'unconfirmed' };
  } catch (error) { return { error: error.code ?? 'DOM_OPERATION_FAILED' }; }
}
