import { BridgeService } from './service.mjs';
import { BrowserTransport } from './transports.mjs';
import { createHandler } from './commands.mjs';
// Content scripts use only the message gate; durable state stays in trusted extension contexts.
const ready = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
void ready.catch(() => {});
const transport = new BrowserTransport(chrome);
const service = new BridgeService({ storage: {
  read: async () => (await chrome.storage.local.get('bridge')).bridge,
  write: async data => { await chrome.storage.local.set({ bridge: data }); }
}, transport });
const handle = createHandler({ service, transport, extensionId: chrome.runtime.id, popupUrl: chrome.runtime.getURL('popup.html') });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  ready.then(() => handle(message, sender)).then(respond, () => respond({ ok: false, code: 'STORAGE_ISOLATION_FAILED' }));
  return true;
});
