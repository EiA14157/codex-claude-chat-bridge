import { packetText } from './service.mjs';
const labels = { prepared: '준비됨', reserved: '전달 준비 중', write_started: '시도 시작됨', unconfirmed: '전달 시도 · 수신 미확인', reading: '응답 확인 중', received: '로컬 수신됨', cancelled: '취소됨', denied: '거부됨', expired: '만료됨', unknown: '결과 불확실 · 재시도 차단' };
const errors = { NOT_BOUND: '먼저 대상을 선택하세요.', PENDING_REQUEST: '이전 요청을 취소하거나 종료하세요.',
  INVALID_TEXT: '내용은 UTF-8 4KiB 이하여야 하며, 빈 내용이나 지나치게 큰 전달 패킷은 사용할 수 없습니다.',
  DRAFT_PRESENT: '대상 입력창에 작성 중인 내용이 있어 거부했습니다.', TARGET_CHANGED: '문서·대화가 달라졌습니다. 다시 직접 선택하세요.',
  DOM_CONTRACT_INVALID: '선택자가 단일·보이는 요소와 맞지 않습니다. 계약을 확인하세요.', TEXT_CHANGED: '준비 이후 내용이 바뀌었습니다. 이 요청은 재사용할 수 없습니다.',
  MOCK_TRIAL_USED: '1회 모의 왕복 시험은 이미 사용했습니다.', UNSUPPORTED_URL: 'HTTPS의 쿼리·해시 없는 대화 URL만 지원합니다.',
  EXPIRED: '요청이 만료됐습니다.', BUDGET_EXHAUSTED: '전체 요청 예산 12개를 사용했습니다.', ACCESS_DENIED: '탭 접근이 거부됐습니다. 이 요청을 재시도하지 마세요.' };
export function mountUI(doc, request) {
  const el = id => doc.getElementById(id); let current = null, pending = false;
  const show = (message, error = false) => { el('feedback').textContent = message; el('feedback').className = error ? 'error' : ''; };
  const refresh = async () => {
    const state = await request({ type: 'state' }); const previousId = current?.id; current = state.requests.at(-1) ?? null;
    if (previousId !== current?.id) { el('inbox').hidden = true; el('received').value = ''; }
    el('bound-state').textContent = state.stopped ? '중지됨' : state.binding?.kind === 'mock' ? '모의 대상' : '선택된 문서';
    el('target-label').textContent = state.binding ? `${state.binding.label} · ${state.binding.kind === 'mock' ? '실제 앱 접촉 없음' : state.binding.url}` : '선택된 대상 없음';
    el('prepare').disabled = state.stopped || !state.binding || pending;
    el('mock-test').disabled = state.mockUsed || pending;
    el('request-card').hidden = !current;
    if (current) {
      el('request-id').textContent = current.id; el('request-state').textContent = labels[current.state] ?? current.state;
      const seconds = Math.max(0, Math.ceil((current.expiresAt - Date.now()) / 1000)); el('expiry').textContent = `${seconds}초 남음`;
      el('preview').value = packetText(current, el('source').value);
      el('send').disabled = pending || state.stopped || current.state !== 'prepared' || seconds === 0 || !el('source').value.trim();
      el('receive').disabled = pending || state.stopped || current.state !== 'unconfirmed' || seconds === 0;
      const closed = ['received', 'cancelled', 'denied', 'expired', 'unknown'].includes(current.state);
      el('cancel').disabled = closed; el('deny').disabled = closed;
    }
    el('logs').replaceChildren(...state.logs.slice().reverse().map(log => {
      const li = doc.createElement('li'), strong = doc.createElement('strong'); strong.textContent = log.event;
      li.append(strong, doc.createTextNode(` · ${new Date(log.at).toLocaleTimeString()}${log.requestId ? ' · ' + log.requestId.slice(0, 8) : ''}${log.detail ? ' — ' + log.detail : ''}`)); return li;
    }));
    return state;
  };
  const run = async (message, success, busy = true) => {
    if (busy && pending) return;
    if (busy) pending = true;
    show('처리 중…');
    try {
      await refresh();
      const result = await request(message);
      await refresh();
      if (result?.matched) { el('inbox').hidden = false; el('received').value = result.text; }
      show(result?.matched === false ? '아직 이 요청의 응답 문자열과 일치하지 않습니다. 자동 재조회는 하지 않습니다.' : success);
    } catch (error) { show(`${errors[error.code] ?? '작업이 종료됐습니다.'} [${error.code ?? 'UNKNOWN_ERROR'}]`, true); }
    finally { if (busy) pending = false; try { await refresh(); } catch (error) { show(error.code ?? '상태 조회 실패', true); } }
  };
  el('bind-mock').addEventListener('click', () => run({ type: 'bindMock' }, '모의 대상을 선택했습니다. 실제 계정에 접근하지 않습니다.'));
  el('bind-current').addEventListener('click', () => run({ type: 'bindCurrent', contract: {
    input: el('selector-input').value, send: el('selector-send').value, response: el('selector-response').value,
    context: el('selector-context').value, contextText: el('context-text').value
  } }, '선택한 현재 문서에만 바인딩했습니다. 실제 사이트 지원은 미검증입니다.'));
  el('prepare').addEventListener('click', () => run({ type: 'prepare', text: el('source').value }, '내용과 대상을 확인한 뒤 전달 버튼을 직접 누르세요.'));
  el('send').addEventListener('click', () => run({ type: 'send', requestId: current?.id, text: el('source').value }, '한 번의 전달을 시도했습니다. 수신 여부는 응답을 직접 읽어 확인하세요.'));
  el('receive').addEventListener('click', () => run({ type: 'receive', requestId: current?.id }, '일치하는 확인 문자열을 로컬 수신함에서 확인했습니다. Codex 앱에는 보내지 않았습니다.'));
  el('cancel').addEventListener('click', () => run({ type: 'cancel', requestId: current?.id }, '요청을 취소했습니다. 이미 시작된 시도는 되돌릴 수 없습니다.', false));
  el('deny').addEventListener('click', () => run({ type: 'deny', requestId: current?.id }, '요청을 거부했습니다. 같은 요청은 다시 보내지 않습니다.', false));
  el('stop').addEventListener('click', () => run({ type: 'stop' }, '중지했습니다. 대상을 다시 직접 선택해야 새 요청을 준비할 수 있습니다.', false));
  el('mock-test').addEventListener('click', () => run({ type: 'mockTrial' }, '1회 모의 왕복이 완료됐습니다. 실제 Grok·Codex 연결 결과가 아닙니다.'));
  el('refresh').addEventListener('click', () => refresh().catch(error => show(error.code ?? '상태 조회 실패', true)));
  el('source').addEventListener('input', () => { if (current) {
    el('preview').value = packetText(current, el('source').value);
    el('send').disabled = pending || current.state !== 'prepared' || Date.now() >= current.expiresAt || !el('source').value.trim();
  } });
  refresh().catch(error => show(error.code ?? '초기화 실패', true));
  return { refresh };
}
