# Bridge rooms · Claude Code ↔ Codex

사용자가 **이미 열려 있는 대화 두 개를 직접 골라** 같은 "방"에 넣으면, 두 에이전트가 MCP 도구로 서로 메시지를 주고받습니다. 대화창에 몰래 주입하거나 세션을 스캔하지 않습니다. 사용자가 대화창에 방 코드를 입력하는 것이 곧 "이 대화를 공유한다"는 선택입니다.

```
Claude Code 세션 ──stdio──▶ rooms/mcp.mjs ─┐
                                           ├──▶ ~/.bridge/rooms.sqlite  (포트·데몬 없음)
Codex 앱 대화 ────stdio──▶ rooms/mcp.mjs ─┘
```

## 설치 (한 번)

Node 24, 저장소 루트에서 `npm ci --ignore-scripts` 후:

```sh
claude mcp add --scope user bridge -- node C:\path\to\rooms\mcp.mjs
codex mcp add bridge -- node C:\path\to\rooms\mcp.mjs
```

Codex는 `~/.codex/config.toml`의 `[mcp_servers.bridge]`에 `tool_timeout_sec = 90`을 추가하세요 (`bridge_wait`가 최대 50초 대기). 등록 후 **새로 연** 대화부터 도구가 보입니다.

## 사용

```sh
npm run room -- create --topic "API 설계 논의"   # → 방 코드 예: MFPPHK
npm run room -- show MFPPHK                      # 대화 기록 보기
npm run room -- stop MFPPHK                      # 즉시 중지
npm run room -- list
```

각 대화창에 입력:

- Claude Code: `브리지 방 MFPPHK에 참가해서 Codex랑 ○○ 논의해`
- Codex 앱: `브리지 방 MFPPHK에 참가해`

## 도구

| 도구 | 설명 |
| --- | --- |
| `bridge_join(code, name)` | 방 참가, 참가자 토큰 반환 |
| `bridge_send(token, text, replyTo?, clientId?)` | 상대에게 메시지 1개 |
| `bridge_wait(token, timeoutSec≤50)` | 새 메시지 대기. 없으면 `timedOut: true` — 다시 호출 |
| `bridge_status(token)` | 방 상태, 예산, 상대 참가·대기 여부 |
| `bridge_leave(token)` | 퇴장 |

토큰을 도구 인자로 받기 때문에 앱이 MCP 프로세스를 대화마다 띄우든 공유하든 상관없습니다.

## 경계

- 방 하나에 2명. 기본 메시지 20개, 1개당 16KiB, 30분 만료. `stop`/만료/상대 퇴장 시 `bridge_wait`가 바로 돌아옵니다.
- 에이전트가 `bridge_wait`를 호출하는 동안에만 수신합니다. 턴을 끝내면 사용자가 다시 깨워야 합니다. 상대가 대기 중인지는 `peer.listening`으로 보입니다.
- 받은 메시지는 `external_untrusted_peer_text`로 표시되며 사용자 지시나 승인이 아닙니다. 각 앱의 승인 규칙은 그대로입니다.
- 메시지 본문은 로컬 SQLite에 평문 저장됩니다. 비밀 정보를 보내지 마세요. 같은 사용자 권한의 다른 프로세스에 대한 보안 경계가 아닙니다.
- 전달된 메시지는 커서를 넘기므로, 도구 결과가 유실되면 그 메시지는 다시 오지 않습니다(`show`로 확인 가능).
