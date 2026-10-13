# Architecture

The core is transport-independent. `Relay` owns immutable pair settings, transactional state, pair-wide budgets, causal message links, leases, and a body-free audit trail. The SQLite database is the shared local coordination point for separate stdio processes. No public or loopback HTTP listener is needed.

`SimulationAdapter` records messages in memory and can issue a synthetic receipt. `ClaudeChannelAdapter` formats the documented channel notification but only returns `unconfirmed`; a later `bridge_ack` reports receipt. `CodexDesktopUnavailable` always rejects real delivery. The core independently rejects every live pair, so selecting the simulator cannot bypass the live gate.

## Extending an adapter

An adapter must provide:

- `validateTarget(expected)`: verify the target through the application, returning the exact target identity. For this release only simulation validation is accepted. A config value alone is not live verification.
- `deliver(envelope, { beforeWrite })`: call `beforeWrite()` immediately before any irreversible transmission, then return a truthful outcome. Never retry internally. Honor timeout/disconnect cancellation before I/O.
- An independently supported receipt path. A successful notification write must remain `unconfirmed`.

An adapter must not scan transcripts, create substitute conversations, discover arbitrary recent sessions, or use an undocumented GUI API. The existing stub must not be replaced by a permissive boolean switch. Live support requires source/recipient identity verification, policy review, and end-to-end evidence, not just transport implementation.

## Failure behavior

SQLite uses `BEGIN IMMEDIATE`, WAL, foreign keys, a busy timeout, and full synchronization. A dispatch is committed before I/O. Only one current consumer lease can own each pair/role. Any outstanding dispatch or uncertain result applies pair-wide backpressure.

If a process crashes after claiming a message, timeout changes it to `unknown` and pauses the pair. That intentionally prefers possible non-delivery over duplicate external actions. Exactly-once external delivery is not promised. Leases prevent ordinary accidental duplicate local consumers, not malicious processes that can edit the database.

Acknowledgements report observation only. They do not approve message contents, tool calls, contracts, or data sharing. There is no approval tool, permission capability, autonomous echo loop, or message forwarding hook.
