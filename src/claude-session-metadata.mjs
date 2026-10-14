import { win32, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { BridgeError } from './adapters.mjs';

const titleOf = session => session?.customTitle || session?.summary;
const directory = value => typeof value === 'string' && win32.isAbsolute(value)
  ? win32.normalize(value).toLowerCase() : null;

/** Official SDK metadata lookup only. Stored metadata is never a live receipt. */
export async function identifyClaudeSession(sdk, { title, cwd, sessionId } = {}) {
  if (typeof title !== 'string' || !title.trim() || !directory(cwd) ||
      (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId)) ||
      typeof sdk?.listSessions !== 'function' || typeof sdk?.getSessionInfo !== 'function') {
    throw new BridgeError('INVALID_INPUT', 'Supply an exact title, absolute Windows project path, and official SDK metadata readers.');
  }
  const sessions = await sdk.listSessions();
  if (!Array.isArray(sessions)) throw new BridgeError('SESSION_UNVERIFIED', 'The SDK did not return a session list.');
  const matches = sessions.filter(session => titleOf(session) === title);
  if (!matches.length) throw new BridgeError('TARGET_NOT_FOUND', 'The exact title was not found in SDK metadata.');
  if (matches.length !== 1) throw new BridgeError('AMBIGUOUS_TARGET', 'More than one stored session has this exact title.');
  const candidate = matches[0];
  if (typeof candidate.sessionId !== 'string' || !candidate.sessionId ||
      directory(candidate.cwd) !== directory(cwd) || (sessionId && candidate.sessionId !== sessionId)) {
    throw new BridgeError('TARGET_MISMATCH', 'The stored session does not match the pinned ID and project.');
  }
  const verified = await sdk.getSessionInfo(candidate.sessionId, { dir: cwd });
  if (verified?.sessionId !== candidate.sessionId || titleOf(verified) !== title ||
      directory(verified.cwd) !== directory(cwd)) {
    throw new BridgeError('SESSION_UNVERIFIED', 'The individual metadata lookup changed or could not verify this session.');
  }
  return {
    sessionId: verified.sessionId, title, cwd: verified.cwd,
    readOnly: true, liveVerified: false,
    note: 'Stored SDK metadata identifies a candidate; it does not prove an active Code-tab inbox or message receipt.'
  };
}

// Optional diagnostic SDK lives outside this package. Never call query/resume/fork.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      'sdk-root': { type: 'string' }, title: { type: 'string' }, cwd: { type: 'string' },
      session: { type: 'string' }
    } });
    if (!values['sdk-root']) throw new BridgeError('SDK_REQUIRED', 'Supply the directory containing an installed official Claude Agent SDK.');
    const requireSdk = createRequire(join(resolve(values['sdk-root']), 'package.json'));
    const sdk = await import(pathToFileURL(requireSdk.resolve('@anthropic-ai/claude-agent-sdk')).href);
    console.log(JSON.stringify(await identifyClaudeSession(sdk, {
      title: values.title, cwd: values.cwd, sessionId: values.session
    }), null, 2));
  } catch (error) {
    console.error(`${error.code ?? 'METADATA_LOOKUP_FAILED'}: Read-only Claude session identification did not complete.`);
    process.exitCode = 1;
  }
}
