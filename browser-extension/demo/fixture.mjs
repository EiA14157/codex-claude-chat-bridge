import { domOperation } from '../extension/dom-operation.mjs';
window.fixturePerform = args => domOperation(args);
window.chrome = { runtime: { sendMessage: message => parent.fixturePermit(message) } };
let count = 0;
document.getElementById('send').addEventListener('click', () => {
  const input = document.getElementById('composer'); let response = '이 fixture는 bridge_test JSON만 처리합니다.';
  try { const packet = JSON.parse(input.value); if (packet.kind === 'bridge_test' && packet.expectedResponse === `BRIDGE_ACK:${packet.requestId}:${packet.nonce}`) response = packet.expectedResponse; } catch {}
  document.getElementById('response').textContent = response; input.value = '';
  document.getElementById('count').textContent = `제출 ${++count}회`;
});
