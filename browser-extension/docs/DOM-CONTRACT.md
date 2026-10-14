# 사용자가 선택하는 DOM 계약

이 후보는 Grok 사이트 어댑터가 검증됐다고 선언하지 않습니다. 사용자가 명시적으로 선택한 현재 탭의 main document에 아래 계약이 맞을 때만 가짜/승인된 시험을 수행할 수 있는 별도 DOM 어댑터입니다. 이번 구현 과정에서는 localhost fixture와 in-process 모의 DOM만 사용했습니다.

입력 계약은 `{input, send, response, context, contextText}`입니다. 네 선택자는 각각 정확히 한 요소와 일치해야 합니다. `input`은 보이는, 활성화된 `textarea` 또는 `input[type=text|search]`이며 현재 값이 완전히 비어 있어야 합니다. `send`는 보이는 활성 `button`입니다. `response`는 사용자가 확인한 단일 응답 요소입니다. `context`는 정확한 대화 제목 `contextText`를 가진 요소입니다. `html`, `body`, `*`, `:root`를 직접 지정하는 광범위한 계약은 거부합니다.

선택 코드는 Chrome이 반환한 `documentId`, 사용자 선택 시의 tab ID, 계약과 안전한 URL을 저장합니다. HTTPS 또는 localhost HTTP만 허용하며 query/hash/URL 사용자명/비밀번호는 거부합니다. iframe·closed shadow DOM·contenteditable은 지원하지 않습니다. `inspect`는 입력창이 비었는지와 계약을 확인하지만 입력값을 반환하거나 변경하지 않습니다. 전체 DOM·대화 전문·네트워크·쿠키·브라우저 저장소를 읽지 않습니다.

전송 계약은 `{requestId, bindingId, expiresAt, payload}`입니다. 페이지의 isolated world에서 같은 바인딩을 확인한 뒤 worker의 `dom:permit`을 요청합니다. worker는 호출한 extension ID, tab ID, main frame, document ID, URL, 요청 ID와 단일 미사용 guard를 검사합니다. `dom:permit`의 응답은 `{ok:true, requestId}`이며 popup 응답의 `{ok:true,value}` 구조와 다릅니다. 거부·만료·취소 상태에서는 허용하지 않습니다. 허용 결과 뒤에 DOM 코드는 시간·revocation·제목·URL·초안을 다시 검사하고 단 한 번 입력·클릭합니다.

페이지 입력 이벤트가 요소를 교체하거나 새 초안을 만들면 임의 복구·지우기·추가 클릭을 하지 않습니다. 전송 버튼은 입력 전에도 활성화되어 있어야 하므로, 입력 전 disabled 상태인 일반적인 앱은 이 제한된 계약과 맞지 않습니다. 확장 스크립트와 worker 간 IPC를 이미 통과한 시도는 분산된 두 실행 컨텍스트이므로 취소와 완전히 원자적으로 만들 수 없습니다. 소스는 양쪽의 최종 검사를 갖추지만, 이미 발급된 허용·시작된 효과는 되돌릴 수 없다고 표시하고 재시도를 금지합니다.

수신 계약은 같은 요청의 `expectedResponse = BRIDGE_ACK:<request-id>:<nonce>`와 정확히 일치하는 단일 응답 요소입니다. 다른 내용은 `{text:null}`로만 반환합니다. 자동 polling·MutationObserver·수신 후 자동 전송은 없습니다. popup의 수동 읽기 버튼만 사용합니다. 정확한 문자열을 아는 페이지는 이를 자체 생성할 수 있으므로 이 검사는 vendor 인증·모델 실행·Codex 앱 수신을 증명하지 않습니다.

Chrome 공식 문서: [현재 탭 일시 접근](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [문서 지정 scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting), [로컬 저장소·접근 수준](https://developer.chrome.com/docs/extensions/reference/api/storage).
