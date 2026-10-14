import { BridgeService } from '../extension/service.mjs';
import { BrowserTransport } from '../extension/transports.mjs';
import { mountUI } from '../extension/ui.mjs';
import { createHandler } from '../extension/commands.mjs';
const frame = document.getElementById('fixture');
if (!frame.contentWindow.fixturePerform) await new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
const api = {
  tabs: { query: async () => [{ id: 1 }] },
  scripting: { executeScript: async call => {
    if (call.target.tabId !== 1 || (call.target.documentIds && call.target.documentIds[0] !== 'owned-fixture-document')) throw Error('Fixture target changed');
    return [{ documentId: 'owned-fixture-document', result: await frame.contentWindow.fixturePerform(call.args[0]) }];
  } }
};
const transport = new BrowserTransport(api), storage = { data: null, read: async () => structuredClone(storage.data), write: async value => { storage.data = structuredClone(value); } };
const service = new BridgeService({ storage, transport });
const popupUrl = 'chrome-extension://owned-fixture/popup.html', extensionId = 'owned-fixture';
const handle = createHandler({ service, transport, extensionId, popupUrl });
window.fixturePermit = message => handle(message, { id: extensionId, tab: { id: 1 }, documentId: 'owned-fixture-document', frameId: 0, url: frame.contentWindow.location.href });
const command = async message => {
  const result = await handle(message, { id: extensionId, url: popupUrl });
  if (!result.ok) throw Object.assign(new Error(result.code), { code: result.code }); return result.value;
};
mountUI(document, command);
