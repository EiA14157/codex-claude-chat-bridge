import http from 'node:http';
import fs from 'node:fs';
import { resolve, relative, isAbsolute, extname, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const mime = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
export const server = http.createServer((req, res) => {
  if (req.method !== 'GET' || !['127.0.0.1:43127', 'localhost:43127'].includes(req.headers.host)) { res.writeHead(403); res.end(); return; }
  const url = new URL(req.url, 'http://127.0.0.1:43127');
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  if (url.pathname === '/' || url.pathname === '/demo/') {
    let page = fs.readFileSync(join(root, 'extension/popup.html'), 'utf8');
    page = page.replace('href="popup.css"', 'href="/extension/popup.css"');
    page = page.replace('</head>', `<style>body{width:auto;background:#edf3ef}.demo-note{max-width:1000px;margin:28px auto 0;padding:16px 24px;background:#165849;color:white;border-radius:14px;font-size:14px}.demo-layout{max-width:1000px;margin:auto;display:grid;grid-template-columns:440px 1fr;gap:22px;align-items:start}.fixture-shell{margin-top:20px;background:white;border:1px solid #ccdcd1;border-radius:14px;padding:20px}.fixture-shell h2{font-size:18px}.fixture-shell p{font-size:12px;line-height:1.7;color:#6b7e71}iframe{width:100%;height:380px;border:1px solid #d6e4d9;border-radius:10px}@media(max-width:800px){.demo-layout{grid-template-columns:1fr;max-width:480px}.fixture-shell{margin:0 20px 20px}.demo-note{margin:15px 20px}main{width:100%}}</style></head>`);
    page = page.replace('<body>', '<body><div class="demo-note"><strong>로컬 Fixture 미리보기</strong> · 모의 Chrome API · 확장 설치·실제 계정 전송 없음</div><div class="demo-layout">');
    page = page.replace('<script type="module" src="popup.mjs"></script>', '<aside class="fixture-shell"><h2>선택 가능한 테스트 대화</h2><p>오른쪽은 이 서버가 제공하는 가짜 Grok 페이지입니다. 왼쪽 DOM 계약을 아래 값으로 지정한 뒤 전달·수신을 직접 시험할 수 있습니다.<br><code>#composer · #send · #response · #chat-title</code>정확한 제목: <b>Fixture Grok</b></p><iframe id="fixture" title="로컬 가짜 Grok 대화" src="/demo/fixture.html"></iframe><p>실제 Grok 사이트의 선택자·동작은 검증되지 않았습니다. Codex 앱 연결도 포함하지 않습니다.</p></aside></div><script type="module" src="/demo/demo.mjs"></script>');
    res.writeHead(200, { 'Content-Type': mime['.html'] }); res.end(page); return;
  }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400); res.end('Invalid path'); return; }
  const path = resolve(root, '.' + pathname), rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel) || !/^(extension|demo)[\\/]/.test(rel) || !mime[extname(path)] || !fs.existsSync(path) || !fs.lstatSync(path).isFile()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.writeHead(200, { 'Content-Type': mime[extname(path)] }); fs.createReadStream(path).pipe(res);
});
server.listen(43127, '127.0.0.1', () => console.log('Owned fixture demo: http://127.0.0.1:43127/demo/ — no extension install, app access or model API.'));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
