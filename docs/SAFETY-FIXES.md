# Safety corrections

This snapshot retains corrections exercised with synthetic endpoints; actual conversation IDs, private review records and logs are excluded.

- Immutable-message refusal/cancellation is terminal. Error classification covers initial target validation and delivery consistently.
- Relay dispatch checks the persisted absolute delivery deadline, pair state and lease immediately before one effect.
- One-shot operations recheck deadlines/terminal state after durable I/O. Reply requires the exact request ID, nonce and observed response.
- Return reservation precedes asynchronous host preparation. Cancellation settles pending work promptly and a finite deadline bounds the whole operation.
- Final guards are single-use and close on every outcome. Unknown attempts persist without automatic retry/reset.
- SQLite ancestor, database and sidecar checks reject link/nonregular redirection. These are not atomic no-follow or same-user isolation guarantees.
- MCP still closes transport/database and exits naturally when lease release fails.

Published one-shot targets are explicit fixture labels, not account mappings or live attachment. Core/MCP live gates stay closed.

The separate MV3 candidate ports these principles to browser metadata storage and a scoped DOM permit. Storage failure prevents late writes without certifying persistence success. Restart recovery disarms and retains unknown attempts. Only the exact requested nonce enters the local inbox; no automatic forward/self-message loop exists.

Extension review is in progress. Fixtures do not establish Chrome/Edge operation, real Grok support, authenticated receipt or the desktop bridge. Unsupported editor/frame and permission boundaries are documented in the extension directory.
