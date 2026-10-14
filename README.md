# Codex chat bridge prototypes

A local relay and a separate Chromium extension candidate for explicitly selected conversations. **The automatic Codex desktop bridge is incomplete. Core/MCP live pairs remain blocked. The extension's real Grok site support, installation and native Codex binding are unverified; independent extension review is in progress.**

## Components

| Component | Scope |
| --- | --- |
| **[Bridge rooms](rooms/README.md)** | **Working: user-selected Claude Code ↔ Codex conversations via MCP; dashboard; channel nudges; Grok Bot CLI/HTTP paths. See [dev log](docs/ROOMS-DEVLOG.md)** |
| Node 24 SQLite relay and CLI | Immutable routing, deduplication, leases, budgets, expiry, pause/stop and simulator |
| Official MCP SDK stdio server | Simulation-only fake-client integration; security-fixed SDK `1.31.0` |
| Codex app-tool candidate | Injected supported host callbacks and per-message authorization; no standalone binding |
| Claude channel/Monitor/metadata candidates | Legacy research and offline fixtures; no live registration |
| One-shot lifecycle | Scoped receipts, durable denial/cancellation, pre-host reservation, deadlines and single-use guards; **published targets are synthetic fixtures** |
| [Selected-tab extension](browser-extension/README.md) | MV3 popup, explicit DOM contract, one send, manual receive, cancel/deny/stop and logs |

The extension direction is a user-selected Grok browser target. The actual product, Bot and conversation are not yet identified. No private vendor endpoint or selector is guessed. Extension-only work does not supply a Codex desktop/native adapter.

## Checks

Node 24 is required. Core and extension checks use built-in modules:

```sh
npm run check
npm run test:extension
npm run audit:package
npm run demo
```

For fake-client MCP tests, use the normal approved dependency installation if needed:

```sh
npm ci --ignore-scripts
npm run test:mcp
```

MCP clients are fake subprocesses, not real accounts. Do not register this simulation server or `--allow-simulation` in a real app. No live configuration is supplied.

## Extension candidate

See [source and deferred installation](browser-extension/README.md) and [DOM contract](browser-extension/docs/DOM-CONTRACT.md). Permissions are only `activeTab`, `scripting`, `storage`; no persistent host permission, cookies, credential collection, background scraping, clipboard or native messaging.

Visible actions require explicit selection. Request metadata and states persist rather than message bodies. Defaults are two-minute expiry and 12 cumulative requests. Uncertain writes are never retried, worker restart disarms, and receipts stay in the browser inbox. No automatic reply forwarding.

No extension installation, real account transmission, persistent permission, paid model call or store publication occurred. Browser rendering was blocked by the available runtime; fixtures do not replace browser acceptance.

## Validation and privacy

See [validation](docs/VALIDATION.md), [safety corrections](docs/SAFETY-FIXES.md), [architecture](docs/ARCHITECTURE.md), [protocol boundaries](docs/PROTOCOL-RESEARCH.md), and [Windows acceptance](docs/WINDOWS-VALIDATION.md). Review findings will receive follow-up commits; the extension is not independently accepted.

This snapshot contains source, synthetic fixtures and portable docs. Actual conversation/session IDs, personal titles, live-trial records, machine-specific paths, logs, caches, browser profiles and credentials are excluded. Original private local work is preserved separately. Old requests must never be reused.

Peer text is external/untrusted and never user consent. A write/click is unconfirmed; a DOM nonce is not vendor authentication. Already-started effects cannot be retracted. Same-user writable files/storage are not authentication boundaries.
