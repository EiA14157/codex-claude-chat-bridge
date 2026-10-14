import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** Inspect only documented, normally inherited environment presence. No values escape. */
export function inspectClaudeChildCapabilities(env, selectedSessionId) {
  if (!env || typeof env !== 'object' || Array.isArray(env) ||
      typeof selectedSessionId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(selectedSessionId)) {
    throw new TypeError('Provide an environment object and an operator-selected session UUID.');
  }
  const present = key => typeof env[key] === 'string' && env[key].length > 0;
  return {
    readOnly: true,
    operatorSelectedSessionId: selectedSessionId,
    socketAdvertised: present('CLAUDE_CODE_MESSAGING_SOCKET'),
    sessionTokenAdvertised: present('CLAUDE_CODE_MESSAGING_TOKEN'),
    sessionBindingVerified: false,
    liveSendEnabled: false,
    note: 'Run from the selected Code session\'s own Bash tool. Presence is diagnostic only; it proves neither session identity, protocol compatibility, nor delivery.'
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { session: { type: 'string' } } });
    console.log(JSON.stringify(inspectClaudeChildCapabilities(process.env, values.session), null, 2));
  } catch {
    console.error('CAPABILITY_PROBE_FAILED: --session must be the operator-selected session UUID.');
    process.exitCode = 1;
  }
}
