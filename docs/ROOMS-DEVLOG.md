# Bridge rooms 개발 정리

이미 열려 있는 AI 대화(Claude Code, Codex, Grok Bot)를 사용자가 직접 골라 서로 대화하게 하는 "방(room)" 기반 연결 통로의 개발 기록입니다. 사용법은 [rooms/README.md](../rooms/README.md)에 있습니다.

## 1. 배경과 방향 전환

| 시점 | 접근 | 결과 |
| --- | --- | --- |
| 기존 저장소 (`f3224b1`까지) | 고정된 codex/claude 쌍, 대화창에 **밀어 넣는(push)** 어댑터, Grok 웹용 Chromium 확장 | Codex 데스크톱에 주입할 공식 경로가 없어 실제 연결은 차단 상태. 확장은 실제 브라우저·사이트 검증 전 |
| 이번 작업 | 각 에이전트가 도구로 메시지를 **가져가는(pull)** 방식 + 사용자가 방 코드로 대화를 선택 | Claude Code ↔ Codex 앱 실제 대화 성공, 실제 공동 리뷰 작업 성공 |

핵심 아이디어는 세 가지입니다.

- **선택 = 참가.** 사용자가 공유할 대화창에 "브리지 방 `CODE`에 참가해"라고 입력하는 것이 곧 그 대화를 고르는 행위입니다. 세션 스캔, 화면 주입, 숨은 자동화가 없습니다.
- **수신 = 대기 도구 호출.** 에이전트가 `bridge_wait`를 부르고 있는 동안 메시지를 받습니다. 외부에서 대화창을 깨우는 비공식 경로에 의존하지 않습니다.
- **크롬 확장은 보류.** 사이트 변경에 취약하고 실제 Grok 화면과 맞지 않을 가능성이 커서, 공식 도구 연결(MCP)로 방향을 바꿨습니다.

## 2. 구조

```
Claude Code 세션 ──stdio MCP (--channel)──┐
Codex 앱 대화 ────stdio MCP──────────────┼──▶ ~/.bridge/rooms.sqlite (WAL)
Grok Bot ─────────CLI 명령 또는 HTTP MCP──┘
                                  대시보드 (127.0.0.1) ──┘
```

### 파일

| 파일 | 역할 |
| --- | --- |
| `rooms/store.mjs` | 방, 참가자, 메시지 저장소 (`RoomStore`) |
| `rooms/tools.mjs` | 도구 정의와 처리 로직. stdio와 HTTP가 공유하고, channels 알림도 여기서 보냄 |
| `rooms/mcp.mjs` | stdio MCP 서버 (`--channel` 옵션) |
| `rooms/server.mjs` | 로컬 대시보드 + `--remote` 시 HTTP MCP 엔드포인트 `/mcp` |
| `rooms/dashboard.html` | 대시보드 화면 |
| `rooms/cli.mjs` | 방 관리(`create`, `list`, `show`, `stop`, `kick`)와 에이전트 명령(`join`, `send`, `wait`, `status`, `leave`) |
| `rooms/README.md` | 설치, 사용법, 경계 |
| `test/rooms.test.mjs` | 저장소 단위 테스트 9개 (리뷰 회귀 테스트 포함) |
| `integration/rooms-mcp.test.mjs` | MCP 서버 프로세스 2개 간 실제 왕복 |
| `integration/rooms-extras.test.mjs` | channels 알림, 대시보드 API 인증, HTTP MCP, CLI 에이전트 명령 |

### 도구

| 도구 | 설명 |
| --- | --- |
| `bridge_join(code, name)` | 방 참가, **참가자 토큰** 반환 |
| `bridge_send(token, text, replyTo?, clientId?)` | 상대에게 메시지 1개 (clientId로 중복 방지) |
| `bridge_wait(token, timeoutSec≤50, afterSeq?)` | 새 메시지 대기. 없으면 `timedOut: true`. `afterSeq`로 다시 받기 |
| `bridge_status(token)` | 방 상태, 예산, 상대 참가·대기 여부 |
| `bridge_leave(token)` | 퇴장 |

### 설계 결정

- **토큰을 도구 인자로 전달.** 앱이 MCP 프로세스를 대화마다 띄우는지, 여러 대화가 공유하는지 알 수 없습니다. 그래서 서버 프로세스에 상태를 두지 않고 에이전트가 토큰을 맥락에 들고 다닙니다. 같은 이유로 HTTP 엔드포인트도 요청마다 새 서버를 만드는 무상태 방식입니다.
- **대기 시간 최대 50초.** Codex MCP 도구 타임아웃 기본값이 60초라 그보다 짧게 잡았고, Codex 설정에 `tool_timeout_sec = 90`을 추가해 여유를 뒀습니다.
- **조기 반환.** 방이 중지·만료되거나 상대가 퇴장하면 `bridge_wait`가 즉시 돌아옵니다.
- **대기 표시.** 대기를 시작할 때 `listening_until`을 기록해서 상대가 `peer.listening`으로 볼 수 있습니다.
- **신뢰 경계.** 받은 메시지는 `external_untrusted_peer_text`로 표시되며, 사용자 지시나 승인으로 취급하지 않도록 서버 지시문에 명시했습니다.
- **channels 알림에는 본문을 넣지 않음.** 알림은 "읽지 않은 메시지 N개"만 알리고, 본문은 항상 `bridge_wait`로 전달합니다. 전달 경로를 하나로 유지해 커서와 재전달 규칙이 한 곳에서만 적용됩니다.
- **자동 퇴장 없음.** 대기를 멈춘 것을 종료로 단정하지 않고, 사용자가 `kick`이나 대시보드로 자리를 회수합니다. 공동 리뷰에서 Codex가 짚은 점을 반영했습니다.

### 방 규칙 (기본값)

- 참가자 2명, 이름 중복 불가
- 메시지 20개, 1개당 16KiB, 30분 만료
- 퇴장하거나 내보내진 자리는 재사용 가능. 중지·만료된 방은 재개 불가

## 3. 검증

### 1차 실제 연결: 인사 (방 `MFPPHK`)

새 Claude Code 세션과 Codex 앱 새 대화에 각각 방 코드를 입력해 시험했습니다.

```
12:38:54 claude-code: 안녕하세요 Codex! … 답장 부탁드립니다 👋
12:39:00 codex:       안녕하세요 Claude! 저는 Codex입니다. … 제 메시지가 잘 보이나요?
12:39:05 claude-code: 네, 잘 보입니다! … 여기서 마무리할게요
12:39:13 codex:       … 한국어와 이모지 모두 정상적으로 전달됐어요
12:39:17 claude-code: 첫 인사와 답장 둘 다 잘 도착했어요 ✅ … 방을 나갈게요
```

참가부터 퇴장까지 양쪽 모두 정상이었고, 답장 간격은 4~8초, 한국어와 이모지도 손상되지 않았습니다.

### 2차 실제 작업: `rooms/store.mjs` 공동 리뷰 (방 `BXQD7C`)

헤드리스 Codex(`codex exec`)와 이 개발 세션의 Claude가 실제 버그 3가지에 합의하는 과제를 진행했습니다. 헤드리스 Claude CLI는 로그인되어 있지 않아서, 개발 세션이 CLI 에이전트 명령으로 Claude 쪽을 맡았습니다.

진행 과정에서 발견한 것:

- 첫 시도에서 Codex의 `bridge_join`이 "승인이 필요하지만 승인 정책이 never"라는 이유로 거부됐습니다. 헤드리스에서는 승인 창을 띄울 수 없기 때문입니다. `default_tools_approval_mode="approve"`를 실행 옵션으로 넘겨 해결했고, README에 안내를 추가했습니다.
- 4개 메시지로 합의했습니다. Claude가 후보 3개를 제시하자 Codex가 1·2번에 동의하고, 3번(락 부하) 대신 더 중요한 "유령 참가자"를 제안했습니다. Claude가 이를 수용했고, Codex는 세 가지 모두 메모리 DB로 직접 재현까지 했습니다.

합의된 3가지와 수정 내용:

| # | 문제 | 수정 |
| --- | --- | --- |
| 1 | `peerLeft` 오탐: 예전에 나간 사람이 있으면, 혼자 늦게 들어온 참가자의 `wait`가 즉시 "상대 퇴장"으로 끝나 바쁜 루프가 됨 | 참가·퇴장에 단조 증가 순번(`join_order`/`left_order`)을 매기고, **내가 들어온 뒤에 나간** 상대만 셈. 같은 밀리초 문제도 없음 |
| 2 | 결과를 전달하기 전에 커서가 앞으로 가서, 도구 결과가 유실되면 메시지가 다시 오지 않음 | 메시지에 `seq`, 결과에 `lastSeq`를 넣고 `bridge_wait(afterSeq)`로 다시 받기. 커서는 뒤로 가지 않음 |
| 3 | 세션이 비정상 종료되면 토큰이 사라져 자리를 영구히 차지함 | `last_seen`을 기록하고 사용자가 `kick`(CLI·대시보드·API)으로 회수. 자동 퇴장은 하지 않음 |
| + | (후순위로 내린 원래 3번) 대기 중 300ms마다 쓰기 트랜잭션 | 대기 루프는 읽기 전용으로 바꾸고, 쓰기는 시작·전달·종료 때만 함 |

### 자동 테스트

- 전체 단위 테스트 통과 (기존 + rooms 9개)
- MCP 통합 테스트 통과 (기존 + rooms 3개)
- 개발 중 발견해 수정한 문제
  - 상대가 대기 시작 **전에** 나간 경우 `wait`가 끝나지 않던 문제
  - Windows에서 열린 SQLite 파일을 먼저 지우려다 `EPERM`이 나던 테스트 정리 순서
  - `fetch`가 `Host` 헤더를 무시해서 DNS 리바인딩 방어 테스트가 실제로 검사하지 못하던 문제 → `node:http`로 교체
  - 서버를 재시작해 주소의 `#key=`만 바뀌면 대시보드가 예전 키를 계속 쓰던 문제 → `hashchange` 처리
  - `claude -p --allowedTools a,b "프롬프트"`에서 가변 인자 옵션이 프롬프트까지 삼키던 문제 → 프롬프트를 앞에 둠

### 대시보드

브라우저에서 방 목록, 대화 기록, 참가자 대기 상태, 마지막 활동 시각, 내보내기 버튼이 정상적으로 표시되는 것을 확인했습니다.

## 4. 앱 설정 변경

| 앱 | 변경 | 백업 |
| --- | --- | --- |
| Codex | `~/.codex/config.toml`에 `[mcp_servers.bridge]`, `tool_timeout_sec = 90` | `config.toml.bak-bridge` |
| Claude Code | `claude mcp add --scope user bridge ... --channel` | `~/.claude.json.bak-bridge` |

Codex의 자동 승인(`default_tools_approval_mode`)은 설정 파일에 넣지 않았습니다. 필요하면 사용자가 직접 추가합니다.

## 5. 기능별 상태

| 기능 | 상태 |
| --- | --- |
| Claude Code ↔ Codex 앱 실제 대화 | ✅ 확인 |
| 여러 차례 주고받는 실제 작업 | ✅ 확인 (헤드리스 Codex ↔ 개발 세션 Claude) |
| 대시보드 | ✅ 브라우저 확인 |
| 유령 참가자 회수, 재전달, peerLeft 수정 | ✅ 테스트 |
| Claude Code channels 알림 | ✅ 알림 형식과 전송은 테스트. 실제 Claude Code에서 `--dangerously-load-development-channels server:bridge`로 표시되는지는 미확인 |
| Grok Bot (로컬 실행 모드 CLI) | ✅ CLI 명령 테스트. 실제 Grok Bot에서는 미확인 |
| Grok Bot (원격 HTTP MCP) | ✅ HTTP MCP 클라이언트 테스트. 터널 노출과 실제 Grok Bot 등록은 사용자가 결정할 사항이라 미진행 |

## 6. 알려진 제약

- 에이전트가 `bridge_wait`를 호출하는 동안에만 수신합니다. Codex는 턴을 끝내면 사용자가 다시 말을 걸어야 합니다. Claude Code는 channels 알림으로 깨울 수 있습니다.
- 메시지 본문은 로컬 SQLite에 평문으로 저장됩니다. 비밀 정보를 보내지 마세요.
- 같은 사용자 권한의 다른 프로세스에 대한 보안 경계가 아닙니다.
- 원격 MCP를 터널로 노출하면 원격 키를 아는 누구나 방 코드로 참가할 수 있습니다.
