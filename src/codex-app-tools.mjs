import { BridgeError, renderExternalMessage, isDeniedError, isCancelledError } from './adapters.mjs';

function payload(result) {
  if (result?.isError) throw new BridgeError('APP_TOOL_ERROR', 'The Codex app tool reported an error.');
  if (result?.structuredContent) return result.structuredContent;
  if (result?.thread) return result;
  const blocks = result?.content?.filter(block => block.type === 'text');
  if (blocks?.length !== 1) throw new BridgeError('APP_TOOL_FORMAT', 'Expected one structured app-tool response.');
  try { return JSON.parse(blocks[0].text); }
  catch { throw new BridgeError('APP_TOOL_FORMAT', 'The app-tool response was not structured JSON.'); }
}

/**
 * Candidate for a Codex tool host, NOT a standalone desktop connection.
 * The host supplies the supported read_thread / send_message_to_thread tools.
 * No private IPC, app-server launch, transcript read, or keyboard input is used.
 * Relay.liveGuard remains blocked until real two-target acceptance is completed.
 */
export class CodexAppToolAdapter {
  name = 'codex-app-tools';
  #threadId; #hostId; #read; #send; #authorize; #attempts = new Map();

  constructor({ threadId, hostId, readThread, sendMessageToThread, authorizeSend } = {}) {
    if (typeof threadId !== 'string' || !threadId || typeof hostId !== 'string' || !hostId ||
        typeof readThread !== 'function') {
      throw new BridgeError('INVALID_INPUT', 'Pin an existing thread, its host, and a supported reader.');
    }
    this.#threadId = threadId; this.#hostId = hostId;
    this.#read = readThread; this.#send = sendMessageToThread; this.#authorize = authorizeSend;
  }

  async validateTarget(expected) {
    if (expected !== this.#threadId) throw new BridgeError('TARGET_MISMATCH', 'The exact Codex target changed.');
    const { thread } = payload(await this.#read({
      threadId: this.#threadId, hostId: this.#hostId, turnLimit: 1, includeOutputs: false
    }));
    if (thread?.id !== this.#threadId || thread?.hostId !== this.#hostId || thread?.kind !== 'codex') {
      throw new BridgeError('TARGET_UNVERIFIED', 'The app did not report the pinned Codex thread and host.');
    }
    if (thread.status?.type !== 'idle') {
      throw new BridgeError('TARGET_BUSY', 'The selected thread is active or its idle state is unknown.');
    }
    return { targetId: this.#threadId, hostId: this.#hostId, simulation: false };
  }

  async deliver(envelope, { beforeWrite } = {}) {
    // Keep authorization and transmitted content identical across awaited host calls.
    envelope = envelope && Object.freeze({ ...envelope });
    if (!envelope || envelope.sender !== 'claude' || envelope.targetId !== this.#threadId ||
        typeof envelope.id !== 'string' || !envelope.id || typeof envelope.text !== 'string' || !envelope.text.trim()) {
      throw new BridgeError('INVALID_INPUT', 'Expected one explicit Claude message to the pinned Codex thread.');
    }
    if (envelope.simulation !== false) {
      throw new BridgeError('SIMULATION_TO_LIVE_FORBIDDEN', 'Simulated messages cannot be sent into a real app.');
    }
    const fingerprint = JSON.stringify(envelope);
    const previous = this.#attempts.get(envelope.id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new BridgeError('IDEMPOTENCY_CONFLICT', 'Message ID content changed.');
      if (previous.status === 'unconfirmed') return { status: 'unconfirmed', receipt: null };
      if (previous.status === 'denied') throw new BridgeError('LIVE_NOT_AUTHORIZED', 'This exact request was denied; a distinct authorized request is required.');
      if (previous.status === 'cancelled') throw new BridgeError('DELIVERY_ABORTED', 'This exact request was cancelled; it cannot be restarted.');
      throw new BridgeError('DELIVERY_UNKNOWN', 'This message already had an attempt; never retry it automatically.');
    }
    if (typeof this.#send !== 'function' || typeof this.#authorize !== 'function' || typeof beforeWrite !== 'function') {
      throw new BridgeError('LIVE_NOT_AUTHORIZED', 'A trusted host send decision and relay pre-write guard are required.');
    }
    if (this.#attempts.size >= 128) throw new BridgeError('MESSAGE_LIMIT', 'Adapter attempt budget reached.');
    // Reserve before asynchronous preparation so concurrent duplicate calls cannot both send.
    const attempt = { fingerprint, status: 'preparing' };
    this.#attempts.set(envelope.id, attempt);
    try {
      if (await this.#authorize(Object.freeze({
        threadId: this.#threadId, hostId: this.#hostId, messageId: envelope.id,
        pairId: envelope.pairId, text: envelope.text
      })) !== true) throw new BridgeError('LIVE_NOT_AUTHORIZED', 'The host did not authorize this exact message.');
      await this.validateTarget(envelope.targetId);
      const prompt = renderExternalMessage(envelope);
      const guarded = beforeWrite();
      if (guarded && typeof guarded.then === 'function') {
        void Promise.resolve(guarded).catch(() => {});
        throw new BridgeError('INVALID_GUARD', 'The relay pre-write guard must be synchronous.');
      }
      attempt.status = 'attempting';
      const response = await this.#send({ threadId: this.#threadId, hostId: this.#hostId, prompt });
      if (!response || response.isError) throw new BridgeError('APP_TOOL_ERROR', 'Send outcome is not confirmed.');
      attempt.status = 'unconfirmed';
      // Tool acceptance never proves receipt. Only the locked recipient can acknowledge.
      return { status: 'unconfirmed', receipt: null };
    } catch (error) {
      if (attempt.status === 'preparing' && isDeniedError(error)) attempt.status = 'denied';
      else if (attempt.status === 'preparing' && isCancelledError(error)) attempt.status = 'cancelled';
      else if (attempt.status === 'preparing') this.#attempts.delete(envelope.id); // Recoverable preparation failure; no write began.
      else attempt.status = 'unknown';
      throw error;
    }
  }
}
