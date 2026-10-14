#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Relay, dispatchOne, BridgeError } from './core.mjs';
import { ClaudeMonitorStdoutAdapter } from './adapters.mjs';

/** Readiness probe only: the label is operator-supplied, never runtime identity. */
export function renderMonitorProbe(sessionId, nonce) {
  if (typeof sessionId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(sessionId) ||
      typeof nonce !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(nonce))
    throw new BridgeError('INVALID_INPUT', 'A selected session UUID and a unique safe nonce are required.');
  return JSON.stringify({ kind: 'bridge_monitor_probe', trust: 'external_untrusted',
    source: 'monitor_self_probe', peerDelivery: false,
    operatorSelectedSessionId: sessionId, sessionBindingVerified: false, nonce,
    scope: 'receipt_only', expectedResponse: 'nonce_once'
  }) + '\n';
}

/** Bounded, one-message Monitor command candidate. Existing live gate is unchanged. */
export async function monitorOne(relay, {
  pairId, targetId, writeLine, allowSimulation = false,
  durationMs = 300000, pollMs = 250, signal, now = () => Date.now(), owner = randomUUID()
}) {
  const pair = relay.target(pairId, 'claude', targetId);
  relay.liveGuard(pair);
  if (!allowSimulation) throw new BridgeError('SIMULATION_OPT_IN_REQUIRED', 'This command is an offline Monitor candidate, not a live app connection.');
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 1800000 ||
      !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1000) {
    throw new BridgeError('INVALID_INPUT', 'Use a finite deadline up to 30 minutes and polling from 1 to 1000 ms.');
  }
  const deadline = now() + durationMs;
  const stdout = new ClaudeMonitorStdoutAdapter(writeLine, targetId, true);
  const adapter = {
    name: stdout.name,
    validateTarget: target => stdout.validateTarget(target),
    deliver: (message, { beforeWrite }) => stdout.deliver(message, { beforeWrite: () => {
      if (signal?.aborted || now() >= deadline) throw new BridgeError('DELIVERY_ABORTED', 'Monitor stopped before output.');
      beforeWrite();
    } })
  };
  try {
    while (!signal?.aborted && now() < deadline) {
      relay.housekeep(pairId);
      if (relay.pair(pairId).status !== 'active') return { reason: 'inactive', emitted: false };
      const message = await dispatchOne(relay, pairId, 'claude', targetId, owner, adapter);
      if (message) return { reason: 'attempt_finished', emitted: message.status === 'unconfirmed', messageId: message.id, status: message.status };
      await delay(Math.min(pollMs, Math.max(1, deadline - now())), undefined, { signal }).catch(error => {
        if (error.name !== 'AbortError') throw error;
      });
    }
    return { reason: signal?.aborted ? 'cancelled' : 'deadline', emitted: false };
  } finally { relay.release(pairId, 'claude', owner); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let relay;
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      db: { type: 'string' }, pair: { type: 'string' }, target: { type: 'string' },
      'duration-ms': { type: 'string' }, 'allow-simulation': { type: 'boolean', default: false },
      'message-id': { type: 'string' }, 'client-id': { type: 'string' }, text: { type: 'string' },
      'in-reply-to': { type: 'string' }, session: { type: 'string' }, nonce: { type: 'string' }
    } });
    const action = positionals[0];
    if (action === 'probe' && positionals.length === 1) {
      if (Object.keys(values).some(key => !['session', 'nonce', 'allow-simulation'].includes(key)) || values['allow-simulation'])
        throw new BridgeError('INVALID_INPUT', 'A probe does not take relay or simulation options.');
      process.stdout.write(renderMonitorProbe(values.session, values.nonce));
    } else {
      if (!['watch', 'ack', 'send'].includes(action) || positionals.length !== 1 || !values.db || !values.pair || !values.target)
        throw new BridgeError('INVALID_INPUT', 'Use probe with session/nonce or watch|ack|send with db, pair, and locked target.');
      relay = new Relay(values.db);
      const pair = relay.target(values.pair, 'claude', values.target);
      relay.liveGuard(pair);
      if (!values['allow-simulation']) throw new BridgeError('SIMULATION_OPT_IN_REQUIRED', 'Only explicitly opted-in offline fixtures can use this candidate.');
      if (action === 'watch') {
        const abort = new AbortController();
        process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort());
        const result = await monitorOne(relay, {
          pairId: values.pair, targetId: values.target, allowSimulation: true,
          durationMs: values['duration-ms'] === undefined ? 300000 : Number(values['duration-ms']),
          signal: abort.signal, writeLine: line => process.stdout.write(line)
        });
        console.error(JSON.stringify(result)); // stdout is exclusively one untrusted event line.
      } else if (action === 'ack') {
        const result = relay.ack(values.pair, 'claude', values.target, values['message-id']);
        console.log(JSON.stringify({ messageId: result.id, status: result.status, simulation: true }));
      } else {
        const result = relay.send({ pairId: values.pair, sender: 'claude', targetId: pair.codex_target,
          clientId: values['client-id'], text: values.text, inReplyTo: values['in-reply-to'] ?? null });
        console.log(JSON.stringify({ messageId: result.id, status: result.status, duplicate: result.duplicate, simulation: true }));
      }
    }
  } catch (error) {
    console.error(`${error.code ?? 'MONITOR_FAILED'}: Monitor candidate operation did not complete.`);
    process.exitCode = 1;
  } finally { relay?.close(); }
}
