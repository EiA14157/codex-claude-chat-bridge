import { BridgeError } from './service.mjs';
/** Distinct wire shapes: DOM permit returns a scoped permit; popup commands return values. */
export function createHandler({ service, transport, extensionId, popupUrl }) {
  return async (message, sender) => {
    try {
      if (sender?.id !== extensionId) throw new BridgeError('DENIED');
      if (message?.type === 'dom:permit') return await transport.permit(message, sender);
      if (sender.url !== popupUrl || sender.tab) throw new BridgeError('DENIED');
      let value;
      switch (message?.type) {
        case 'state': value = await service.state(); break;
        case 'bindMock': value = await service.bind({ kind: 'mock', id: crypto.randomUUID(), label: 'Local mock only' }); break;
        case 'bindCurrent': await service.stop(); value = await service.bind(await transport.bindCurrent(message.contract)); break;
        case 'prepare': value = await service.prepare(message.text); break;
        case 'send': value = await service.send(message.requestId, message.text); break;
        case 'receive': value = await service.receive(message.requestId); break;
        case 'cancel': value = await service.terminate(message.requestId); break;
        case 'deny': value = await service.terminate(message.requestId, 'denied'); break;
        case 'stop': value = await service.stop(); break;
        case 'mockTrial': value = await service.mockTrial(); break;
        default: throw new BridgeError('INVALID_COMMAND');
      }
      return { ok: true, value };
    } catch (error) { return { ok: false, code: error.code ?? 'UNKNOWN_ERROR' }; }
  };
}
