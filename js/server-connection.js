// ── server-connection.js ────────────────────────────────
// 서버 감지 / URL 결정 / Long-poll / .env 부트스트랩
// 메인 HTML 의 inline <script> 에서 분리된 모듈.
// 글로벌 스코프 공유 (script 태그 분리만 하고 모듈 시스템 미사용).
//
// 정의: window._devServerAvailable, window._serverOrigin, window._serverBase,
//       devUrl(), _getBasePath(), _tryPing()
// 부트스트랩: _tryPing().then(...) 즉시 실행 (서버 감지 + long-poll 시작 + .env 로드)
// 외부 의존: dbgLog, _runAutoRunPipeline, loadConfig, document.*
// ────────────────────────────────────────────────────────

// ── 서버 URL 결정 ──────────────────────────────────────────
// VS Code 포트 포워딩:  https://hpc-host/proxy/8080/  → basePath=/proxy/8080
// 직접 접속:            http://localhost:8080/          → basePath=''
// file:// 직접 열기:    localhost:8080 fallback
window._devServerAvailable = false;
window._serverOrigin  = '';   // https://hpc-host
window._serverBase    = '';   // /proxy/8080  (포트 포워딩 prefix)

function devUrl(path) {
  return window._serverOrigin + window._serverBase + path;
}

// pathname에서 basePath 추출
// /proxy/8080/  → /proxy/8080
// /             → ''
function _getBasePath() {
  const p = window.location.pathname;
  if (!p || p === '/') return '';
  // HTML 파일명 제거 (직접 열기 시): /foo/bar.html → /foo
  const stripped = p.endsWith('/') ? p.slice(0, -1) : p.replace(/\/[^/]*$/, '');
  return stripped;
}

// 서버 감지
async function _tryPing() {
  const origin = window.location.origin;

  if (!origin.startsWith('file://')) {
    const base = _getBasePath();
    const url  = `${origin}${base}/ping`;
    try {
      // AbortSignal.timeout 대신 수동 타임아웃 — Firefox NS_BINDING_ABORTED 방지
      const ctrl    = new AbortController();
      const timer   = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      const d = await r.json();
      if (d.ok) {
        window._serverOrigin = origin;
        window._serverBase   = base;
        return true;
      }
    } catch(e) {
      dbgLog('INF', `[ping] ${url} 실패: ${e.message}`, 'inf');
    }
  }

  // file:// 직접 열기 — localhost:8080 fallback
  try {
    const ctrl2  = new AbortController();
    const timer2 = setTimeout(() => ctrl2.abort(), 3000);
    const r = await fetch('http://localhost:8080/ping', { signal: ctrl2.signal });
    clearTimeout(timer2);
    const d = await r.json();
    if (d.ok) {
      window._serverOrigin = 'http://localhost:8080';
      window._serverBase   = '';
      return true;
    }
  } catch(_) {}

  return false;
}

// postMessage 리스너 (same-origin 검증)
window.addEventListener('message', (e) => {
  if (window._serverOrigin && e.origin !== window._serverOrigin &&
      e.origin !== window.location.origin) return;
  const { action } = e.data || {};
  if (action === 'auto-run-analysis') _runAutoRunPipeline({ doAnalysis: true,  doConvert: false });
  else if (action === 'auto-run-convert')  _runAutoRunPipeline({ doAnalysis: false, doConvert: true });
  else if (action === 'auto-run-all')      _runAutoRunPipeline({ doAnalysis: true,  doConvert: true });
});

_tryPing()
  .then(ok => {
    if (!ok) return;
    window._devServerAvailable = true;
    dbgLog('INF', `서버 감지됨 (${window._serverOrigin}${window._serverBase}) — 프록시 + 파일 로그 활성화`, 'res');
    document.getElementById('ps').textContent = '⚡ server';
    document.getElementById('ps').style.color = 'var(--green)';

    // API 명령 long-polling — 명령 도착 즉시 처리
    // wait=30: 서버에서 최대 30초까지 대기 → 명령 도착 시 즉시 응답
    //          빈 응답이면 곧장 재연결 → 사실상 영구 연결 효과
    //          fetch 실패 시 1초 후 재시도 (네트워크 일시 단절 대응)
    async function _runApiLongPoll() {
      while (window._devServerAvailable) {
        try {
          const r = await fetch(devUrl('/api/poll?wait=30'));
          const d = await r.json();
          if (d.command) {
            dbgLog('INF', `[api] 명령 수신: ${d.command.action}`, 'inf');
            if      (d.command.action === 'auto-run-analysis') _runAutoRunPipeline({ doAnalysis: true,  doConvert: false });
            else if (d.command.action === 'auto-run-convert')  _runAutoRunPipeline({ doAnalysis: false, doConvert: true  });
            else if (d.command.action === 'auto-run-all')      _runAutoRunPipeline({ doAnalysis: true,  doConvert: true  });
          }
        } catch(_) {
          // 연결 끊김/타임아웃 — 1초 후 재시도
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    }
    _runApiLongPoll();

    // .env 값 로드
    return fetch(devUrl('/env')).then(r => r.json()).then(env => {
      if (!env.loaded) {
        dbgLog('INF', '.env 파일 없음 — 기본값 사용 (서버 디렉터리에 .env 생성 권장)', 'inf');
        return;
      }
      // BaseURL 주입
      if (env.BASE_URL) {
        const hostEl = document.getElementById('oHost');
        if (hostEl) {
          hostEl.value = env.BASE_URL;
          hostEl.style.borderColor = 'var(--green)';
          hostEl.title = `.env 에서 로드됨: ${env.BASE_URL}`;
        }
      }
      // API Key 주입
      if (env.API_KEY) {
        const keyEl = document.getElementById('oApiKey');
        if (keyEl) {
          keyEl.value = env.API_KEY;
          keyEl.style.borderColor = 'var(--green)';
          keyEl.placeholder = '✓ .env에서 로드됨';
        }
      }
      // 기본 모델 주입
      if (env.DEFAULT_MODEL) {
        window._envDefaultModel = env.DEFAULT_MODEL;
        const modelEl = document.getElementById('oModel');
        if (modelEl) modelEl.value = env.DEFAULT_MODEL;
      }

      // Ollama 미사용 — OLLAMA_MODE 무시
      // config 기본값 반영 (dev 서버 있을 때)
      loadConfig().then(cfg => {
        const chk = document.getElementById('includeExcludedAsRef');
        if (chk && cfg?.targetRtl?.includeExcludedAsRef !== undefined) {
          chk.checked = cfg.targetRtl.includeExcludedAsRef;
        }
      });

      dbgLog('INF',
        `.env 로드 완료: BASE_URL=${env.BASE_URL || '(없음)'}` +
        ` MODEL=${env.DEFAULT_MODEL || '(없음)'}` +
        (env.API_KEY ? ' API_KEY=****' : ''),
        'res');
      document.getElementById('ps').textContent = '⚡ dev server + .env';
    });
  })
  .catch(() => {
    dbgLog('INF', 'Dev 서버 없음 — 직접 연결 모드 (로그는 "로그 저장" 버튼 사용)', 'inf');
  });
