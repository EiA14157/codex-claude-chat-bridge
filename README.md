# Codex ↔ Claude Chat Bridge

**Cloud-local prototype. The requested live desktop-to-session bridge is not complete.**

목표는 **기존 Codex 데스크톱 앱 대화 ↔ 기존 Claude Code 세션** 사이에 두 에이전트가 필요할 때 직접 메시지를 보내는 것입니다. 고정된 리뷰어/코더 역할이나 별도 Codex CLI 대화로 대체하지 않습니다.

현재는 안전한 로컬 릴레이와 양방향 시뮬레이터까지 구현했습니다. **같은 Codex 앱 대화에 입력하는 검증된 연결 방법이 없어 실제 전송은 차단됩니다.** Claude의 실제 세션 연결도 검증하지 않았습니다.

## Implementation status / 구현 상태

| Component | Status |
| --- | --- |
| SQLite relay, message IDs, deduplication, exact target locks | Implemented; local tests pass |
| Explicit two-way sends with no fixed agent roles | Implemented in simulation |
| Limits, pause/stop, timeout and uncertain-delivery handling | Implemented; local tests pass |
| Claude channel payload adapter | Implemented; tested with an in-memory fake transport |
| Official-SDK MCP stdio server | Written; dependency install blocked, runtime integration **not run** |
| Existing Codex desktop chat adapter | **Unavailable; all live pairs fail closed** |
| Existing Claude Code session / Windows acceptance | **Not run** |
| Real end-to-end bidirectional chat | **Not complete** |

This package opens no listening port, scans no application sessions, launches no AI client, and calls no paid model API. It does not create a substitute Codex CLI conversation.

## Run the verified local demo

Requires **Node 24**. The core and demo use only built-in modules, including `node:sqlite`.

```sh
node --version
npm test
npm run check
npm run demo
```

No `npm install` is needed for those commands. The demo uses a disposable SQLite database and simulated endpoints, then removes its own temporary files. Expected output includes:

```text
SIMULATION ONLY — no live app/session or paid API is contacted.
Codex → Claude: acknowledged (...)
Claude → Codex: acknowledged (...)
Same-key retry: duplicate=true; total messages=2
Pause: paused
Stop: stopped
Live GUI guard: CODEX_GUI_UNAVAILABLE (expected; zero live messages sent)
```

시뮬레이터의 `acknowledged`는 가짜 수신 측의 확인입니다. 실제 앱 수신 성공을 뜻하지 않습니다.

## Optional SDK integration tests

After dependency installation is authorized in your own development environment:

```sh
npm install --ignore-scripts
npm run test:mcp
```

`@modelcontextprotocol/sdk` is pinned to `1.28.0`. Dependency installation in the cloud build was cancelled by the tool approval review. One subsequently authorized retry encountered the same cancellation; its npm log ended with HTTP 403 while fetching `jose` dependency metadata. No further retry or alternate download route was used. No dependencies or lockfile were produced, so these subprocess integration tests are **unverified**, and `test:mcp` fails visibly while the SDK is absent. After a successful install, retain/review the generated lockfile for reproducible subsequent `npm ci` runs. These tests use local fake MCP clients, not real Codex or Claude sessions.

## Local pair controls

```sh
node src/cli.mjs init --db .bridge/demo.sqlite --pair demo --codex sim-codex --claude sim-claude --mode simulation
node src/cli.mjs status --db .bridge/demo.sqlite --pair demo
node src/cli.mjs pause --db .bridge/demo.sqlite --pair demo
node src/cli.mjs resume --db .bridge/demo.sqlite --pair demo
node src/cli.mjs stop --db .bridge/demo.sqlite --pair demo
```

Targets and limits cannot be changed after creating a pair. Defaults: 12 total messages, 16,384 UTF-8 bytes per message, 8 reply hops, 30-minute lifetime, 30-second delivery timeout. New roots do not reset the total message budget. Stopped/expired pairs cannot restart. Resume is operator-only, not an agent tool.

`init` defaults to `--mode live`, which creates a blocked pair. Neither `resume` nor an MCP flag unlocks that mode.

## MCP test surface

`src/mcp.mjs` binds its role and target at process startup. Tools cannot choose arbitrary recipients or impersonate the other role:

- `bridge_send`: explicitly enqueue one peer message with an idempotency key
- `bridge_ack`: report receipt, never approval or agreement
- `bridge_status`, `bridge_pause`, `bridge_stop`
- `bridge_receive_simulated`: Codex-side fake-client inbox only; **not GUI injection**

The Claude-side server declares `claude/channel` and emits `notifications/claude/channel` after MCP initialization. It omits the permission-relay capability entirely. No credential reader, transcript scanner, or automatic approval handling is implemented. Explicitly supplied message text is stored in plaintext and must exclude secrets.

The `--allow-simulation` switch is for the test harness. **Do not add it to a real application's MCP configuration.** This prototype intentionally provides no copy-paste live application configuration.

## Delivery semantics

```text
queued → dispatching → unconfirmed → acknowledged
                   ↘ unknown (pair pauses; no automatic retry)
queued → cancelled / expired
dispatching → blocked (a pre-write guard prevented I/O)
```

A transport write is not proof of receipt. Once an attempt is ambiguous, it is never requeued. A repeated identical idempotency key returns the existing message state, not a new send. The recipient may acknowledge an uncertain message; resuming afterward still requires the operator. Otherwise stop the pair and investigate locally. Starting a new pair must not be used to blindly resend an uncertain message.

Pause, stop, expiry, timeout, and lease loss are checked again immediately before adapter I/O. An already-started write cannot be retracted. The adapter contract requires this pre-write check; third-party adapters must not ignore it.

## Security and limits

Peer text is explicitly marked external/untrusted and JSON-encoded separately from provenance. It is never promoted into system/developer instructions or treated as user authorization. This labeling helps recipients distinguish provenance; it is **not** a guarantee against model prompt injection. Keep the original clients' approval boundaries.

The database contains plaintext message bodies. Use a private local directory, do not commit or sync it publicly, and do not send secrets. New files use restrictive POSIX modes; Windows protection depends on the directory's ACL. The relay is not a security boundary against another process with the same filesystem access. A configured target ID is a routing label, not proof of an application's live identity.

## What must happen before real use

1. Implement and independently validate a supported adapter to the **same existing Codex desktop chat**, including target identity and reconnect behavior.
2. Verify Claude's channel eligibility, session-specific opt-in, identity, and protocol compatibility. Enabling a channel may require restarting/resuming the selected session.
3. Complete the [Windows acceptance checklist](docs/WINDOWS-VALIDATION.md) with authorized harmless messages in both directions.

See [protocol findings](docs/PROTOCOL-RESEARCH.md), [verification record](docs/VALIDATION.md), and [architecture](docs/ARCHITECTURE.md).
