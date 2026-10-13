# Validation record

Date: 2026-10-13. Environment: Linux cloud workspace, Node v24.19.0, Python 3.12.14 (packaging only).

## Passed

- `npm run check`: all four implementation files passed Node syntax checks; **24 local tests passed, 0 failed, 0 skipped**.
- `npm run demo`: both simulated directions, same-key deduplication, pause/resume/stop, and a blocked live send behaved as expected.
- `node --check integration/mcp.test.mjs`: the SDK integration test source parsed successfully.
- An independent read-only review exercised the relay's safety boundaries. Review findings drove fixes to SQLite insertion, disconnect/pre-write guards, explicit stdin EOF handling, deferred cleanup, and Windows-safe test cleanup. The MCP EOF behavior remains runtime-unverified until the SDK suite can run.

The 24 tests cover explicit two-way simulation, routing locks, durable deduplication, conflicting idempotency keys, Unicode byte limits, total message/hop/time limits, cross-pair parents, recipient acknowledgements, transport uncertainty, stalled adapters, crash recovery, consumer exclusion, SQLite persistence, pause/stop/expiry/disconnect before a write, and untrusted provenance. They also execute the standalone CLI demo.

## Blocked / not verified

- Official MCP SDK dependency installation: `npm install --ignore-scripts` was attempted; polling the operation returned **“automatic approval review was cancelled”**. One subsequently authorized retry used the same command with a project-specific temporary cache and again hit that cancellation. The retry log ends with HTTP 403 fetching `https://registry.npmjs.org/jose` dependency metadata. No dependency directory or lockfile resulted. No further retry or alternative download route was attempted.
- `npm run test:mcp`: fails at startup with `ERR_MODULE_NOT_FOUND` because `@modelcontextprotocol/sdk` is absent. No real-SDK test case ran. The authored tests cover stdio initialization, tool schemas, two-way fake-client flow, channel notification shape, simulation opt-in, and live-mode startup rejection, but these remain unverified until dependencies are installed and the suite is rerun.
- No real Claude Code session, channel opt-in, Codex desktop target, Windows machine, or external AI agent was connected or messaged.
- No real GUI injection, same-session delivery, application reconnect, or paid API usage was tested.

## Release interpretation

This verifies a local relay prototype and simulator only. It does not establish that the user's requested existing Codex desktop chat ↔ existing Claude Code session bridge works. All live pairs deliberately remain blocked. Source publication or successful unit tests cannot substitute for the missing application adapter and real-session acceptance evidence.
