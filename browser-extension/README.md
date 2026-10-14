# 선택한 탭 브리지 · Chromium MV3 후보

사용자가 탭과 대화 요소를 직접 지정하고, 보이는 버튼으로 한 요청을 전달·읽기·취소·거부·중지하는 확장 MVP입니다. **실제 Grok 사이트 지원은 미검증이며, Codex 데스크톱 앱에 연결되지 않았습니다.** 자동 대화, 숨은 전송, 수신 응답의 자동 재전송은 없습니다. 기존 Claude 릴레이를 수정하거나 다시 켜지 않았습니다.

## 포함된 기능

- `extension/`: Chrome/Edge 106+ 대상 Manifest V3 소스, popup UI, service worker, 선택형 DOM 어댑터.
- `demo/`: 실제 계정이 없는 가짜 Grok 대화와 Chrome API 모의 구현. 확장을 설치하지 않고 동일 UI·명령 처리·DOM 함수를 시험하는 로컬 페이지.
- `test/`: 요청 수명 주기, 실제 worker 진입 코드의 모의 Chrome API, 메시지 송신자 검사, DOM fixture, UI 이벤트 fixture, 권한 검사를 포함한 52개 테스트.
- `scripts/`: 의존성 설치 없이 문법·테스트 검사와 localhost fixture 서버. 모델 API를 호출하지 않습니다.

## 권한

Manifest의 권한은 `activeTab`, `scripting`, `storage` 3개입니다. `host_permissions`, `optional_host_permissions`, 상시 content script, `tabs`, cookies, webRequest, clipboard, nativeMessaging 권한은 없습니다.

`activeTab`은 사용자가 확장 아이콘을 누른 탭에 일시 접근하는 방식입니다. 후보는 현재 탭을 명시적으로 선택할 때만 main frame에 검사 코드를 넣고, 반환된 `documentId`·정확한 깨끗한 URL·대화 제목·선택자를 고정합니다. 같은 origin으로 이동했더라도 문서 ID가 달라지면 새 대상으로 다시 선택해야 합니다. 전체 사이트 상시 권한 대신 이 일시 권한을 사용하며, 선택적 영구 사이트 권한은 필요 대상이 확정될 때 별도로 검토해야 합니다. [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting).

`storage.local`에는 요청 ID, nonce, 원문의 SHA-256, 대상 계약, 상태·기한과 최대 120개의 상태 로그를 저장합니다. 원문·응답 전문·쿠키·토큰·키를 수집하거나 저장하지 않습니다. 콘텐츠 스크립트의 저장소 접근은 `TRUSTED_CONTEXTS`로 제한합니다. 소스 텍스트는 popup 입력과 요청 메시지에서만 다루며, 키·비밀번호·개인정보를 입력해서는 안 됩니다. 대상 URL의 query/hash/사용자명/비밀번호는 거부합니다. URL 경로와 사용자가 지정한 제목은 로컬에 남습니다. 이 저장소는 동일 계정의 악의적인 프로세스에 대한 인증 경계가 아닙니다.

## 소스 검증 · 설치 없는 미리보기

Node 24에서:

```powershell
cd .\browser-extension
npm run check
npm run demo
```

서버가 시작되면 `http://127.0.0.1:43127/demo/`을 열 수 있습니다. localhost에만 바인딩하며 실제 서비스 URL·인증·계정에 접근하지 않습니다. `Ctrl+C`로 종료합니다. 데모 상태는 메모리뿐이라 페이지를 다시 열면 새 fixture 상태가 되며, 실제 확장의 재시작 내구성은 별도 저장소 fixture 테스트에서 검사합니다.

왼쪽에서 **1회 모의 왕복 시험**을 누르면 가짜 어댑터 안에서 한 요청·한 응답이 표시됩니다. 이는 Grok이나 Codex 앱 수신 증거가 아닙니다. DOM fixture를 검사할 때는 오른쪽 가짜 대화에 대해 아래 계약을 지정하세요:

| 항목 | Fixture 값 |
| --- | --- |
| 입력창 | `#composer` |
| 전송 버튼 | `#send` |
| 단일 응답 요소 | `#response` |
| 대화 제목 요소 | `#chat-title` |
| 정확한 제목 | `Fixture Grok` |

선택 → 무해한 내용 입력 → 새 요청 준비 → 미리보기 확인 → 1회 전달 → 응답 직접 읽기 순서입니다. 대상 입력창에 미작성 초안이 있으면 바인딩·전달이 거부되고 원문은 유지됩니다. 응답이 아직 일치하지 않으면 수동 읽기는 다시 할 수 있지만, 전달 시도는 다시 할 수 없습니다.

## 향후 수동 설치 안내 — 이번 작업에서는 실행하지 않음

후보의 독립 검토가 끝나고 사용자가 설치·권한 부여를 명시적으로 승인한 뒤에만 진행하세요. 먼저 실제 계정이 없는 별도 테스트 프로필에서 localhost fixture를 사용하는 것이 설치 검증 범위입니다.

1. Chrome의 `chrome://extensions` 또는 Edge의 `edge://extensions`에서 사용자 직접 개발자 모드를 켭니다.
2. **압축해제된 확장 프로그램 로드**로 이 프로젝트의 `extension/` 폴더를 선택합니다. 프로젝트 루트·demo 폴더를 선택하지 않습니다.
3. 가짜 대화 페이지 `http://127.0.0.1:43127/demo/fixture.html` 탭을 직접 연 뒤 확장 아이콘을 누릅니다.
4. DOM 계약을 직접 채우고 **이 현재 탭·문서를 선택**을 누릅니다. 위 표의 제목과 요소가 정확히 맞는지 확인합니다.
5. 명시적 준비·전달·읽기·취소·중지를 한 번씩 검사합니다. 실제 계정 전송은 이 설치 안내에 포함하지 않습니다.
6. **전체 중지** 후 테스트 확장을 사용자 직접 제거할 수 있습니다. 제거·브라우저 데이터 삭제는 로컬 내구성 기록도 없애므로 불확실한 이전 시도를 재전송하는 수단으로 쓰지 않습니다.

## 수명 주기와 경계

기본 만료는 2분, 전체 저장소 예산은 12개 요청, 원문 한 건은 UTF-8 4KiB, 직렬화된 패킷은 16KiB 이하입니다. 새 바인딩·새 root 요청은 예산을 초기화하지 않습니다. 요청 상태는 `prepared → reserved → write_started → unconfirmed → received`이며, 취소·거부·만료·불확실 상태가 최종입니다. 같은 ID를 복원하거나 재시도하는 명령은 없습니다.

호스트 준비를 시작하기 전에 `reserved`를 저장합니다. 전송 직전 worker가 요청·문서·발신자를 검사하고 쓰기 허용을 단 한 번 저장합니다. DOM 코드가 그 비동기 응답 뒤에 기한·취소·대상·사용자 초안을 다시 검사합니다. 입력 이벤트 중 요소가 교체되거나 페이지가 바뀌면 전송 버튼을 누르지 않습니다. 이미 전달된 쓰기 허용·입력 변경·버튼 클릭은 중지로 되돌릴 수 없으며, 그러한 실패는 불확실 상태로 남겨 재시도를 막습니다. worker 재시작은 진행 중 상태를 불확실로 복구하고 항상 disarm합니다.

응답 요소에서는 정확히 `BRIDGE_ACK:<request-id>:<nonce>`인 문자열만 반환합니다. 다른 대화 내용은 내보내지 않습니다. 이는 사용자가 선택한 DOM의 문자열 일치 증거일 뿐 실제 Grok 모델의 인증된 수신 증거가 아닙니다. 수신 메시지는 로컬 수신함에만 남고 다른 탭·Codex·Claude로 자동 전달되지 않습니다. 원문은 저장하지 않으므로 popup을 닫으면 입력 내용이 사라집니다. 이전 준비 요청은 취소하고 새로 명시적으로 준비하는 흐름을 사용하세요.

## Grok·Codex 연결 범위

Grok의 제품·봇·대화 URL이 아직 미확정이라 vendor selector나 비공개 API를 추측하지 않았습니다. DOM 어댑터 계약은 [DOM-CONTRACT.md](docs/DOM-CONTRACT.md)에 있습니다. iframe 안의 실제 서비스, closed shadow DOM, contenteditable 에디터, query/hash 기반 라우트, 빈 입력 시 전송 버튼이 비활성화되는 앱은 이 버전에서 지원하지 않습니다. 지원 범위 밖에서는 페이지를 고치거나 숨은 우회 수단을 쓰지 않습니다.

**Codex 데스크톱 입력은 확장만으로 구현되지 않습니다.** `nativeMessaging` 허용이나 daemon을 추가하지 않았고, 기존 앱 도구를 브라우저에서 독립 호출할 바인딩도 없습니다. 향후 공식 native/SDK 경로의 대상 확인·일회 승인·수신 검증을 별도로 구현하고 검토해야 합니다. popup의 입력은 사용자가 제공한 시험 텍스트이며 Codex 대화를 읽은 것이 아닙니다.

## 이번 자체 검증 결과

`npm run check`: 모든 모듈 문법 검사와 52개 fixture 테스트 통과, 실패·취소·skip 0. UI 이벤트 fixture는 실제 popup HTML의 요소 ID와 같은 controller를 사용합니다. 최초 UI fixture에서는 시계 기준 불일치 2개와 빠른 모의 왕복 후 수신함이 가려지는 UI 결점 1개를 발견했고 수정했습니다. 최초 실패 로그는 리뷰 증거에 보존합니다.

`scripts/http-fixture-check.mjs`: 자체 서버를 같은 프로세스에서 시작·종료하는 localhost 정적 자산·접근 제한 검사 12개 통과. 기본 샌드박스 연결은 `EACCES`, 별도 프로세스 연결은 `ETIMEDOUT`이었으며, 동일 프로세스의 제한된 테스트가 자동 승인 검토 후 통과했습니다. 외부 요청은 없고 서버는 종료됐습니다. 이는 화면 렌더링 검사가 아닙니다.

공식 브라우저 도구의 로컬 미리보기 실행은 `MXC launcher: cannot locate required Windows platform directory: HRESULT 0x80070003`로 시작하지 못했습니다. **실제 브라우저 렌더·레이아웃 검증, 실제 MV3 설치·권한 부여·Chrome/Edge lifecycle, 실제 사이트·계정 전달은 미실행**입니다. 자체 fixture 통과를 그 검증 대신 보고하지 않습니다. 별도 독립 검토 작업용 동결본과 권한 목록을 준비합니다. 공개 스토어 게시·원격 push·유료 호출은 하지 않았습니다.
