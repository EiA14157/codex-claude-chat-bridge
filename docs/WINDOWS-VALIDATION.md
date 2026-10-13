# Windows validation plan

Status: **NOT RUN on Windows. No live Codex desktop / Claude Code pair has been validated.**

This checklist is a future, explicitly authorized validation plan. It does not enable live mode or authorize installation, configuration changes, application launches, or message transmission. The current release must stop at the missing Codex GUI adapter gate.

## 1. Validate the package in isolation

Use a user-selected local working directory and a dedicated test database. Do not inspect application session directories or copy existing transcripts. Record Windows version, Node version, package revision, the generated lockfile hash, and test output. This cloud build has no lockfile because dependency installation did not complete.

With Node 24 already available and dependency installation authorized, the package commands are:

```powershell
node --version
npm install --ignore-scripts
npm run check
npm test
npm run test:mcp
npm run demo
```

Require a successful result for every command. These commands are local checks and fake-endpoint simulation; they must not launch Claude Code or Codex desktop, alter their configurations, or send real messages. Record skipped and blocked checks separately from passing checks.

Repeat the fake-client tests from a directory containing spaces and non-ASCII characters. Check JSON escaping of Windows paths, process argument handling, Unicode round-trips, stdout purity, EOF cleanup, and SQLite persistence/locking. Use disposable fixture data only.

## 2. Confirm the live fail-closed boundary

Create a disposable live-mode pair with visibly synthetic identifiers:

```powershell
node src/cli.mjs init --db .\live-gate-test.sqlite --pair live-gate-test --codex fixture-codex --claude fixture-claude --mode live
node src/cli.mjs status --db .\live-gate-test.sqlite --pair live-gate-test
node src/cli.mjs resume --db .\live-gate-test.sqlite --pair live-gate-test
node src/cli.mjs status --db .\live-gate-test.sqlite --pair live-gate-test
```

Expected outcome: live readiness remains blocked. A rejected resume is acceptable; an enabled live route is a test failure. The synthetic identifiers must never trigger application discovery or attachment. Verify that every attempted live send remains blocked through all exposed interfaces. Do not edit the database or source to bypass the gate.

`--allow-simulation` on the MCP executable is for fake-client fixtures only. Never put that flag in a real application's MCP configuration or treat it as an enablement path for live traffic.

## 3. Stop until a supported Codex desktop adapter exists

Before implementation can progress beyond simulation, obtain all of the following:

- A documented supported transport into the exact existing desktop chat, with observed thread identity and read/write behavior.
- Evidence that it preserves the selected conversation instead of creating a separate CLI session, replacement conversation, or fork.
- Application-observed identity verification at connection time. A configured thread ID, matching title, process name, or local database label is insufficient.
- A clear routing and consent boundary for both directions, including disconnect, concurrent user activity, and target switching.

Do not substitute keyboard injection, clipboard automation, process-memory access, private endpoints, transcript/session scans, or a new app-server process presented as the same GUI runtime. See [protocol research](PROTOCOL-RESEARCH.md) and the primary [desktop commands](https://learn.chatgpt.com/docs/app/commands) and [app-server](https://learn.chatgpt.com/docs/app-server) documentation.

## 4. Future real-session acceptance, only after the gate is solved

This section remains **NOT RUN** and is not executable with this release.

1. Obtain explicit authorization for the exact two targets, message categories, and any persistent access/configuration changes. Record application versions without collecting credentials.
2. Have the user identify the existing Claude session. Verify it through a supported application surface. Arrange any required interactive channel opt-in and restart/resume; do not claim hot attachment. Honor organization policy and local trust/consent prompts. [Claude channels](https://code.claude.com/docs/en/channels)
3. Confirm target identities again after connection. Inspect negotiated protocol and registered capabilities. Do not automatically alter global runtime settings to resolve incompatibilities.
4. With approved non-sensitive test text, send a unique nonce in each direction. Observe receipt in the actual selected conversation and correlate the reply with its parent ID. A tool's success string alone is insufficient.
5. Test pause, stop, disconnect/reconnect, duplicate input, queued work, active-turn contention, and wrong-target rejection. Verify no unrequested third-party communication or automatic approval occurs.
6. Record evidence for each direction independently. Claim full bidirectional completion only when both existing targets visibly receive messages, identity checks hold, and the safety tests pass.

Stop immediately for a wrong or unverifiable target, unexpected consent request, ambiguous send result, repeated-message loop, policy block, protocol mismatch, or persistence failure. Preserve the minimal local diagnostic record and request the missing decision; do not retry uncertain transmissions automatically.
