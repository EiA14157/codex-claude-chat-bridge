#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, lstatSync, existsSync } from 'node:fs';
import { resolve, join, dirname, relative, basename, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { BridgeError, isDeniedError, isCancelledError } from './adapters.mjs';

export const exchangeRoot = resolve(import.meta.dirname, '..', '.bridge', 'operator-trials');
// Publication uses fixture identities only; no actual conversation IDs are shipped.
export const exchangeTargets = Object.freeze({
  codex: 'fixture-codex-thread', host: 'local',
  claude: 'fixture-claude-session',
  desktop: 'fixture-desktop-session'
});
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => { throw new BridgeError(code, message); };
const safeNonce = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(value);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const preparationLimitMs = 7200000;
const executionWindowMs = 300000;
const requestIdOf = packet => packet.requestId ?? packet.nonce;
const responseOf = packet => `CLAUDE_TO_CODEX:${requestIdOf(packet)}`;
const clockOf = options => () => {
  const value = typeof options?.now === 'function' ? options.now() : options?.now ?? Date.now();
  if (!Number.isSafeInteger(value)) fail('INVALID_INPUT', 'The clock must return an integer millisecond timestamp.');
  return value;
};
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function statIfPresent(file) {
  try { return lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function scoped(file) {
  if (typeof file !== 'string' || !file.trim()) fail('INVALID_INPUT', 'An explicit trial file path is required.');
  const path = resolve(file), rel = relative(exchangeRoot, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || basename(path) !== 'request.json')
    fail('UNSAFE_PATH', 'Use a request.json in the dedicated operator-trial directory.');
  // Check .bridge and every existing descendant, including the request file.
  const base = dirname(exchangeRoot);
  for (let p = path; p !== dirname(base); p = dirname(p)) {
    if (statIfPresent(p)?.isSymbolicLink()) fail('UNSAFE_PATH', 'Trial symlinks are not supported.');
  }
  return path;
}
function readJson(file, max = 65536) {
  const stat = statIfPresent(file);
  if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size > max)
    fail('INVALID_TRIAL', 'Expected a bounded regular trial file.');
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { fail('INVALID_TRIAL', 'Invalid trial JSON.'); }
}
function writeOnce(file, value, code) {
  try { writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') fail(code, 'This one-shot operation already had an attempt.'); throw error; }
}
function readExchange(file) {
  const path = scoped(file), record = readJson(path), p = record?.packet;
  const separateRequest = p && Object.hasOwn(p, 'requestId');
  const packetKeys = ['nonce', 'source', 'target', 'createdAt', 'expiresAt', 'authenticatedBinding', 'independentHost'];
  if (separateRequest) packetKeys.push('requestId', 'executionWindowMs');
  if (!exactKeys(record, ['kind', 'packet', 'digest']) || record.kind !== 'operator_mediated_one_shot' ||
      !exactKeys(p, packetKeys) ||
      (separateRequest && (!safeNonce(p.requestId) || p.executionWindowMs !== executionWindowMs)) ||
      basename(dirname(path)) !== requestIdOf(p) ||
      !exactKeys(p.source, ['agent', 'threadId', 'hostId', 'turnId', 'messageId', 'text', 'evidence']) ||
      !exactKeys(p.target, ['agent', 'sessionId', 'desktopSessionId']) ||
      p.source.agent !== 'codex' || p.target.agent !== 'claude' || p.source.evidence !== 'operator_observed_codex_app_result' ||
      record.digest !== hash(p) ||
      !safeNonce(p.nonce) || p.source?.threadId !== exchangeTargets.codex || p.source.hostId !== exchangeTargets.host ||
      !safeId(p.source.turnId) || !safeId(p.source.messageId) || p.source.text !== `CODEX_TO_CLAUDE:${p.nonce}` ||
      p.target?.sessionId !== exchangeTargets.claude || p.target.desktopSessionId !== exchangeTargets.desktop ||
      p.authenticatedBinding !== false || p.independentHost !== false ||
      !Number.isSafeInteger(p.createdAt) || !Number.isSafeInteger(p.expiresAt) ||
      p.expiresAt <= p.createdAt || p.expiresAt - p.createdAt > (separateRequest ? preparationLimitMs : 1800000))
    fail('INVALID_TRIAL', 'Trial identity, content, digest or bounds do not match.');
  return { path, record, packet: p };
}

function terminalState({ path, record, packet }) {
  const file = path + '.terminal.json';
  if (!statIfPresent(file)) return null;
  const terminal = readJson(file, 4096);
  if (!exactKeys(terminal, ['requestId', 'nonce', 'digest', 'state', 'at']) ||
      terminal.requestId !== requestIdOf(packet) || terminal.nonce !== packet.nonce || terminal.digest !== record.digest ||
      !['cancelled', 'denied'].includes(terminal.state) || !Number.isSafeInteger(terminal.at))
    fail('INVALID_TRIAL', 'The terminal request state does not match.');
  return terminal;
}
function persistTerminal(context, state, options) {
  const old = terminalState(context);
  if (old) return old;
  const terminal = { requestId: requestIdOf(context.packet), nonce: context.packet.nonce,
    digest: context.record.digest, state, at: clockOf(options)() };
  try { writeOnce(context.path + '.terminal.json', terminal, 'TERMINAL_EXISTS'); }
  catch (error) { if (error.code !== 'TERMINAL_EXISTS') throw error; return terminalState(context); }
  return terminal;
}
function activeGuard(context, options) {
  if (options?.signal && typeof options.signal.aborted !== 'boolean') fail('INVALID_INPUT', 'Expected an AbortSignal.');
  if (options?.signal?.aborted) persistTerminal(context, 'cancelled', options);
  const terminal = terminalState(context);
  if (terminal) fail(terminal.state === 'denied' ? 'REQUEST_DENIED' : 'CANCELLED', 'This request is terminal; it cannot be restarted.');
  const now = clockOf(options)();
  if (now >= context.packet.expiresAt || now < context.packet.createdAt)
    fail('EXPIRED', 'This one-shot trial is not in its bounded time window.');
  return now;
}
export function loadExchange(file, options) {
  const context = readExchange(file); activeGuard(context, options); return context;
}
/** Explicit operator stop/denial. An expired or claimed request can still be revoked. */
export function terminateExchange(file, requestId, state = 'cancelled', options) {
  const context = readExchange(file);
  if (!safeNonce(requestId) || requestId !== requestIdOf(context.packet) || !['cancelled', 'denied'].includes(state))
    fail('INVALID_INPUT', 'Name this exact request and a terminal cancellation or denial.');
  return persistTerminal(context, state, options);
}
export function prepareExchange({ nonce, requestId = nonce, sourceTurnId, sourceMessageId, sourceText, lifetimeMs = 1800000, now = Date.now() }) {
  if (!safeNonce(nonce) || !safeNonce(requestId) || !safeId(sourceTurnId) || !safeId(sourceMessageId) || sourceText !== `CODEX_TO_CLAUDE:${nonce}` ||
      !Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > preparationLimitMs || !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(now + lifetimeMs))
    fail('INVALID_INPUT', 'Prepare only the exact observed test message and a finite lifetime.');
  const path = scoped(join(exchangeRoot, requestId, 'request.json'));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const packet = { nonce, requestId, executionWindowMs,
    source: { agent: 'codex', threadId: exchangeTargets.codex, hostId: exchangeTargets.host,
      turnId: sourceTurnId, messageId: sourceMessageId, text: sourceText,
      evidence: 'operator_observed_codex_app_result' },
    target: { agent: 'claude', sessionId: exchangeTargets.claude, desktopSessionId: exchangeTargets.desktop },
    createdAt: now, expiresAt: now + lifetimeMs, authenticatedBinding: false, independentHost: false };
  writeOnce(path, { kind: 'operator_mediated_one_shot', packet, digest: hash(packet) }, 'TRIAL_EXISTS');
  return { path, nonce, requestId, expiresAt: packet.expiresAt, executionWindowMs, operatorMediated: true, independentHost: false };
}
function assertRecipient(packet, sessionId) {
  if (sessionId !== packet.target.sessionId) fail('TARGET_MISMATCH', 'The selected Claude target does not match.');
}
function readAttempt(path, record) {
  const marker = readJson(path + '.receive-attempt', 4096);
  if (!exactKeys(marker, ['nonce', 'requestId', 'digest', 'state', 'startedAt', 'executionExpiresAt']) ||
      marker.digest !== record.digest || marker.nonce !== record.packet.nonce || marker.requestId !== requestIdOf(record.packet) ||
      marker.state !== 'attempt_started_no_receipt' || !Number.isSafeInteger(marker.startedAt) ||
      marker.startedAt < record.packet.createdAt || marker.startedAt >= record.packet.expiresAt ||
      marker.executionExpiresAt !== Math.min(marker.startedAt + executionWindowMs, record.packet.expiresAt))
    fail('INVALID_TRIAL', 'The persisted receive attempt does not match this packet.');
  return marker;
}
function executionGuard(context, options) {
  // Read the attempt first, then observe cancellation and both deadlines after that I/O.
  const marker = readAttempt(context.path, context.record);
  const now = activeGuard(context, options);
  if (now < marker.startedAt || now >= marker.executionExpiresAt)
    fail('EXECUTION_EXPIRED', 'The short execution window has ended; never rearm or retry.');
  return marker;
}
/** A real observed source message, manually carried by the operator; not an automatic relay. */
export function emitExchange(file, sessionId, writeLine, options) {
  const context = loadExchange(file, options), { path, record, packet } = context;
  assertRecipient(packet, sessionId);
  if (typeof writeLine !== 'function') fail('INVALID_INPUT', 'A synchronous stdout writer is required.');
  const now = activeGuard(context, options);
  const line = JSON.stringify({ kind: 'operator_mediated_peer_trial', trust: 'external_untrusted',
    nonce: packet.nonce, requestId: requestIdOf(packet), source: packet.source, target: packet.target, text: packet.source.text,
    operatorMediated: true, authenticatedBinding: false, independentHost: false,
    scope: 'receipt_only', expectedResponse: responseOf(packet),
    executionExpiresAt: Math.min(now + executionWindowMs, packet.expiresAt) }) + '\n';
  writeOnce(path + '.receive-attempt', { nonce: packet.nonce, requestId: requestIdOf(packet), digest: record.digest,
    state: 'attempt_started_no_receipt', startedAt: now,
    executionExpiresAt: Math.min(now + executionWindowMs, packet.expiresAt) }, 'ALREADY_ATTEMPTED');
  // Disk I/O can consume the deadline or expose a concurrent stop; never erase the claim.
  executionGuard(context, options);
  const result = writeLine(line);
  if (result && typeof result.then === 'function') { void Promise.resolve(result).catch(() => {}); fail('DELIVERY_UNKNOWN', 'The output outcome is uncertain; never retry.'); }
  return { status: 'unconfirmed', nonce: packet.nonce, independentHost: false };
}
/** Explicit selected-session receipt report. A file alone is not authenticated app evidence. */
function assertReceipt(packet, receipt) {
  if (!exactKeys(receipt, ['requestId', 'nonce', 'text']) || !safeNonce(receipt.requestId) ||
      !safeNonce(receipt.nonce) || typeof receipt.text !== 'string')
    fail('INVALID_INPUT', 'Provide the actually observed request ID, source nonce and full response text.');
  if (receipt.requestId !== requestIdOf(packet) || receipt.nonce !== packet.nonce || receipt.text !== responseOf(packet))
    fail('RECEIPT_MISMATCH', 'Observed receipt does not belong to this exact request.');
}
export function recordExchangeReply(file, sessionId, receipt, options) {
  receipt = receipt && Object.freeze({ ...receipt });
  const context = loadExchange(file, options), { path, record, packet } = context;
  assertRecipient(packet, sessionId); assertReceipt(packet, receipt);
  executionGuard(context, options);
  const reply = { nonce: receipt.nonce, requestId: receipt.requestId, digest: record.digest, sourceSessionId: packet.target.sessionId,
    targetThreadId: packet.source.threadId, text: receipt.text,
    receiptReported: true, authenticatedBinding: false, independentHost: false };
  executionGuard(context, options);
  writeOnce(path + '.reply.json', reply, 'REPLY_EXISTS');
  executionGuard(context, options);
  return reply;
}
export function inspectExchange(file, options) {
  const { path, record, packet } = loadExchange(file, options);
  const reply = statIfPresent(path + '.reply.json') ? readJson(path + '.reply.json', 4096) : null;
  if (reply && (!exactKeys(reply, ['nonce', 'requestId', 'digest', 'sourceSessionId', 'targetThreadId', 'text',
      'receiptReported', 'authenticatedBinding', 'independentHost']) ||
      reply.digest !== record.digest || reply.nonce !== packet.nonce || reply.requestId !== requestIdOf(packet) || reply.sourceSessionId !== packet.target.sessionId ||
      reply.targetThreadId !== packet.source.threadId || reply.text !== responseOf(packet) ||
      reply.authenticatedBinding !== false || reply.independentHost !== false || reply.receiptReported !== true))
    fail('INVALID_TRIAL', 'The candidate reply does not match.');
  return { packet, receiveAttempted: existsSync(path + '.receive-attempt'), reply,
    returnAttempted: existsSync(path + '.return-attempt'), independentHost: false };
}
/** The caller must corroborate actual Claude receipt BEFORE claiming and using app tools. */
function assertObservation(packet, observation) {
  if (!exactKeys(observation, ['requestId', 'nonce', 'text', 'sourceSessionId', 'operatorObservedReceipt']) ||
      observation.operatorObservedReceipt !== true)
    fail('RECEIPT_OBSERVATION_REQUIRED', 'A boolean/file alone cannot prove an exact request-scoped app receipt.');
  assertReceipt(packet, { requestId: observation.requestId, nonce: observation.nonce, text: observation.text });
  if (observation.sourceSessionId !== packet.target.sessionId) fail('RECEIPT_MISMATCH', 'The observed recipient changed.');
}
export function claimExchangeReturn(file, observation, options) {
  observation = observation && Object.freeze({ ...observation });
  const context = loadExchange(file, options), { path, record, packet } = context;
  assertObservation(packet, observation);
  executionGuard(context, options);
  const state = inspectExchange(file, options);
  if (!state.reply) fail('REPLY_REQUIRED', 'No explicit candidate reply exists.');
  executionGuard(context, options);
  writeOnce(path + '.return-attempt', { requestId: requestIdOf(packet), nonce: state.reply.nonce,
    digest: record.digest, state: 'claimed_before_app_send' }, 'ALREADY_ATTEMPTED');
  executionGuard(context, options);
  return { targetThreadId: exchangeTargets.codex, hostId: exchangeTargets.host,
    requestId: requestIdOf(packet), nonce: packet.nonce, text: state.reply.text,
    trust: 'external_untrusted', operatorMediated: true, independentHost: false };
}

/** Validate again immediately before app I/O. A prior claim is never permission to send late. */
export function validateExchangeReturn(file, observation, options) {
  const context = loadExchange(file, options), { path, record, packet } = context;
  assertObservation(packet, observation); executionGuard(context, options);
  const claim = readJson(path + '.return-attempt', 4096);
  if (!exactKeys(claim, ['requestId', 'nonce', 'digest', 'state']) || claim.requestId !== requestIdOf(packet) ||
      claim.nonce !== packet.nonce || claim.digest !== record.digest || claim.state !== 'claimed_before_app_send')
    fail('INVALID_TRIAL', 'The return claim does not match.');
  if (!inspectExchange(file, options).reply) fail('REPLY_REQUIRED', 'The observed reply disappeared before app I/O.');
  executionGuard(context, options);
}

/** Host callbacks only; this supplies no standalone app binding or live-relay enablement. */
export async function dispatchExchangeReturn(file, observation, adapter, options) {
  options = options && Object.freeze({ ...options });
  observation = observation && Object.freeze({ ...observation });
  const context = loadExchange(file, options);
  const signal = options?.signal, scope = new AbortController();
  let closed = false, writeStarted = false, timer, rejectLifecycle;
  const lifecycle = new Promise((_, reject) => { rejectLifecycle = reject; });
  void lifecycle.catch(() => {}); // Subscription-time aborts are observed even before race setup.
  const onAbort = () => {
    closed = true;
    try {
      persistTerminal(context, 'cancelled', options);
      rejectLifecycle(new BridgeError('CANCELLED', 'The exact pending request was cancelled.'));
    } catch (error) { rejectLifecycle(error); }
    scope.abort();
  };
  try {
    assertObservation(context.packet, observation);
    if (typeof adapter?.validateTarget !== 'function' || typeof adapter?.deliver !== 'function' ||
        (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')))
      fail('INVALID_INPUT', 'A supported host adapter and an actual AbortSignal are required.');
    const attempt = executionGuard(context, options);
    // Reserve before ANY asynchronous host work. Concurrent/restarted callers never retry it.
    writeOnce(context.path + '.return-dispatch', { requestId: requestIdOf(context.packet), nonce: context.packet.nonce,
      digest: context.record.digest, state: 'reserved_before_host_callbacks' }, 'ALREADY_ATTEMPTED');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort(); // Cover an abort racing subscription.
    executionGuard(context, options);
    const deadline = Math.min(context.packet.expiresAt, attempt.executionExpiresAt);
    const budget = deadline - clockOf(options)();
    if (budget <= 0) fail(deadline === context.packet.expiresAt ? 'EXPIRED' : 'EXECUTION_EXPIRED',
      'The request deadline passed before host verification.');
    timer = setTimeout(() => {
      closed = true;
      rejectLifecycle(new BridgeError(deadline === context.packet.expiresAt ? 'EXPIRED' : 'EXECUTION_EXPIRED',
        'The entire host operation exceeded its finite request deadline.'));
      scope.abort();
    }, budget);
    const operation = (async () => {
      const verified = await adapter.validateTarget(context.packet.source.threadId, { signal: scope.signal });
      if (closed) fail('DELIVERY_ABORTED', 'The host operation already ended.');
      if (verified?.targetId !== context.packet.source.threadId || verified.hostId !== context.packet.source.hostId || verified.simulation !== false)
        fail('TARGET_UNVERIFIED', 'The host did not verify this exact existing Codex target.');
      executionGuard(context, options);
      const claim = claimExchangeReturn(file, observation, options);
      const result = await adapter.deliver({ id: `return:${claim.requestId}`, pairId: claim.requestId,
        sender: 'claude', sourceId: context.packet.target.sessionId, targetId: claim.targetThreadId,
        text: claim.text, simulation: false, trust: 'external_untrusted' }, {
        signal: scope.signal,
        beforeWrite: () => {
          if (closed || writeStarted) fail('DELIVERY_ABORTED', 'This final write guard is closed or already consumed.');
          validateExchangeReturn(file, observation, options);
          if (closed || writeStarted) fail('DELIVERY_ABORTED', 'The host operation ended during final validation.');
          writeStarted = true;
        }
      });
      if (closed) fail('DELIVERY_ABORTED', 'The host operation already ended; its outcome is uncertain.');
      if (!writeStarted || result?.status !== 'unconfirmed') fail('INVALID_RECEIPT', 'A single guarded host write cannot certify recipient receipt.');
      return result;
    })();
    return await Promise.race([lifecycle, operation]);
  } catch (error) {
    closed = true;
    if (isDeniedError(error)) persistTerminal(context, 'denied', options);
    else if (isCancelledError(error)) persistTerminal(context, 'cancelled', options);
    throw error; // Reservation/claims survive EVERY outcome; no automatic retry.
  } finally {
    closed = true; clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort);
    scope.abort();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      file: { type: 'string' }, session: { type: 'string' }, nonce: { type: 'string' }, 'request-id': { type: 'string' }, response: { type: 'string' },
      'source-turn': { type: 'string' }, 'source-message': { type: 'string' }, 'source-text': { type: 'string' },
      'lifetime-ms': { type: 'string' }, 'operator-observed-receipt': { type: 'boolean' }
    } });
    if (positionals.length !== 1) fail('INVALID_INPUT', 'Select one one-shot operation.');
    const action = positionals[0]; let result;
    const allowed = {
      prepare: ['nonce', 'request-id', 'source-turn', 'source-message', 'source-text', 'lifetime-ms'],
      receive: ['file', 'session'], reply: ['file', 'session', 'nonce', 'request-id', 'response'],
      inspect: ['file'], 'claim-return': ['file', 'session', 'nonce', 'request-id', 'response', 'operator-observed-receipt'],
      cancel: ['file', 'request-id'], deny: ['file', 'request-id']
    }[action];
    if (!allowed || Object.keys(values).some(key => !allowed.includes(key))) fail('INVALID_INPUT', 'Unexpected option for this operation.');
    const receipt = { requestId: values['request-id'], nonce: values.nonce, text: values.response };
    const observation = { ...receipt, sourceSessionId: values.session, operatorObservedReceipt: values['operator-observed-receipt'] === true };
    if (action === 'prepare') result = prepareExchange({ nonce: values.nonce, requestId: values['request-id'], sourceTurnId: values['source-turn'],
      sourceMessageId: values['source-message'], sourceText: values['source-text'],
      lifetimeMs: values['lifetime-ms'] === undefined ? 1800000 : Number(values['lifetime-ms']) });
    else if (action === 'receive') { emitExchange(values.file, values.session, line => process.stdout.write(line)); }
    else if (action === 'reply') result = recordExchangeReply(values.file, values.session, receipt);
    else if (action === 'inspect') result = inspectExchange(values.file);
    else if (action === 'claim-return') result = claimExchangeReturn(values.file, observation);
    else if (action === 'cancel' || action === 'deny') result = terminateExchange(values.file, values['request-id'], action === 'deny' ? 'denied' : 'cancelled');
    else fail('INVALID_INPUT', 'Unknown one-shot operation.');
    if (action === 'claim-return') validateExchangeReturn(values.file, observation);
    if (action === 'reply') executionGuard(loadExchange(values.file));
    if (result) console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`${error.code ?? 'EXCHANGE_FAILED'}: One-shot exchange did not complete; do not retry uncertain sends.`);
    process.exitCode = 1;
  }
}
