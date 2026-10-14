import { mountUI } from './ui.mjs';
mountUI(document, async message => {
  const reply = await chrome.runtime.sendMessage(message);
  if (!reply?.ok) throw Object.assign(new Error(reply?.code ?? 'UNKNOWN_ERROR'), { code: reply?.code ?? 'UNKNOWN_ERROR' });
  return reply.value;
});
