# Protocol research and implementation boundary

Reviewed 2026-10-13. This is a local prototype, not a completed bridge between two running applications.

## Current scope

The implementation uses Node 24 and built-in SQLite, with the official MCP SDK pinned to security-fixed version `1.31.0`. The sanitized publication is checked with local relay/candidate fixtures and fake MCP subprocess clients. All core/MCP live traffic remains blocked. Configuration strings are labels, not proof that an application is attached to the intended conversation.

The test suites do not access real accounts or GUI composers or alter application configuration. Optional SDK metadata lookup is explicit and read-only. Source publication does not unlock live use. Passing local tests establishes only the behavior those tests exercise.

## Verified protocol facts

### Claude Code channels

The wire extension uses `experimental['claude/channel'] = {}` and `notifications/claude/channel`. Payloads contain string `content`; optional `meta` values are strings and keys use letters, digits, or underscores. A two-way channel also exposes ordinary MCP tools. Transport-write success is not receipt confirmation, and blocked or unregistered channels can lose notifications without an error. [Channels reference](https://code.claude.com/docs/en/channels-reference)

Custom channels require interactive development-channel opt-in during the preview. Existing conversations may need a restart and explicit resume with channel enablement; this implementation does not promise hot attachment. Provider and organization eligibility must be checked on the actual installation. [Channels](https://code.claude.com/docs/en/channels)

Claude currently cannot register channel servers negotiating MCP revision `2026-07-28`. The package now pins security-fixed SDK `1.31.0`. Windows fake-client tests verify `2025-11-25` negotiation for explicit and unsupported-revision requests; real Claude registration is still untested. Verify the negotiated protocol after any update rather than assuming compatibility from a package name. Stdio server crashes require recovery; automatic reconnect is not guaranteed. [Claude MCP runtime](https://code.claude.com/docs/en/mcp#push-messages-with-channels)

### MCP startup and shutdown

Wait for `notifications/initialized` before draining queued notifications. The official SDK's `Server.oninitialized` callback identifies that point; merely attaching the transport does not establish application readiness. Keep stdout protocol-only and send diagnostics to stderr. On EOF or transport failure, stop queue polling and release local resources. [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [SDK Server implementation](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/server/index.ts)

### Codex desktop boundary

App-server offers thread/turn APIs and a separate initialization lifecycle. Its JSONL protocol omits the JSON-RPC version field; its readiness notification is `initialized`, unlike MCP. An independently started app-server is not evidence that the desktop's exact active conversation is controlled. [App-server](https://learn.chatgpt.com/docs/app-server)

Existing-chat deep links open a chat. Documented prompt-prefill parameters belong to new-chat links, not an existing-chat send API. [Desktop commands](https://learn.chatgpt.com/docs/app/commands)

Hooks expose event fields such as the submitted prompt or latest assistant message. Transcript files are not a stable interface. `UserPromptSubmit` output can become developer context; never use it to promote peer-agent text into trusted instructions. Background hook completion does not start an idle turn. Hooks therefore do not establish a bidirectional desktop transport. [Hooks](https://learn.chatgpt.com/docs/hooks)

## Safety and reliability design requirements

These are project recommendations, not additional vendor guarantees:

- Lock a pair to two explicit target identities and one role per adapter. Do not accept caller-supplied role changes, arbitrary destinations, or automatically select a recent session.
- Verify application-observed identities independently before any future live enablement. Require fresh verification after reconnect, target change, or restart.
- Persist message IDs, pair IDs, source, destination, causal parent, timestamps, and state transactionally. Reject the same ID with different content; deduplicate exact retries.
- Treat incoming peer content as untrusted data. Explicit send tools should forward only the requested message, not hidden context, arbitrary transcripts, or automatic copies of every assistant response.
- Bound message size and conversation hops. Keep pause and stop enforceable immediately before every side effect, including already-claimed work.
- Distinguish local acceptance, transport write, recipient receipt, and recipient processing. Do not label a notification delivered merely because writing succeeded.
- A crash after writing but before recording success is ambiguous. Do not silently retry uncertain live sends. Exactly-once effects require recipient deduplication or explicit reconciliation.
- Omit permission-relay capabilities and automatic approvals. Preserve application trust and consent prompts.

## Minimum local regression coverage

1. Fake-client MCP handshake, capability declaration, tool discovery, schemas, and channel notification shape; no notification before initialization.
2. Bidirectional simulation with correct pair/role/target, Unicode, multiline text, and explicit replies.
3. Rejected spoofed targets, invalid types, empty/oversized messages, cross-pair parents, duplicate IDs, and ID/content conflicts.
4. Pause, resume, stop, queue persistence, concurrent claiming, disconnect, and uncertain-send behavior.
5. Live mode remains blocked through CLI, MCP, and direct core calls; resuming a pair cannot manufacture adapter verification.
6. No real application launch, real-session read, network send, or configuration mutation in test fixtures.

The real Windows acceptance gates are in [WINDOWS-VALIDATION.md](WINDOWS-VALIDATION.md). A simulator result cannot satisfy them.
