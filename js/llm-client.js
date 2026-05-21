// ── llm-client.js ───────────────────────────────────────
// LLM 호출 / 대화 로그 저장 / 다운로드
// 메인 HTML 의 inline <script> 에서 분리된 모듈.
// 글로벌 스코프 공유 (script 태그 분리만 하고 모듈 시스템 미사용).
//
// 정의: llmLog, saveReqLog(), saveLlmLog(), downloadLlmLog(), callLLM()
// 외부 의존: dbgLog, devUrl, estimateTokens, getLang, _pset, document.*
//   ※ approxTokFromChars / fmtThinkingTok 는 HTML 글로벌에도 있지만,
//     이 파일 내부에서는 _approxTokFromChars / _fmtThinkingTok(로컬 alias)
//     을 사용한다 — HTML 로드 순서에 무관하게 동작하도록.
// ────────────────────────────────────────────────────────

// ── 로컬 헬퍼 (HTML 글로벌 함수의 로컬 alias) ────────────
// approxTokFromChars / fmtThinkingTok 은 HTML 메인 스크립트에도 동일하게
// 정의되어 있으나, llm-client.js 가 먼저 파싱될 때 아직 선언 전일 수 있다.
// 호출 시점(런타임)에는 항상 글로벌이 존재하므로 직접 위임하고,
// 만약 글로벌이 없으면 fallback 구현을 사용한다.
function _approxTokFromChars(n) {
  if (typeof approxTokFromChars === 'function') return approxTokFromChars(n);
  return Math.max(0, Math.round((Number(n) || 0) / 3.5));
}
function _fmtThinkingTok(n) {
  if (typeof fmtThinkingTok === 'function') return fmtThinkingTok(n);
  return `~${_approxTokFromChars(n).toLocaleString()}tok`;
}
// FNV-1a 32bit 해시 — loop 감지용 세그먼트 비교에 사용
function _simpleHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(36);
}
// KST(+09:00) ISO 8601 문자열 반환 — 로그 타임스탬프 전용
// 예: "2025-05-15T14:32:07.123+09:00"
function _nowKST(ms) {
  const d = new Date(ms !== undefined ? ms : Date.now());
  const kst = new Date(d.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().replace('Z', '+09:00');
}


// ── Thinking / Reasoning compatibility options ─────────────
// enableThinking 토글을 모든 callLLM() 호출 단계에 동일 적용하기 위한 옵션.
// 서버가 unknown field 를 거부하면 필요한 항목만 false 로 낮추면 된다.
const THINKING_COMPAT = {
  // GLM-4.7 local vLLM/SGLang 기준 기본값.
  // raw HTTP fetch에서는 OpenAI SDK의 extra_body를 그대로 보내면 안 된다.
  // extra_body는 SDK가 최종 JSON body에 병합해 주는 옵션이지, 대부분의
  // OpenAI-compatible HTTP 서버가 직접 받는 표준 필드가 아니다.
  chat_template_kwargs: true,   // vLLM / SGLang GLM-4.7: {enable_thinking, clear_thinking}
  extra_body: false,            // SDK 전용 wrapper 용도. 브라우저 raw HTTP 기본 비활성
  top_level: false,             // enable_thinking top-level은 strict 서버에서 거부될 수 있음

  // Z.AI official API raw HTTP를 직접 칠 때만 true로 전환.
  // 기본값은 local OpenAI-compatible 서버 호환성을 우선한다.
  glm_thinking: false,
  glm_preserve_when_on: false,  // 단발성 요청에서 clear_thinking=false가 스트림 에러 유발 → 항상 true로 고정

  // thinking_budget: chat_template_kwargs 에 thinking_budget 을 포함해 전송할지 여부.
  // GLM-4.7 vLLM/SGLang 에서 reasoning loop 발생 시 상한을 줘서 강제 종료시킨다.
  // 값은 UI의 thinking buf 설정값(getThinkingBuf())을 사용.
  // 0 또는 use=false 이면 전송하지 않음.
  send_thinking_budget: true,

  // GLM-4.7 vLLM/SGLang 문서에는 reasoning_budget=0가 필요하지 않다.
  // unknown field로 빈 응답/거부를 유발할 수 있어 기본 비활성화.
  reasoning_budget_zero: false,
  reasoning_debug: true,
};

function buildGlmThinkingPayload(thinkingOn) {
  const payload = {
    type: thinkingOn ? 'enabled' : 'disabled',
  };
  // GLM-4.7 preserved thinking 디버깅: thinking ON일 때는 reasoning 연속성 확인을 위해
  // clear_thinking=false 를 명시한다. OFF일 때는 이전 reasoning 누출을 막기 위해 true.
  payload.clear_thinking = thinkingOn ? !THINKING_COMPAT.glm_preserve_when_on : true;
  return payload;
}

function compactForLog(obj, max = 1200) {
  try {
    const s = JSON.stringify(obj);
    return s.length > max ? s.slice(0, max) + '…' : s;
  } catch (_) {
    return String(obj);
  }
}

function isThinkingEnabled() {
  if (typeof getThinkingEnabled === 'function') return !!getThinkingEnabled();
  return !!document.getElementById('enableThinking')?.checked;
}

function emitReasoningStream(detail) {
  // UI 표시를 각 callLLM 호출부의 onProgress handler에만 의존하지 않도록
  // 전역 이벤트로도 reasoning delta를 broadcast한다.
  // 이렇게 하면 Summary/Convert/Iteration 등 어떤 경로에서 callLLM이 호출되어도
  // rtl_algo_converter.html의 global listener가 preview panel을 갱신할 수 있다.
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('glm-reasoning-stream', { detail }));
    }
  } catch (_) {}
}

// ── LLM 대화 로그 저장 ────────────────────────────────────
const llmLog = [];
// LOG_SERVER: devUrl('/save-log') 를 직접 사용 (포트 동적 감지 보장)

// REQUEST 단계 즉시 기록 (응답 여부와 무관) — fire-and-forget
function saveReqLog(entry) {
  llmLog.push(entry);
  if (!window._devServerAvailable) return;  // dev 서버 없으면 메모리만
  // await 없이 즉시 반환 — pending 상태에서도 기록 보장
  fetch(devUrl('/save-log'), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(entry),
  }).then(res => {
    if (res.ok) res.json().then(d =>
      dbgLog('INF', `[req-log] #${d.count} 저장 → ${d.file}`, 'inf')
    );
  }).catch(e => {
    dbgLog('INF', `[req-log] 저장 실패 (${e.message}) — 메모리 누적 (${llmLog.length}건)`, 'inf');
  });
}

// RESPONSE 완료 후 기존 REQ 항목을 업데이트해서 저장
async function saveLlmLog(entry) {
  // 메모리 로그에서 같은 req_id 찾아 업데이트
  const existing = llmLog.find(e => e.req_id && e.req_id === entry.req_id);
  if (existing) {
    Object.assign(existing, entry);
  } else {
    llmLog.push(entry);
  }
  try {
    const res = await fetch(devUrl('/save-log'), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(entry),
    });
    if (res.ok) {
      const d = await res.json();
      dbgLog('INF', `[res-log] #${d.count} 저장 → ${d.file}`, 'inf');
    } else {
      dbgLog('INF', `[res-log] 서버 응답 오류 HTTP ${res.status}`, 'inf');
    }
  } catch(e) {
    dbgLog('INF', `[res-log] dev 서버 없음 — 메모리 누적 (${llmLog.length}건)`, 'inf');
  }
}

function downloadLlmLog() {
  if (!llmLog.length) { alert('저장된 LLM 대화 로그가 없습니다.'); return; }
  const blob = new Blob([JSON.stringify(llmLog, null, 2)], {type: 'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'rtl_converter_llm_log.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── 공통 fetch (streaming) ────────────────────────────────
//
// mode 별 파라미터 전략:
//  'rtl'     — RTL 코드 변환 (큰 출력, 엄격한 temperature/top_p)
//  'json'    — 구조화 분석 (중간 출력, 약간 유연한 top_p)
//  'json-sm' — 단일 항목 JSON (소형 출력)
//
// opts (선택):
//  Stall 감지는 phase 별로 다른 임계값 사용:
//    phase='thinking'  — 첫 청크 수신 전 (추론 모델의 thinking, 입력 처리 중)
//    phase='streaming' — 첫 청크 이후 (실제 토큰 생성 중)
//
//  firstByteWarnMs  : 첫 청크 전 이 값(ms) 초과 시 dbgLog 경고
//                     기본 300000 (5분). 추론 모델의 긴 thinking 허용
//  firstByteAbortMs : 첫 청크 전 이 값(ms) 초과 시 자동 abort
//                     기본 -1 (비활성)
//  idleWarnMs       : 청크 간 idle 시간이 이 값(ms) 초과 시 dbgLog 경고
//                     기본 60000 (60s). 사내 슬로우 LLM 의 자연스런 갭 흡수
//  idleAbortMs      : 청크 간 idle 이 이 값(ms) 초과 시 자동 abort
//                     기본 -1 (비활성). RTL 변환은 사용자 직접 중단 권장
//  onProgress       : ({ phase, stalled, idleMs, lastChunkAt, tokens, elapsedMs, firstByteAt }) => void
//                     약 1초 주기로 호출. 청크 유무와 무관하게 호출되므로
//                     UI 측 live timer 갱신용으로 활용 가능
//  onChunk(full, meta) : meta = { tokens, lastChunkAt, elapsedMs }
//                     기존 호출자(meta 무시) 와 호환됨
async function callLLM(host, model, systemMsg, userMsg, onChunk, mode = 'rtl', signal = null, opts = {}) {
  const inputTok = estimateTokens(systemMsg + userMsg);
  const apiKey   = document.getElementById('oApiKey')?.value.trim() || '';
  const endpoint = host.replace(/\/+$/, '') + '/chat/completions';

  // ── 파라미터: use=true인 것만 body에 포함 ──────────────
  const temperature = getParam('temperature', mode, inputTok);
  const seed        = getParam('seed',        mode, inputTok);
  const top_p       = getParam('top_p',       mode, inputTok);
  const thinkBuf    = getThinkingBuf(); // 계산용 (전송 안 함)

  // ── Stall watchdog 옵션 ────────────────────────────────
  // 정상 동작 false positive 최소화 위해 phase 분리:
  //   thinking — 첫 청크 전 (5분까지 정상으로 간주)
  //   streaming — 청크 흐름 중 (60s 이상 idle 이면 의심, 180s 이상이면 명백한 stall)
  const firstByteWarnMs  = (opts.firstByteWarnMs  ?? 300000);   // 5분
  const firstByteAbortMs = (opts.firstByteAbortMs ?? -1);
  const idleWarnMs       = (opts.idleWarnMs       ?? 60000);    // 1분
  const idleAbortMs      = (opts.idleAbortMs      ?? -1);
  const onProgress       = opts.onProgress;
  // previewId: 지정 시 글로벌 reasoning 핸들러가 해당 id 박스만 갱신.
  // 동시 실행(Algo + μArch 병렬)에서 서로의 preview를 덮어쓰는 현상 방지.
  const previewId        = opts.previewId ?? null;


  // dev 서버 연결 시 /llm-proxy 경유, 미연결 시 브라우저 직접 연결
  const useProxy = window._devServerAvailable;
  const fetchUrl = useProxy ? devUrl('/llm-proxy') : endpoint;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey)   headers['Authorization'] = `Bearer ${apiKey}`;
  if (useProxy) headers['X-Target-URL']  = endpoint;

  // OpenAI Compatible 표준 필드만 body에 포함
  const bodyObj = {
    model,
    stream:   true,
    messages: [
      { role: 'system', content: systemMsg },
      { role: 'user',   content: userMsg   }
    ]
  };
  if (temperature !== undefined) bodyObj.temperature = temperature;
  if (top_p       !== undefined) bodyObj.top_p       = top_p;
  if (seed !== undefined && seed !== -999) bodyObj.seed = seed;

  // ── 추론 모델 thinking 제어 (GLM-4.7, DeepSeek-R1, QwQ, Qwen3 등) ──
  // 사용자가 cfg 바의 토글로 명시적으로 켜지 않는 한 false 를 명시 전송.
  // 이 callLLM() 공통 경로에 넣어 Algo Diff, μArch Diff, Summary,
  // RTL Convert, Lint auto-fix, Iteration에 모두 동일 적용한다.
  const thinkingOn = isThinkingEnabled();

  const glmThinkingPayload = buildGlmThinkingPayload(thinkingOn);

  if (THINKING_COMPAT.chat_template_kwargs) {
    const ctk = {
      ...(bodyObj.chat_template_kwargs || {}),
      enable_thinking: thinkingOn,
      // sglang/vLLM GLM-4.7 계열은 chat_template_kwargs 에서도 clear_thinking 을 읽는 경우가 있다.
      clear_thinking: glmThinkingPayload.clear_thinking,
    };
    // thinking_budget: thinking ON + UI에서 값 설정 시에만 전송.
    // ── 모드별 차등 적용 ──────────────────────────────────
    // UI의 thinking buf 값을 base 로 하고, 작업 난이도에 따라 배수 적용.
    //   json     : 분류·매핑 작업 → base × 0.75 (짧은 추론으로 충분)
    //   json-sm  : 매우 짧은 JSON  → base × 0.5
    //   lint     : 단순 수정       → base × 0.5
    //   rtl      : 코드 생성       → base × 2.0 (충분한 추론 필요)
    //   기타     : base × 1.0
    // RTL 생성은 입력 토큰의 0.7배를 상한(cap)으로 두어 입력 대비 과도한
    // thinking 을 방지. 예: 입력 4000 tok 이면 thinking budget ≤ 2800.
    if (thinkingOn && THINKING_COMPAT.send_thinking_budget && thinkBuf > 0) {
      const _modeFactor = {
        'json':    1.5,   // Phase 1/2 분류·매핑 — 입력이 클 수 있어 여유있게 설정
        'json-sm': 0.5,
        'lint':    0.5,
        'rtl':     2.0,
      }[mode] ?? 1.0;
      let budget = Math.round(thinkBuf * _modeFactor);
      // json/rtl 모드 모두 입력 대비 cap 적용 — 입력 대비 과도한 thinking 방지
      // json: 입력 × 1.5 상한 (분류 작업에서 입력보다 훨씬 긴 thinking은 대부분 loop)
      // rtl:  입력 × 0.7 상한 (코드 생성은 thinking이 길어도 의미있으나 과도한 건 방지)
      const capFactor = mode === 'rtl' ? 0.7 : 1.5;
      const cap = Math.round(inputTok * capFactor);
      if (cap > 0 && budget > cap) budget = cap;
      // 최소 2048 보장 — 너무 작으면 추론 자체가 불가능
      budget = Math.max(2048, budget);
      ctk.thinking_budget = budget;
    }
    bodyObj.chat_template_kwargs = ctk;
  }

  // extra_body는 OpenAI SDK에서 '최종 HTTP body에 추가 병합'하기 위한 클라이언트 옵션이다.
  // 이 IDE는 fetch로 raw HTTP body를 직접 만들기 때문에 기본적으로 보내지 않는다.
  // 특수 gateway가 extra_body 필드 자체를 요구하는 경우에만 THINKING_COMPAT.extra_body=true.
  if (THINKING_COMPAT.extra_body) {
    bodyObj.extra_body = {
      ...(bodyObj.extra_body || {}),
      chat_template_kwargs: {
        ...((bodyObj.extra_body && bodyObj.extra_body.chat_template_kwargs) || {}),
        enable_thinking: thinkingOn,
        clear_thinking: glmThinkingPayload.clear_thinking,
      },
    };
  }

  // 일부 backend 는 enable_thinking 을 top-level 에서 직접 읽는다.
  // strict OpenAI-compatible 서버에서는 unknown field가 될 수 있어 기본 비활성화.
  if (THINKING_COMPAT.top_level) {
    bodyObj.enable_thinking = thinkingOn;
  }

  // Z.AI official API raw HTTP용. local vLLM/SGLang GLM-4.7에는 보통 필요 없다.
  // official 문서는 thinking.type='disabled'로 turn-level thinking OFF를 제어한다고 설명한다.
  if (THINKING_COMPAT.glm_thinking) {
    bodyObj.thinking = glmThinkingPayload;
  }

  // 일부 reasoning 모델/runtime 은 enable_thinking=false 만으로 thinking 이 꺼지지 않는다.
  // OFF 일 때 reasoning budget 을 0 으로 명시해 보강한다.
  if (!thinkingOn && THINKING_COMPAT.reasoning_budget_zero) {
    bodyObj.reasoning_budget = 0;
  }

  // ── REQUEST 로그 즉시 기록 (응답 전 — pending 진단용) ──
  const req_id   = `req-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
  const t_req    = Date.now();
  const logParts = [`[callLLM:${mode}]`, `input:~${inputTok}tok`];
  if (temperature !== undefined) logParts.push(`temperature:${temperature}`);
  if (top_p       !== undefined) logParts.push(`top_p:${top_p}`);
  if (seed !== undefined && seed !== -999) logParts.push(`seed:${seed}`);
  if (thinkBuf > 0) {
    const sentBudget = bodyObj.chat_template_kwargs?.thinking_budget;
    logParts.push(sentBudget
      ? `thinking_budget:${sentBudget}(base ${thinkBuf}×${mode})`
      : `thinking_buf:${thinkBuf}(not_sent)`);
  }
  logParts.push(`thinking:${thinkingOn ? 'ON' : 'OFF'}`);
  logParts.push(`glm:${glmThinkingPayload.type}/clear=${glmThinkingPayload.clear_thinking}`);
  dbgLog('REQ', `${logParts.join(' ')}  req_id:${req_id}`, 'req');
  if (THINKING_COMPAT.reasoning_debug) {
    dbgLog('INF', `[thinking-debug] actual thinking payload req_id:${req_id} ${compactForLog({
      chat_template_kwargs: bodyObj.chat_template_kwargs,
      top_level_enable_thinking: bodyObj.enable_thinking,
      top_level_thinking: bodyObj.thinking,
      extra_body: bodyObj.extra_body,
      reasoning_budget: bodyObj.reasoning_budget,
    })}`, 'inf');
  }

  // fetch 직전에 파일로 기록 (응답 안 와도 요청 내역 보존)
  saveReqLog({
    req_id,
    status:     'REQUEST',
    timestamp:  _nowKST(t_req),
    endpoint,
    model,
    mode,
    params: {
      ...(temperature !== undefined && { temperature }),
      ...(top_p       !== undefined && { top_p }),
      ...(seed !== undefined && seed !== -999 && { seed }),
      thinking: thinkingOn ? 'ON' : 'OFF',
      enable_thinking: thinkingOn,
      glm_thinking: glmThinkingPayload,
      thinking_compat: THINKING_COMPAT,
    },
    prompt_tokens_est: inputTok,
    request: {
      system: systemMsg.slice(0, 300) + (systemMsg.length > 300 ? '…' : ''),
      user_preview: userMsg.slice(0, 500) + (userMsg.length > 500 ? '…' : ''),
      user_tokens_est: estimateTokens(userMsg),
    },
  });

  let t_first_byte = null;

  // ── 내부 AbortController ───────────────────────────────
  // 외부 signal 과 stall watchdog 의 자동 abort 를 하나로 합쳐 fetch 에 전달.
  // 외부 signal 이 abort 되면 internal 도 abort, watchdog 이 timeout 으로
  // internal.abort() 하면 fetch / reader.read() 가 즉시 reject 됨.
  const internalCtrl = new AbortController();
  let _stallAbort = false;   // 자동 abort 인지 사용자 abort 인지 구분용
  let _loopAbort  = false;   // reasoning loop 감지로 인한 자동 abort
  if (signal) {
    if (signal.aborted) internalCtrl.abort();
    else signal.addEventListener('abort', () => internalCtrl.abort(), { once: true });
  }

  const res = await fetch(fetchUrl, {
    method:  'POST',
    headers,
    body:    JSON.stringify(bodyObj),
    signal:  internalCtrl.signal,
  });
  const t_http = Date.now();
  dbgLog('INF', `[callLLM] HTTP ${res.status} — ${t_http - t_req}ms  req_id:${req_id}`, 'inf');

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    dbgLog('ERR', `[callLLM] HTTP ${res.status} — ${errText.slice(0,200)}`, 'err');
    let errMsg = `HTTP ${res.status}`;
    try { errMsg = JSON.parse(errText).error?.message || errMsg; } catch (_) {}
    throw new Error(errMsg);
  }

  // Content-Type 확인 — non-streaming JSON 응답 fallback
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/event-stream') && !ct.includes('application/stream')) {
    // 일부 서버는 stream:true 요청에도 일반 JSON으로 응답
    const data = await res.json().catch(() => null);
    if (data) {
      const content = data.choices?.[0]?.message?.content
                   || data.choices?.[0]?.delta?.content
                   || '';
      const reason  = data.choices?.[0]?.finish_reason || '';
      dbgLog('INF', `[callLLM] non-streaming 응답 감지 (${ct}) — ${content.length}자`, 'inf');
      if (content) {
        if (onChunk) onChunk(content);
        await saveLlmLog({ timestamp: _nowKST(), endpoint, model, mode,
          finish_reason: reason, request: { system: systemMsg, user: userMsg },
          response: content, stats: { prompt_tokens_est: inputTok, response_tokens_est: Math.round(content.length/3.5) }
        });
        return { raw: content, finish: reason };
      }
      // ── content 가 비어있는 케이스 진단 ─────────────────────
      // 추론 모델의 thinking-only 응답, 다른 필드명 (text/reasoning), 컨텍스트
      // 초과 등 가능. 가능한 모든 정보를 dbgLog 와 throw 메시지에 노출.
      const choice  = data.choices?.[0];
      const message = choice?.message || {};
      const delta   = choice?.delta   || {};
      const reasoning = message.reasoning_content || message.reasoning
                     || delta.reasoning_content   || delta.reasoning   || '';
      // OpenAI o1 의 reasoning_tokens, Anthropic 의 cache_creation 등
      const usage   = data.usage || {};
      const choiceKeys  = choice  ? Object.keys(choice)  : [];
      const messageKeys = Object.keys(message);
      const allTextLike = message.text || delta.text || data.text || '';

      let _hint;
      if (reasoning && reasoning.length > 50) {
        _hint = `추론 모델이 thinking ${_fmtThinkingTok(reasoning.length)}만 만들고 답변 토큰 생성 실패. finish_reason=${reason||'(없음)'}.  더 작은 입력 또는 thinking 한도 조정 필요`;
      } else if (reason === 'length') {
        _hint = `출력 토큰 한도 도달 (finish_reason=length). num_ctx / max_tokens 늘리기 필요`;
      } else if (allTextLike) {
        _hint = `content 필드는 비었지만 다른 필드에 응답 있음 (text 등 ${allTextLike.length}자). 서버 스키마가 OpenAI 표준과 다를 가능성`;
      } else if (messageKeys.length === 0 && choiceKeys.length === 0) {
        _hint = `응답 구조 자체가 비정상. choices 없음. raw response keys: [${Object.keys(data).join(', ')}]`;
      } else {
        _hint = `응답에 content 가 없음. finish_reason=${reason||'(없음)'}, message 필드: [${messageKeys.join(', ')||'(빈 객체)'}], choice 필드: [${choiceKeys.join(', ')}]`;
      }
      dbgLog('ERR',
        `[callLLM] non-streaming 빈 content 진단:\n` +
        `  finish_reason: ${reason||'(없음)'}\n` +
        `  message keys:  [${messageKeys.join(', ')||'(빈 객체)'}]\n` +
        `  reasoning:     ${reasoning.length}자\n` +
        `  usage:         ${JSON.stringify(usage)}\n` +
        `  추정 원인:     ${_hint}\n` +
        `  raw 응답 (앞 800자):\n${JSON.stringify(data, null, 2).slice(0, 800)}`,
        'err');
      throw new Error(`응답이 비어 있습니다 (non-streaming) — ${_hint}`);
    }
    dbgLog('ERR', `[callLLM] non-streaming 응답에서 JSON 파싱 실패 — Content-Type: ${ct}`, 'err');
    throw new Error(`응답이 비어 있습니다 (non-streaming, JSON 파싱 실패) — Content-Type: ${ct}`);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let full   = '';
  let finish = '';
  let buf    = '';   // 청크 경계에 걸린 불완전 라인 누적
  let t_last_chunk  = null;
  let stallReported = false;
  // ── 진단 카운터 (빈 응답 trace 용) ─────────────────────
  // 사내 LLM 이 silent empty 로 회신할 때 정확히 어떤 형태인지 사용자에게
  // 알려주기 위한 메트릭. throw 메시지에 포함됨.
  let chunkCount       = 0;   // SSE 라인 수신 수
  let emptyDeltaCount  = 0;   // delta.content 가 비었던 청크 수
  let reasoningChars   = 0;   // delta.reasoning_content 누적 길이 (추론 모델용)
  let reasoningChunks  = 0;   // GLM reasoning delta 수신 개수
  let reasoningHead    = '';  // reasoning 앞부분 샘플 (debug)
  let reasoningTail    = '';  // reasoning 뒷부분 샘플 (debug)
  let lastRawSample    = '';  // 마지막 raw SSE 라인 샘플 (앞 200자)
  let sawDone          = false; // data: [DONE] 수신 여부
  let sseError         = '';    // 서버가 SSE 내부로 보낸 error.message
  let parseErrorCount  = 0;     // JSON 파싱 실패 SSE 라인 수
  let lastParseError   = '';    // 마지막 JSON 파싱 실패 샘플
  let pendingSseEvent  = '';    // event: error 등 SSE event name
  let lastCheckpointReasoningChars = 0; // 중간 로그 저장 기준점
  let lastCheckpointAt = 0;             // 중간 로그 저장 throttle
  let streamLogSaved = false;           // error 로그 중복 저장 방지
  let loopDetectCount = 0;              // 연속 loop 감지 횟수 (≥2 시 강제 abort)

  function buildStreamLog(status, extra = {}) {
    const now = Date.now();
    return {
      req_id,
      status,
      timestamp: _nowKST(now),
      endpoint, model, mode,
      params: {
        ...(temperature !== undefined && { temperature }),
        ...(top_p       !== undefined && { top_p }),
        ...(seed !== undefined && seed !== -999 && { seed }),
        thinking: thinkingOn ? 'ON' : 'OFF',
        enable_thinking: thinkingOn,
        glm_thinking: glmThinkingPayload,
        thinking_compat: THINKING_COMPAT,
      },
      timing: {
        req_at: _nowKST(t_req),
        first_byte_ms: t_first_byte ? t_first_byte - t_req : null,
        elapsed_ms: now - t_req,
        last_chunk_ms_ago: t_last_chunk ? now - t_last_chunk : null,
      },
      stream_state: {
        chunk_count: chunkCount,
        empty_delta_count: emptyDeltaCount,
        reasoning_chars: reasoningChars,
        reasoning_chunks: reasoningChunks,
        content_chars: full.length,
        finish_reason: finish || '',
        saw_done: sawDone,
        sse_error: sseError || '',
        parse_error_count: parseErrorCount,
        last_parse_error: lastParseError || '',
        last_raw_sample: lastRawSample || '',
        pending_sse_event: pendingSseEvent || '',
      },
      // 전체 reasoning은 너무 커질 수 있어 앞/뒤 샘플만 저장한다.
      // UI에 보인 누적 내용과 동일한 tail로, 멈춘 지점 확인에 사용.
      reasoning_debug: {
        head: reasoningHead || '',
        tail: reasoningTail || '',
      },
      partial_response: full ? full.slice(-4000) : '',
      request: {
        system: systemMsg,
        user: userMsg,
      },
      ...extra,
    };
  }

  function maybeSaveStreamCheckpoint(reason = 'reasoning') {
    if (!THINKING_COMPAT.reasoning_debug) return;
    const now = Date.now();
    const enoughReasoning = reasoningChars - lastCheckpointReasoningChars >= 2000;
    const enoughTime = now - lastCheckpointAt >= 15000;
    const milestone = reasoningChunks > 0 && reasoningChunks % 25 === 0;

    // ── reasoning loop 정밀 감지 ──────────────────────────
    // 전제 조건: 8,000자 이상 / tail 800자 이상 진행 후에만 검사
    // 두 방법 중 하나라도 12회 이상 반복 감지 시 loop 확정
    //
    // 방법 A: 줄(\n) 단위 세그먼트 — 60자 이상 줄이 12회 이상 등장
    //   → 줄 단위로 반복되는 loop (refinement on xxx :*target...)
    // 방법 B: 마침표(.) 단위 문장 — 30자 이상 문장이 12회 이상 등장
    //   → 문장 단위로 반복되는 loop (Let me re-examine...)
    // 임계값 12회: 10,000자 tail 기준으로 정상 reasoning과 구분
    // (tail이 넓어졌으므로 임계값도 함께 높임)
    const MIN_LOOP = 12;
    let loopSuspected = false;
    let loopEvidence  = '';

    if (reasoningChars >= 8000 && reasoningTail.length >= 600) {
      // 방법 A
      const lines  = reasoningTail.split('\n').map(s => s.trim()).filter(s => s.length >= 50);
        const countA = {};
        for (const s of lines) {
          const h = _simpleHash(s);
          countA[h] = (countA[h] || 0) + 1;
          if (countA[h] >= MIN_LOOP) {
            loopSuspected = true;
            loopEvidence  = `줄 반복 ${countA[h]}회: "${s.slice(0, 60)}"`;
            break;
          }
        }
      // 방법 B (A에서 미탐 시 보완)
      if (!loopSuspected) {
        const sents  = reasoningTail.split(/[.\n]/).map(s => s.trim()).filter(s => s.length >= 25);
        const countB = {};
        for (const s of sents) {
          const h = _simpleHash(s);
          countB[h] = (countB[h] || 0) + 1;
          if (countB[h] >= MIN_LOOP) {
            loopSuspected = true;
            loopEvidence  = `문장 반복 ${countB[h]}회: "${s.slice(0, 60)}"`;
            break;
          }
        }
      }
    }

    // 연속 감지 카운팅 — 4회 연속이면 abort
    if (loopSuspected) loopDetectCount++;
    else loopDetectCount = 0;

    if (!enoughReasoning && !(milestone && enoughTime) && !loopSuspected) return;
    lastCheckpointReasoningChars = reasoningChars;
    lastCheckpointAt = now;
    const cpReason = loopSuspected ? 'loop_suspected' : reason;
    void saveLlmLog(buildStreamLog('STREAM_CHECKPOINT', {
      checkpoint_reason:  cpReason,
      loop_suspected:     loopSuspected,
      loop_detect_count:  loopDetectCount,
      loop_evidence:      loopEvidence,
    }));

    if (loopSuspected) {
      dbgLog('ERR',
        `[callLLM] ⚠ reasoning loop 의심 #${loopDetectCount}\n` +
        `  evidence: ${loopEvidence}\n` +
        `  thinking: ${_fmtThinkingTok(reasoningChars)}  chunks: ${reasoningChunks}`,
        'err');

      if (loopDetectCount >= 4 && !_loopAbort) {
        _loopAbort = true;
        dbgLog('ERR',
          `[callLLM] ⛔ reasoning loop 확정 — 자동 abort (${loopDetectCount}회 연속)\n` +
          `  evidence: ${loopEvidence}\n` +
          `  thinking: ${_fmtThinkingTok(reasoningChars)}`,
          'err');
        try { internalCtrl.abort(); } catch(_) {}
      }
    }
  }

  async function saveStreamFailure(status, err) {
    if (streamLogSaved) return;
    streamLogSaved = true;
    try {
      const isThinkingPhase = full.length === 0 && reasoningChars > 0;

      // reasoning loop 감지 — 줄/문장 단위 12회 이상 반복 (10,000자 tail 기준)
      let loopDetected = false;
      if (reasoningChars >= 8000 && reasoningTail.length >= 600) {
        const lines  = reasoningTail.split('\n').map(s => s.trim()).filter(s => s.length >= 50);
        const countA = {};
        for (const s of lines) {
          const h = _simpleHash(s);
          countA[h] = (countA[h] || 0) + 1;
          if (countA[h] >= 12) { loopDetected = true; break; }
        }
        if (!loopDetected) {
          const sents  = reasoningTail.split(/[.\n]/).map(s => s.trim()).filter(s => s.length >= 25);
          const countB = {};
          for (const s of sents) {
            const h = _simpleHash(s);
            countB[h] = (countB[h] || 0) + 1;
            if (countB[h] >= 12) { loopDetected = true; break; }
          }
        }
      }

      const thinkingDiag = isThinkingPhase ? {
        phase_at_error:    'thinking',             // content 생성 전 에러
        thinking_tok_est:  _approxTokFromChars(reasoningChars),
        input_tok_est:     inputTok,
        loop_detected:     loopDetected,
        // 원인 추정
        suspected_cause:
          loopDetected                      ? 'reasoning_loop — thinking_budget 설정 권장' :
          reasoningChars > 10000            ? 'budget_or_server_limit — thinking 토큰이 많음' :
          sseError?.includes('input stream') ? 'server_internal_error — clear_thinking 또는 chat_template_kwargs 설정 확인' :
                                              'unknown',
        clear_thinking_sent: glmThinkingPayload?.clear_thinking ?? null,
        thinking_budget_sent: bodyObj?.chat_template_kwargs?.thinking_budget ?? null,
      } : {
        phase_at_error: full.length > 0 ? 'streaming' : 'pre_first_chunk',
      };

      await saveLlmLog(buildStreamLog(status, {
        error: {
          name:    err?.name    || '',
          message: err?.message || String(err || ''),
          stack:   err?.stack   ? String(err.stack).slice(0, 4000) : '',
        },
        thinking_diag: thinkingDiag,
      }));
    } catch (_) {}
  }

  // ── Stall watchdog (1초 주기) ──────────────────────────
  // reader.read() 는 timeout 이 없어 청크가 안 오면 무한 대기. 이 watchdog 이
  // 청크 간 idle 시간을 측정해서:
  //   1) phase 별 warn 임계값 초과 시 → dbgLog 경고 + onProgress 콜백
  //   2) phase 별 abort 임계값 초과 시 → internalCtrl.abort() 로 fetch 강제 종료
  //
  // Phase 분리 — 정상 동작 false positive 최소화:
  //   thinking  (첫 청크 전)  : 추론 모델 thinking / 입력 처리 중. 5분까지 정상.
  //   streaming (첫 청크 후)  : 토큰 생성 중. 60s+ idle 이면 의심, 180s+ 면 명백.
  //
  // onProgress 는 청크 유무와 무관하게 1초 주기로 호출되므로 UI 측의
  // live timer (elapsed / idle / throughput 표시) 갱신에 사용.
  const watchdog = setInterval(() => {
    const now   = Date.now();
    const phase = full ? 'streaming' : (reasoningChunks > 0 ? 'reasoning' : 'thinking');
    // streaming phase 의 idle 은 마지막 청크 기준, thinking phase 는 요청 시각 기준
    const ref    = t_last_chunk || t_req;
    const idleMs = now - ref;

    // phase 별 임계값 선택
    const warnMs  = phase === 'thinking' ? firstByteWarnMs  : idleWarnMs;
    const abortMs = phase === 'thinking' ? firstByteAbortMs : idleAbortMs;
    const stalled = warnMs > 0 && idleMs > warnMs;

    // 청크 안 와도 호출자에게 진행 상태 알림
    if (onProgress) {
      try {
        onProgress({
          phase,
          stalled,
          idleMs,
          lastChunkAt:    t_last_chunk,
          tokens:         Math.round(full.length / 3.5),
          elapsedMs:      now - t_req,
          firstByteAt:    t_first_byte,
          chunkCount,
          emptyDeltaCount,
          reasoningChars,   // thinking-only 응답 진행 표시 가능
          reasoningTokens: _approxTokFromChars(reasoningChars),
          reasoningChunks,
          reasoningTail,
          sawDone,
          sseError,
        });
      } catch(_) {}
    }

    // 첫 stall 진입 시 1회 dbgLog
    if (stalled && !stallReported) {
      stallReported = true;
      const phaseLabel = phase === 'thinking' ? '첫 청크 대기 (thinking)' : '청크 idle';
      dbgLog('INF',
        `[callLLM] ⏸ stall 의심 — ${phaseLabel} ${(idleMs/1000).toFixed(0)}s  req_id:${req_id}`,
        'inf');
    }

    // 자동 abort (옵션)
    if (abortMs > 0 && idleMs > abortMs) {
      dbgLog('ERR',
        `[callLLM] ${phase} idle ${(idleMs/1000).toFixed(0)}s > ${(abortMs/1000).toFixed(0)}s — 자동 중단  req_id:${req_id}`,
        'err');
      _stallAbort = true;
      try { internalCtrl.abort(); } catch(_) {}
    }
  }, 1000);

  try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const _now = Date.now();
    if (!t_first_byte) {
      t_first_byte = _now;
      dbgLog('INF', `[callLLM] 첫 청크 수신 — ${_now - t_req}ms  req_id:${req_id}`, 'inf');
    }
    t_last_chunk = _now;
    if (stallReported) {
      stallReported = false;
      dbgLog('INF', `[callLLM] ▶ 청크 재개  req_id:${req_id}`, 'inf');
    }
    buf += decoder.decode(value, { stream: true });

    // 완전한 라인 단위로 처리
    // \r\n (Windows/일부 gateway) → \n 으로 정규화 후 분리.
    // trimStart/trimEnd 만으로는 중간 \r 이 jsonStr 에 남아 JSON.parse 실패.
    const lines = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    buf = lines.pop() ?? '';   // 마지막 불완전 라인은 다음 청크로

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('event:')) {
        pendingSseEvent = trimmed.slice(6).trim();
        continue;
      }
      if (trimmed === 'data: [DONE]') {
        sawDone = true;
        continue;
      }
      // SSE는 event:, id:, retry: 같은 메타 라인이나 일부 gateway의
      // reasoning_content: ... 같은 비표준 디버그 라인이 섞일 수 있다.
      // 기존 v2는 data:가 아닌 모든 라인을 JSON으로 파싱하려 해서
      // GLM stream에서 JSON parse 실패가 발생했다.
      let jsonStr = '';
      if (trimmed.startsWith('data:')) {
        jsonStr = trimmed.slice(5).trimStart();
      } else if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        // 일부 서버는 data: prefix 없이 JSON chunk를 직접 보낸다.
        jsonStr = trimmed;
      } else if (/^[A-Za-z_][A-Za-z0-9_-]*:/.test(trimmed)) {
        // SSE 확장 필드 또는 gateway debug line. JSON chunk가 아니므로 무시.
        if (THINKING_COMPAT.reasoning_debug && parseErrorCount < 3) {
          dbgLog('INF', `[callLLM] SSE non-JSON line ignored — ${trimmed.slice(0, 160)}`, 'inf');
        }
        continue;
      } else {
        if (THINKING_COMPAT.reasoning_debug && parseErrorCount < 3) {
          dbgLog('INF', `[callLLM] SSE unknown non-JSON line ignored — ${trimmed.slice(0, 160)}`, 'inf');
        }
        continue;
      }
      if (!jsonStr || jsonStr === '[DONE]') {
        if (jsonStr === '[DONE]') sawDone = true;
        continue;
      }
      // GLM/SGLang 일부 환경은 data: prefix 뒤에 JSON이 아닌 보조 텍스트
      // 예: data: reasoning_content: ..., data: role: assistant 를 흘릴 수 있다.
      if (!/^\s*[\[{]/.test(jsonStr)) {
        // ── non-JSON reasoning 파싱 ────────────────────────
        // SGLang GLM-4.7 이 "reasoning_content: <text>" 또는
        // "thinking: <text>" 형태로 thinking 을 흘리는 경우 파싱해서 반영.
        // 이 경로로 들어오면 chunkCount 는 증가하지 않지만
        // reasoningChars 는 올려서 진단/preview 에 사용.
        const rcMatch = jsonStr.match(/^(?:reasoning_content|thinking):\s*([\s\S]+)/);
        if (rcMatch) {
          const rcText = rcMatch[1];
          reasoningChars  += rcText.length;
          reasoningChunks += 1;
          reasoningHead    = reasoningHead || rcText.slice(0, 800);
          reasoningTail    = (reasoningTail + rcText).slice(-10000);
          emitReasoningStream({
            reasoningDelta:   rcText,
            reasoningPreview: reasoningTail,
            reasoningChars,
            reasoningTokens:  _approxTokFromChars(reasoningChars),
            reasoningChunks,
            contentChars:     full.length,
            req_id,
            previewId,
          });
          maybeSaveStreamCheckpoint('reasoning_non_json');
          if (THINKING_COMPAT.reasoning_debug && (reasoningChunks === 1 || reasoningChunks % 50 === 0)) {
            dbgLog('INF',
              `[thinking-debug] non-JSON reasoning #${reasoningChunks} +${_fmtThinkingTok(rcText.length)} 누적:${_fmtThinkingTok(reasoningChars)} req_id:${req_id}`,
              'inf');
          }
        } else if (THINKING_COMPAT.reasoning_debug && parseErrorCount < 3) {
          dbgLog('INF', `[callLLM] SSE data non-JSON ignored — ${jsonStr.slice(0, 160)}`, 'inf');
        }
        continue;
      }
      chunkCount++;
      lastRawSample = jsonStr.slice(0, 200);

      try {
        const json   = JSON.parse(jsonStr);
        // OpenAI-compatible 서버가 HTTP 200 스트림 내부에 error 이벤트를
        // 흘려보내는 경우가 있다. 기존 코드는 choices가 없으면 조용히
        // 빈 delta로 처리해서 실제 에러를 숨겼다.
        const errObj = json.error || (pendingSseEvent === 'error' ? json : null);
        if (errObj) {
          const errMsg = errObj.message || errObj.error || json.message || JSON.stringify(errObj).slice(0, 500);
          sseError = errMsg;

          // ── thinking 중 에러 vs 스트리밍 중 에러 구분 ──────
          const isThinkingPhase = full.length === 0 && reasoningChars > 0;
          const thinkingCtx = isThinkingPhase
            ? `\n  ※ thinking 도중 중단 — content 생성 전 에러`
            : (full.length > 0 ? `\n  ※ content 생성 중 에러 (${full.length}자 수신 후)` : '');

          // reasoning loop 여부 추정 (tail 반복 패턴 감지)
          let loopHint = '';
          if (reasoningTail.length > 200) {
            const tail = reasoningTail.slice(-400);
            const half = tail.slice(0, 200);
            if (tail.slice(200).includes(half.slice(0, 40))) {
              loopHint = '\n  ※ reasoning tail에 반복 패턴 감지 — reasoning loop 의심';
            }
          }

          // thinking budget 초과 추정
          const budgetHint = (isThinkingPhase && reasoningChars > 10000)
            ? `\n  ※ thinking ${_fmtThinkingTok(reasoningChars)} — budget 초과 또는 서버 내부 한도 도달 의심`
            : '';

          dbgLog('ERR',
            `[callLLM] SSE error event — ${errMsg}` +
            `\n  event: ${pendingSseEvent || '(none)'}` +
            `\n  finish_reason: ${finish || '(없음)'}` +
            `\n  chunks: ${chunkCount}, thinking: ${_fmtThinkingTok(reasoningChars)}, content: ${full.length}자` +
            thinkingCtx + loopHint + budgetHint +
            `\n  reasoning_head: ${reasoningHead.slice(0, 120) || '(없음)'}` +
            `\n  reasoning_tail: ${reasoningTail.slice(-200) || '(없음)'}` +
            `\n  input_tok_est: ~${inputTok}` +
            `\n  raw: ${jsonStr.slice(0, 800)}`,
            'err');

          // 원인 추정 hint — 에러 메시지에 포함해 UI에도 노출
          let causeHint = '';
          if (loopHint)   causeHint = ' [reasoning loop 의심 — thinking_budget 설정 권장]';
          else if (budgetHint) causeHint = ' [thinking budget 초과 의심 — thinking_budget 값 조정]';
          else if (isThinkingPhase) causeHint = ' [thinking 도중 중단 — clear_thinking 설정 또는 서버 내부 오류]';

          throw new Error(`LLM stream error — ${errMsg}${causeHint}`);
        }
        pendingSseEvent = '';
        const delta  = json.choices?.[0]?.delta?.content ?? '';
        // 추론 모델 (DeepSeek-R1, QwQ, Kimi-K2.5, GLM-4.7 등) — thinking 토큰은
        // 별도 필드로 옴. content 가 비어도 reasoning 만 들어오는 경우가 있어
        // 따로 카운트해서 진단에 활용.
        // GLM-4.7 vLLM/SGLang 은 reasoning_content 또는 thinking_content 를 사용.
        const reasoning = json.choices?.[0]?.delta?.reasoning_content
                        ?? json.choices?.[0]?.delta?.thinking_content
                        ?? json.choices?.[0]?.delta?.reasoning
                        ?? '';
        const reason = json.choices?.[0]?.finish_reason;
        if (reasoning) {
          reasoningChars += reasoning.length;
          reasoningChunks++;
          if (reasoningHead.length < 800) reasoningHead = (reasoningHead + reasoning).slice(0, 800);
          reasoningTail = (reasoningTail + reasoning).slice(-10000);
          emitReasoningStream({
            reasoningDelta: reasoning,
            reasoningPreview: reasoningTail,
            reasoningChars,
            reasoningTokens: _approxTokFromChars(reasoningChars),
            reasoningChunks,
            contentChars: full.length,
            req_id,
            previewId,
            sawDone,
            sseError,
          });
          if (THINKING_COMPAT.reasoning_debug && (reasoningChunks === 1 || reasoningChunks % 25 === 0)) {
            dbgLog('INF', `[thinking-debug] reasoning delta #${reasoningChunks} +${_fmtThinkingTok(reasoning.length)} 누적:${_fmtThinkingTok(reasoningChars)} req_id:${req_id}`, 'inf');
          }
          if (onProgress) {
            try {
              onProgress({
                phase: full ? 'streaming' : 'thinking',
                stalled: false,
                idleMs: 0,
                lastChunkAt: _now,
                tokens: Math.round(full.length / 3.5),
                elapsedMs: _now - t_req,
                firstByteAt: t_first_byte,
                chunkCount,
                emptyDeltaCount,
                reasoningChars,
                reasoningTokens: _approxTokFromChars(reasoningChars),
                reasoningChunks,
                reasoningDelta: reasoning,
                reasoningTail,
                sawDone,
                sseError,
              });
            } catch(_) {}
          }
          maybeSaveStreamCheckpoint('reasoning');
        }
        if (delta) {
          full += delta;
          if (onChunk) {
            onChunk(full, {
              tokens:        Math.round(full.length / 3.5),
              lastChunkAt:   _now,
              elapsedMs:     _now - t_req,
              reasoningChars,   // 호출자가 thinking 진행 표시 가능
              reasoningChunks,
            });
          }
        } else {
          emptyDeltaCount++;
        }
        if (reason) finish = reason;
      } catch (err) {
        if (String(err?.message || '').startsWith('LLM stream error')) throw err;
        parseErrorCount++;
        lastParseError = jsonStr.slice(0, 500);
        if (THINKING_COMPAT.reasoning_debug && parseErrorCount <= 3) {
          dbgLog('ERR', `[callLLM] SSE JSON parse 실패 #${parseErrorCount} — ${lastParseError}`, 'err');
        }
      }
    }
  }

  // 버퍼 잔여 처리
  if (buf.trim()) {
    const trimmedBuf = buf.trim();
    if (trimmedBuf === 'data: [DONE]') {
      sawDone = true;
    } else {
      let jsonStr = '';
      if (trimmedBuf.startsWith('data:')) {
        jsonStr = trimmedBuf.slice(5).trimStart();
      } else if (trimmedBuf.startsWith('{') || trimmedBuf.startsWith('[')) {
        jsonStr = trimmedBuf;
      } else if (/^[A-Za-z_][A-Za-z0-9_-]*:/.test(trimmedBuf)) {
        jsonStr = '';
      } else {
        jsonStr = '';
      }
      if (jsonStr === '[DONE]') {
        sawDone = true;
      } else if (jsonStr && /^\s*[\[{]/.test(jsonStr)) {
        try {
          const json  = JSON.parse(jsonStr);
          const errObj = json.error || (pendingSseEvent === 'error' ? json : null);
          if (errObj) {
            const errMsg = errObj.message || errObj.error || json.message || JSON.stringify(errObj).slice(0, 500);
            sseError = errMsg;
            dbgLog('ERR', `[callLLM] SSE residual error — ${errMsg}`, 'err');
            throw new Error(`LLM stream error — ${errMsg}`);
          }
          const delta = json.choices?.[0]?.delta?.content ?? '';
          const reasoning = json.choices?.[0]?.delta?.reasoning_content
                      ?? json.choices?.[0]?.delta?.thinking_content
                      ?? json.choices?.[0]?.delta?.reasoning
                      ?? '';
          if (reasoning) {
            reasoningChars += reasoning.length;
            reasoningChunks++;
            if (reasoningHead.length < 800) reasoningHead = (reasoningHead + reasoning).slice(0, 800);
            reasoningTail = (reasoningTail + reasoning).slice(-10000);
            emitReasoningStream({
              reasoningDelta: reasoning,
              reasoningPreview: reasoningTail,
              reasoningChars,
              reasoningTokens: _approxTokFromChars(reasoningChars),
              reasoningChunks,
              contentChars: full.length,
              req_id,
              previewId,
              sawDone,
              sseError,
            });
            if (onProgress) {
              try {
                onProgress({
                  phase: full ? 'streaming' : 'thinking',
                  stalled: false,
                  idleMs: 0,
                  lastChunkAt: Date.now(),
                  tokens: Math.round(full.length / 3.5),
                  elapsedMs: Date.now() - t_req,
                  chunkCount,
                  emptyDeltaCount,
                  reasoningChars,
                  reasoningTokens: _approxTokFromChars(reasoningChars),
                  reasoningChunks,
                  reasoningDelta: reasoning,
                  reasoningTail,
                  sawDone,
                  sseError,
                });
              } catch(_) {}
            }
          }
          if (delta) {
            full += delta;
            if (onChunk) onChunk(full, {
              tokens:      Math.round(full.length / 3.5),
              lastChunkAt: t_last_chunk,
              elapsedMs:   Date.now() - t_req,
            });
          }
          const reason = json.choices?.[0]?.finish_reason;
          if (reason) finish = reason;
        } catch (err) {
          if (String(err?.message || '').startsWith('LLM stream error')) throw err;
          parseErrorCount++;
          lastParseError = jsonStr.slice(0, 500);
          if (THINKING_COMPAT.reasoning_debug && parseErrorCount <= 3) {
            dbgLog('ERR', `[callLLM] SSE residual JSON parse 실패 #${parseErrorCount} — ${lastParseError}`, 'err');
          }
        }
      } else if (jsonStr) {
        if (THINKING_COMPAT.reasoning_debug && parseErrorCount < 3) {
          dbgLog('INF', `[callLLM] SSE residual non-JSON ignored — ${jsonStr.slice(0, 160)}`, 'inf');
        }
      }
    }
  }
  } catch (e) {
    // loop watchdog 의 자동 abort 인 경우 → 명확한 loop 에러로 변환
    if ((e?.name === 'AbortError' || e?.code === 'ABORT_ERR') && _loopAbort) {
      const loopErr = new Error(`LLM reasoning loop — 동일 패턴 반복 감지로 자동 중단 (thinking ${_fmtThinkingTok(reasoningChars)}, content ${full.length}자). 재시도 권장.`);
      loopErr.isLoopAbort = true;   // 상위 재시도 로직이 식별 가능
      await saveStreamFailure('STREAM_LOOP_ABORT', loopErr);
      throw loopErr;
    }
    // stall watchdog 의 자동 abort 인 경우 → 명확한 timeout 에러로 변환.
    // (AbortError 그대로 throw 하면 호출자의 사용자-중단 분기로 잘못 들어감)
    if ((e?.name === 'AbortError' || e?.code === 'ABORT_ERR') && _stallAbort) {
      const timeoutErr = new Error(`LLM 무응답 timeout — ${(idleAbortMs/1000).toFixed(0)}s 동안 청크 미수신 (thinking ${_fmtThinkingTok(reasoningChars)}, content ${full.length}자, finish=${finish || '(없음)'}, DONE=${sawDone ? 'yes' : 'no'}, sseError=${sseError || '(없음)'})`);
      await saveStreamFailure('STREAM_TIMEOUT', timeoutErr);
      throw timeoutErr;
    }
    await saveStreamFailure('STREAM_ERROR', e);
    throw e;
  } finally {
    clearInterval(watchdog);
  }

  if (!full) {
    // abort된 경우는 조용히 AbortError를 다시 throw해 상위에서 처리
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    // loop watchdog 자동 abort
    if (_loopAbort) {
      const loopErr = new Error(`LLM reasoning loop — 동일 패턴 반복 감지로 자동 중단 (thinking ${_fmtThinkingTok(reasoningChars)}, content ${full.length}자). 재시도 권장.`);
      loopErr.isLoopAbort = true;
      await saveStreamFailure('STREAM_LOOP_ABORT', loopErr);
      throw loopErr;
    }
    // stall watchdog 의 자동 abort 인 경우 — 명확한 에러 메시지로 구분
    if (_stallAbort) {
      const timeoutErr = new Error(`LLM 무응답 timeout — ${(idleAbortMs/1000).toFixed(0)}s 동안 청크 미수신 (thinking ${_fmtThinkingTok(reasoningChars)}, content ${full.length}자, finish=${finish || '(없음)'}, DONE=${sawDone ? 'yes' : 'no'}, sseError=${sseError || '(없음)'})`);
      await saveStreamFailure('STREAM_TIMEOUT', timeoutErr);
      throw timeoutErr;
    }
    // ── 빈 응답 진단 정보 ─────────────────────────────────
    // 사내 LLM 이 silent empty 로 회신하는 경우 정확히 어떤 패턴인지
    // 사용자가 알 수 있도록 메트릭을 dbgLog + throw 메시지에 동시에 노출.
    const diag = {
      mode,
      finish:           finish || '(없음)',
      chunks:           chunkCount,
      emptyDeltas:      emptyDeltaCount,
      reasoningChars,
      reasoningChunks,
      reasoningHead:     reasoningHead || '(없음)',
      reasoningTail:     reasoningTail || '(없음)',
      lastRawSample:    lastRawSample || '(없음)',
      sawDone,
      sseError:         sseError || '(없음)',
      parseErrorCount,
      lastParseError:   lastParseError || '(없음)',
      firstByteMs:      t_first_byte ? (t_first_byte - t_req) : null,
      totalMs:          Date.now() - t_req,
    };
    dbgLog('ERR',
      `[callLLM] 빈 응답 진단:\n` +
      `  finish_reason: ${diag.finish}\n` +
      `  청크 수: ${diag.chunks} (그 중 delta 빈 청크: ${diag.emptyDeltas})\n` +
      `  thinking 토큰: ${_fmtThinkingTok(diag.reasoningChars)} (JSON delta 경로)\n` +
      `  non-JSON reasoning: ${reasoningChunks > 0 && diag.chunks === 0 ? `${reasoningChunks}개 청크 (non-JSON 경로로만 수신 — SGLang 호환 모드)` : '없음'}\n` +
      `  reasoning head: ${String(diag.reasoningHead).slice(0, 240)}\n` +
      `  reasoning tail: ${String(diag.reasoningTail).slice(0, 240)}\n` +
      `  DONE 수신: ${diag.sawDone ? 'yes' : 'no'}, SSE error: ${diag.sseError}\n` +
      `  JSON parse 실패: ${diag.parseErrorCount}, 마지막 parse 실패 샘플: ${diag.lastParseError}\n` +
      `  첫 청크: ${diag.firstByteMs ? diag.firstByteMs+'ms' : '없음'}, 총 시간: ${diag.totalMs}ms\n` +
      `  마지막 raw 샘플: ${diag.lastRawSample}\n` +
      `  endpoint: ${endpoint}`,
      'err');

    // 사용자 친화 메시지 — 가장 가능성 높은 원인을 추정
    let hint;
    if (diag.sseError && diag.sseError !== '(없음)') {
      hint = `서버가 스트림 내부 error를 반환했습니다: ${diag.sseError}`;
    } else if (diag.finish === 'length') {
      hint = '출력 토큰 한도 도달 (finish=length) — num_ctx 또는 max_tokens 확인';
    } else if (diag.chunks === 0 && reasoningChunks === 0) {
      hint = '청크 미수신 — 서버가 응답을 시작하지 않았습니다 (컨텍스트 초과 또는 게이트웨이 차단 의심)';
    } else if (diag.chunks === 0 && reasoningChunks > 0) {
      // non-JSON 경로로만 reasoning 수신 후 content 없이 종료
      hint = `thinking(${_fmtThinkingTok(diag.reasoningChars)})만 하고 content 미생성 — non-JSON reasoning 경로 감지 (SGLang 호환 모드). thinking_budget 또는 clear_thinking 설정 확인`;
    } else if (diag.reasoningChars > 100 && diag.emptyDeltas > 0) {
      hint = `추론 모델이 thinking 만 하고 답변 토큰을 생성하지 못했습니다 (thinking ${_fmtThinkingTok(diag.reasoningChars)}, DONE=${diag.sawDone ? 'yes' : 'no'}) — 더 작은 입력 또는 thinking 한도 조정 권장`;
    } else if (diag.emptyDeltas > 0 && diag.chunks > 0) {
      hint = `${diag.chunks}개 청크 모두 content=빈값 (finish=${diag.finish}) — 입력 형식 문제 의심`;
    } else {
      hint = `finish=${diag.finish}, 청크=${diag.chunks}`;
    }
    const emptyErr = new Error(`응답이 비어 있습니다 — ${hint}`);
    await saveStreamFailure('EMPTY_RESPONSE', emptyErr);
    throw emptyErr;
  }

  // LLM 대화 로그 기록 (REQUEST 로그를 RESPONSE로 업데이트)
  const t_done = Date.now();
  dbgLog('RES', `[callLLM] 완료 — 전체:${t_done - t_req}ms  첫청크:${t_first_byte ? t_first_byte - t_req : '-'}ms  req_id:${req_id}`, 'res');
  await saveLlmLog({
    req_id,
    status:     'RESPONSE',
    timestamp:  _nowKST(),
    endpoint,   model,   mode,
    timing: {
      req_at:         _nowKST(t_req),
      http_ms:        t_http - t_req,
      first_byte_ms:  t_first_byte ? t_first_byte - t_req : null,
      total_ms:       t_done - t_req,
    },
    params: {
      ...(temperature !== undefined && { temperature }),
      ...(top_p       !== undefined && { top_p }),
      ...(seed !== undefined && seed !== -999 && { seed }),
      thinking: thinkingOn ? 'ON' : 'OFF',
      enable_thinking: thinkingOn,
      glm_thinking: glmThinkingPayload,
      thinking_compat: THINKING_COMPAT,
    },
    finish_reason: finish,
    request:  { system: systemMsg, user: userMsg },
    response: full,
    stats: {
      prompt_chars:        (systemMsg + userMsg).length,
      response_chars:      full.length,
      prompt_tokens_est:   Math.round((systemMsg + userMsg).length / 3.5),
      response_tokens_est: Math.round(full.length / 3.5),
      reasoning_chars:     reasoningChars,
      reasoning_chunks:    reasoningChunks,
      saw_done:            sawDone,
      sse_error:           sseError || '',
      parse_error_count:   parseErrorCount,
      ...(THINKING_COMPAT.reasoning_debug && {
        reasoning_head: reasoningHead,
        reasoning_tail: reasoningTail,
      }),
    }
  });

  return { raw: full, finish };
}

// ════════════════════════════════════════════════════════
// callLLMWithRetry — callLLM 의 자동 재시도 wrapper
// ────────────────────────────────────────────────────────
// 최대 3회까지 재시도. 재시도 사유:
//   - reasoning loop 감지로 자동 abort (isLoopAbort)
//   - LLM 무응답 timeout
//   - SSE stream error
//   - 빈 응답 (EMPTY_RESPONSE)
//   - 네트워크 오류 (TypeError, fetch failed 등)
//
// 재시도 안 함:
//   - 사용자 중단 (AbortError + signal.aborted)
//   - HTTP 4xx (auth, bad request 등 영구 실패)
//
// onChunk 콜백은 매 시도마다 호출되므로, 호출자는 partial 누적 초기화
// 책임이 있다. 단순화를 위해 onChunk 가 직접 raw 를 덮어쓰는 패턴이면
// 자동으로 마지막 시도 결과만 남는다.
// ════════════════════════════════════════════════════════
async function callLLMWithRetry(host, model, systemMsg, userMsg, onChunk, mode = 'rtl', signal = null, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.retryDelayMs ?? 2000;   // 1차 2s, 2차 4s, 3차 8s 백오프
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        const delay = baseDelayMs * Math.pow(2, attempt - 2);   // 2s → 4s → 8s
        dbgLog('INF', `[callLLM] 🔁 재시도 ${attempt}/${maxAttempts} — ${(delay/1000).toFixed(0)}s 대기 후 (직전 오류: ${lastErr?.message?.slice(0, 120) || 'unknown'})`, 'inf');
        // 대기 중 사용자 중단 가능
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, delay);
          if (signal) {
            const onAbort = () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      }
      return await callLLM(host, model, systemMsg, userMsg, onChunk, mode, signal, opts);
    } catch (e) {
      lastErr = e;

      // 사용자 중단은 즉시 종료, 재시도 안 함
      if (signal?.aborted || (e?.name === 'AbortError' && !e?.isLoopAbort)) {
        throw e;
      }
      // HTTP 4xx 류는 재시도해도 같은 결과, 즉시 종료
      // (status 코드는 callLLM 내부에서 throw 시 message 에 포함됨)
      if (/HTTP 4\d\d/.test(e?.message || '')) {
        dbgLog('ERR', `[callLLM] HTTP 4xx — 재시도 무의미, 즉시 종료: ${e.message}`, 'err');
        throw e;
      }
      // 마지막 시도 실패 → 그대로 throw
      if (attempt === maxAttempts) {
        dbgLog('ERR', `[callLLM] ✕ 최대 재시도(${maxAttempts}회) 모두 실패 — 최종 오류: ${e?.message || e}`, 'err');
        throw e;
      }
      // 재시도 가능 케이스 로깅
      const reason = e?.isLoopAbort ? 'reasoning_loop' :
                     /timeout/i.test(e?.message) ? 'timeout' :
                     /stream error/i.test(e?.message) ? 'stream_error' :
                     /비어\s*있/i.test(e?.message) ? 'empty_response' :
                     'other';
      dbgLog('INF', `[callLLM] 시도 ${attempt}/${maxAttempts} 실패 (${reason}) — 다음 시도 예정`, 'inf');
    }
  }
  // 도달 불가
  throw lastErr || new Error('callLLMWithRetry: unreachable');
}
