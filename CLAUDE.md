# CLAUDE.md — RTL Converter IDE 개발 컨텍스트

이 파일은 Claude Code 등 AI 에이전트가 이 프로젝트를 이해하고 작업할 때 참조하는 컨텍스트 문서입니다.

---

## 프로젝트 개요

삼성 DS 인트라넷 배포용 단일 HTML 파일 RTL 변환 도구입니다.  
Algorithm / μArch 문서 diff를 LLM에 분석시키고, 그 결과를 바탕으로 Verilog/SystemVerilog 또는 SystemC(HLS) 파일을 자동 변환합니다.

**핵심 원칙:** 변환 결과는 RTL 엔지니어가 직접 읽고 수정하는 중간 산출물입니다.  
따라서 원본 코드 구조/스타일/주석을 최대한 보존하고, 변경점만 최소한으로 적용합니다.

---

## 파일 구조

```
rtl_algo_converter.html      메인 앱 (~6,000줄 HTML+CSS+inline JS)
js/
  prompts.js                 출력 언어 + UARCH_TABLE_RULES + LANG_CFG  (~120줄)
  llm-client.js              callLLM + 로그 함수                         (~280줄)
  server-connection.js       devUrl + ping + long-poll + .env 부트스트랩 (~170줄)

rtl-dev-server.js            Node.js 개발 서버 (포트 3000) — 로컬 개발용
rtl_server.py                Python FastAPI 서버 (포트 8080) — Docker 운영용
Dockerfile                   Python 서버 이미지 빌드
docker-compose.yml           운영 배포 정의
requirements.txt             Python 의존성

rtl-converter-config.js      튜닝 설정 (양 서버 공유)
rtl-converter-hooks.js       Hook 정의 (선택, 양 서버 공유)
env.example                  .env 템플릿
```

**모듈 분리 정책:** 인트라넷 배포 특성상 단일 HTML 정책은 유지하되, 기능적으로 응집도가 높은 영역(시스템 프롬프트 / LLM 클라이언트 / 서버 통신)은 `js/` 하위로 분리. 글로벌 스코프는 그대로 공유 (script 태그만 끊고 모듈 시스템 미사용) — 동기 로드 순서로 원래 inline 코드와 동일한 실행 순서 보장.

**서버 이중 구현:** 동일 엔드포인트를 Node.js(개발용)와 Python FastAPI(운영용)가 각각 제공합니다. 브라우저는 `_tryPing()`으로 둘 중 살아있는 쪽을 자동 감지(VS Code 포트포워딩 / 직접 접속 / `file://` 직접 열기 모두 지원).

---

## 아키텍처

```
브라우저 (rtl_algo_converter.html)
    │
    ├── /env, /config, /hooks   설정 로드
    ├── /llm-proxy, /get-proxy  LLM 요청 프록시 (CORS 우회, 스트리밍)
    ├── /save-log               LLM 대화 로그 저장
    ├── /lint                   Verilog/SystemC lint 실행
    ├── /hook                   외부 Webhook 호출 (Slack 등 — Python 전용)
    └── /api/poll               명령 큐 폴링 (3초 간격, Python 전용)
         ↓
    ┌───────────────┴────────────────┐
    │                                 │
rtl-dev-server.js              rtl_server.py
(Node.js, :3000)               (FastAPI/uvicorn, :8080, Docker)
    │                                 │
    │   동일 엔드포인트 제공            │   추가 기능:
    │                                 │     · 명시적 OUTBOUND_PROXY (.env)
    │                                 │     · 스트리밍 응답 분기
    │                                 │     · Hook 시스템
    │                                 │     · /api/auto-run-* 명령 큐
    └───────────────┬────────────────┘
                    ↓
    ├── OpenAI Compatible LLM 서버 (사내 서버)
    └── verible / iverilog / clang++ (로컬 설치)

외부 자동화 시스템 (CI/CD 등)
    └── POST /api/auto-run-analysis | /api/auto-run-convert | /api/auto-run
         → Python 서버 in-memory deque 큐에 적재
         → 브라우저가 /api/poll 로 3초마다 가져가 자동 실행
```

---

## 전체 변환 플로우

```
Step 0 (cur=0): RTL 파일 업로드
  → addRtlFiles() → buildDepGraph() 자동 실행
  → _depGraph: 모듈 인스턴스 관계 (2-hop BFS용)

Step 1 (cur=1): Algorithm AS-IS/TO-BE 등록
Step 2 (cur=2): Algo Diff + AI 분석
  → reAnalyzeImpact('algo') → _impactData.algo
  → ALGO-001, ALGO-002 ... ID 부여 (항상 001부터 시작)

Step 3 (cur=3): μArch AS-IS/TO-BE 등록
Step 4 (cur=4): μArch Diff + AI 분석
  → reAnalyzeImpact('uarch') → _impactData.uarch
  → ARCH-001, ARCH-002 ... ID 부여 (항상 001부터 시작)

Step 5 (cur=5): Summary
  → Phase 1: runSummaryPhase1() — Target RTL 선정
    dep graph 힌트 포함하여 LLM이 target/ref/exclude 판단
  → Phase 2: runSummaryPhase2() — μArch 섹션 매핑

Step 6 (cur=6): RTL 변환
  → checkTokensAndRun()
    < 128K → _runBatchNow('single')
    ≥ 128K + largeCxtModel → _runBatchNow('single') 그대로
    ≥ 128K + 일반 모델 → 경고 모달 (순차/단일 선택)
  → 변환 후 lintAndFix() 자동 실행 (dev 서버 연결 시)
    오류 시 LLM 자동 재시도 최대 2회
```

---

## 핵심 전역 상태

```javascript
// 파일 목록
rtlFiles[]        // { name, content, status, result, changes, history, lintResult, _p1Excluded, _p1Ref }
algoPairs[]       // Algo diff 페어
uarchPairs[]      // μArch diff 페어

// AI 분석 결과
_impactData       // { algo: {items[], summary}, uarch: {items[], summary} }
_impactHistory    // undo 스택
_impactRedo       // redo 스택

// Summary 결과
_summaryTargetFiles[]     // Phase 1 결과
_summaryUarchSections[]   // Phase 2 결과
_summaryAnalysisDone      // Summary 완료 여부

// 의존성 그래프
_depGraph         // { fname: { moduleNames, instantiates[], instantiatedBy[], portBindings{} } }

// 출력 언어
_outputLang       // 'rtl' | 'systemc'
getLang()         // LANG_CFG[_outputLang] — 언어별 설정 객체

// 실행 모드
_currentRunMode   // 'single' | 'sequential'
convMode          // 'single' (고정 상수)
```

---

## 언어별 설정 (LANG_CFG)

```javascript
LANG_CFG = {
  rtl: {
    fileExts:     /\.(v|sv|verilog)$/i,
    expert:       'You are an expert RTL (Verilog/SystemVerilog) engineer.',
    construct:    'signal/port/always block/parameter',
    extractSig:   'verilog',   // extractSignature() 분기 기준
    ...
  },
  systemc: {
    fileExts:     /\.(cpp|h|hpp|cc)$/i,
    expert:       'You are an expert SystemC/HLS engineer.',
    construct:    'SC_MODULE/port/signal/process/channel/HLS pragma',
    extractSig:   'systemc',
    ...
  }
}
```

---

## LLM 호출 구조

모든 LLM 호출은 `callLLM(host, model, systemMsg, userMsg, onChunk, mode, signal)` 단일 함수를 통합니다.

```javascript
mode 값:
  'rtl'      변환 프롬프트 (temperature 슬라이더 적용)
  'json'     분석 프롬프트 (JSON 응답)
  'json-sel' 파일 선택 분석
  'json-sm'  항목 분류 (소형)
```

### LLM Freeze/Abort 시스템

```javascript
_llmFreeze(key, btnId, stopBtnId, label)  // 버튼 비활성화 + stop 버튼 표시 + AbortController 생성
_llmUnfreeze(key)                          // 복구
_llmAbort(key)                             // fetch abort + 복구
```

| key | 버튼 |
|---|---|
| `'algo-analyze'` | `adAnalyzeBtn` / `adStopBtn` |
| `'uarch-analyze'` | `udAnalyzeBtn` / `udStopBtn` |
| `'sum-analyze'` | `sumAnalyzeBtn` / `sumStopBtn` |
| `'iter-analyze'` | `iterAnalyzeBtn` / `iterAnalyzeStopBtn` |
| `'iter-run'` | `iterRunBtn` / `iterRunStopBtn` |

### 변환 / Pre-clarify 전용 AbortController

`_llmFreeze` 패턴이 단발 LLM 호출에 적합한 반면, RTL 변환은 다중 callLLM 호출 + lint + 자동 수정 + 청크 루프가 얽혀 있어서 별도 컨트롤러를 사용:

| 컨트롤러 | 용도 | 사용처 |
|---|---|---|
| `_batchAbortController` | RTL 변환 + lint/autoFix 전체 흐름의 즉시 abort | `runSingleContext` / `runSequential` / `lintAndFix` / `autoFixLint` 의 `callLLM`/`fetch` 모두 이 signal 사용. 사용자 ■ 중단 (`stopBtn`) → `stopBatch()` 가 abort |
| `_preClarifyAbortController` | 사전 검토(LLM 질문 생성) 단계의 즉시 abort | `_runPreClarifyLLM` 의 `callLLM` signal. preClarifyModal 내 ■ 중단 (`preClarifyAbortBtn`) → `preClarifyAbort()` 가 abort |

각 함수는 `e.name === 'AbortError'` 를 별도 분기로 처리해서 사용자 중단을 오류로 취급하지 않고, 변환 결과 슬롯을 `wait` 상태로 되돌려 ↺ 이어서 변환이 가능하도록 정리합니다.

### Lint Missing Module 정책

`lintAndFix` 안에서 lint 결과의 오류를 `classifyMissingModuleErrors()` 로 분류합니다:

```javascript
{ missing: [{...err, moduleName}],   // 정의되지 않은 module/식별자 참조
  others: [...err] }                  // 일반 syntax/port 오류
```

`missing.length > 0` 이면 `askMissingModuleDecision()` 모달을 띄워 사용자 결정을 기다립니다 (Promise resolve):

| decision | 동작 |
|---|---|
| `'cancel'` | 자동 수정 전체 건너뜀. 결과는 lint-warn 상태로 표시 |
| `'fix-others-only'` | missing module 오류는 보존하고 나머지 오류만 LLM 자동 수정 |
| `'fix-all'` | 모든 오류를 LLM에 전달 (LLM이 module 추가도 시도 — 위험) |

**핵심 원칙:** LLM이 임의로 stub/fake module 을 추가하는 것은 동작 변경 위험이 크므로 자동 처리하지 않고 엔지니어 결정에 위임. `autoFixLint` 의 프롬프트에도 *"Do NOT add new module definitions or stub modules"* 가 명시되어 있어 `fix-all` 선택 시에도 LLM 이 보수적으로 동작하도록 유도합니다.

---

## 변환 프롬프트 핵심 규칙

변환 프롬프트(단일/순차/iteration) 모두 아래 규칙을 포함합니다:

```
- Preserve the original code EXACTLY — structure, indentation, whitespace,
  naming, and comments — unless a change point explicitly requires modification
- Do NOT refactor, reorganize, reorder, or rename anything not listed
- Do NOT remove or alter existing comments
- Do NOT change coding style or formatting of unmodified lines
- If a change is unavoidable in adjacent lines, keep it minimal and note in CHANGES
```

---

## CHANGES 포맷

```
SOURCE|TYPE|IDS|description

SOURCE: ALGO | UARCH | BOTH | ITER | LINT
TYPE:   ADD | MOD | REMOVE | FIX
IDS:    ALGO-001,ARCH-002  또는  NONE
```

파싱: `parseChangeLine(line)` → `{ source, type, ids[], desc, raw }`  
렌더링: `renderIdBadges(ids, clickable)` → ALGO(파란색), ARCH(보라색) 뱃지

---

## 의존성 그래프

```javascript
buildDepGraph()              // 파일 업로드 시 자동 실행
getAffectedFiles(files, 2)   // 2-hop BFS → { upstream, downstream }
buildDepGraphHint(targets)   // Phase 1 완료 후 변환 프롬프트용
buildDepGraphHintAll()       // Phase 1 미실행 시 전체 관계 요약
```

파서:
- `parseVerilogInstances()` — `ModuleName #(params) instName (ports);` 세미콜론 단위 분리
- `parseSystemCInstances()` — SC_MODULE 멤버 선언 + `.bind()` 패턴

---

## Lint 시스템

```javascript
lintFile(code, filename)              // POST /lint → { ok, errors[], warnings[], linter }
autoFixLint(f, lintResult, host, model, attempt)  // LLM 자동 수정
lintAndFix(f, host, model, stepId)   // 전체 흐름 (lint → 재시도 최대 2회)
```

`f.lintResult` 저장 후 Results 탭에 배지 + 오류 목록 표시.  
dev 서버 미연결 시 `note` 필드로 조용히 건너뜀 (기존 동작 무영향).

dev 서버 `/lint` 엔드포인트:
- RTL: `verible-verilog-syntax` → fallback `iverilog`
- SystemC: `clang++ --syntax-only`

---

## μArch 테이블 해석 규칙

μArch 내용을 LLM에 전달하는 모든 프롬프트에 `UARCH_TABLE_RULES` 상수가 포함됩니다.

적용 지점:
- `reAnalyzeImpact('uarch')` — diff 분석
- `_autoRunAnalyze('uarch')` — 일괄 실행 분석
- `runSummaryPhase2()` — μArch 섹션 매핑
- `buildContextSection()` — 변환 컨텍스트의 uarchRefSection

---

## ID 추적 시스템

```
ALGO-001, ARCH-003 등 ID가 전체 플로우에서 추적됨:

Diff AI 분석 → impact item에 ID 부여
    ↓
buildImpactText() → 프롬프트에 [ALGO-001] 포함
    ↓
LLM 변환 → // ALGO-001: 인라인 코멘트
         → CHANGES: ALGO|MOD|ALGO-001|설명
    ↓
parseChangeLine() → ids 배열 파싱
renderIdBadges(ids, clickable=true)
    ↓
클릭 → navigateToImpactId(id) → Diff 탭 이동 + 하이라이트
```

재분석 시 ID는 항상 001부터 새로 시작 (`existingIds = 'none'` 고정).

---

## 코드 수정 시 주의사항

1. **단일 HTML 정책 유지:** 외부 CDN 의존성 추가 금지 (폰트도 시스템 폰트 스택 사용). 새 외부 라이브러리는 `js/` 하위에 자체 호스팅
2. **모듈 분리 영역 존중:**
   - 출력 언어/시스템 프롬프트 변경 → `js/prompts.js` 수정
   - LLM 호출/로그 변경 → `js/llm-client.js` 수정
   - 서버 감지/long-poll/.env 로드 변경 → `js/server-connection.js` 수정
   - 분리 모듈은 글로벌 스코프 공유 — 새 의존 함수가 메인 HTML 에 정의되어 있는지 확인
3. **두 서버 동기화:** `rtl-dev-server.js`(Node.js)와 `rtl_server.py`(Python)는 동일한 엔드포인트 셋을 유지. 새 엔드포인트 추가 시 양쪽 모두 반영
4. **`_impactData` 선언 보존:** 코드 정리 시 실수로 삭제되지 않도록 주의  
   (`_impactSave`, `impactUndo`, `impactRedo`, `updateUndoRedoBtns`, `getImpactEl/Add/Input/Cnt` 함께 존재)
5. **`getLang()` 사용:** 언어별 분기는 하드코딩 대신 `getLang().fileDesc`, `getLang().expert` 등을 사용
6. **ID는 항상 001부터:** `reAnalyzeImpact`와 `_autoRunAnalyze`에서 `existingIds = 'none'` 유지
7. **정규식 이스케이프:** JS 정규식을 Python 스크립트로 삽입할 때 반드시 raw string `r"""..."""` 사용
8. **LLM 호출에 signal 연결:** 새 LLM 호출 추가 시 `_llmFreeze` + `signal` 파라미터 패턴 준수
9. **`_api_cmd_queue` 단일 인스턴스 가정:** Python 서버의 명령 큐는 in-memory deque이므로 uvicorn `--workers` 는 1로 유지 (Dockerfile/docker-compose 에 강제됨)
10. **SystemC 헤더 경로:** 하드코딩 금지. `.env` 의 `SYSTEMC_INCLUDE` (콜론 구분 다중 경로 지원) 우선 사용
11. **CHANGES 추적 일관성:** `parseChangeLine` 은 잘못된 라인을 거부하고 `valid=false` 반환. 새 변환 출력에서 ID 손실이 의심되면 `auditChangeTracking(code, changes)` 결과의 `inCodeOnly` / `inChangesOnly` 검토

---

## 개발 환경

- **OS:** Debian WSL2 (intranet)
- **개발용 런타임:** Node.js (rtl-dev-server.js, 포트 3000)
- **운영용 런타임:** Python 3.12 + FastAPI/uvicorn (Docker, 포트 8080)
- **브라우저:** Chrome / Edge (webkit)
- **LLM:** OpenAI Compatible 서버 (현재 Kimi-K2.5 256K context)
- **Git:** `Vegitime-bot/RTL_conv_IDE`

### 보안 주의

- Python 서버의 `make_client()`는 **`verify=False` 로 고정** — 사내망 전용 도구이므로 TLS 인증서 검증은 사용하지 않습니다. **외부 LLM 서버 연결 용도로 절대 사용 금지**
- `.env`의 `API_KEY`는 컨테이너에 마운트만 되고 이미지에 포함되지 않음 (docker-compose.yml의 `:ro` 마운트 참조)
