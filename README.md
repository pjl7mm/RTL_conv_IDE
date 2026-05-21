# RTL Converter IDE

Algorithm / μArch 문서 변경을 기반으로 Verilog/SystemVerilog 또는 SystemC(HLS) 코드를 자동 변환하는 단일 HTML 도구입니다.  
삼성 DS 인트라넷 환경에서 동작하며 OpenAI Compatible LLM 서버와 연동합니다.

---

## 파일 구성

```
rtl_algo_converter.html      메인 앱 (HTML + 인라인 JS)
js/                          분리된 JS 모듈
  prompts.js                   출력 언어 + UARCH_TABLE_RULES + LANG_CFG
  llm-client.js                callLLM + 로그 함수
  server-connection.js         서버 감지 + long-poll + .env 부트스트랩

rtl-dev-server.js            Node.js 개발 서버 (포트 3000) — 로컬 개발용
rtl_server.py                Python FastAPI 서버 (포트 8080) — 운영용
Dockerfile                   운영 이미지 빌드 (Python 서버)
docker-compose.yml           운영 배포 정의
requirements.txt             Python 의존성

rtl-converter-config.js      동작 튜닝 설정 파일 (양 서버 공유)
rtl-converter-hooks.js       Hook 정의 (선택, 양 서버 공유)
env.example                  .env 템플릿 (→ .env로 복사 후 작성)
```

> **서버는 두 개입니다.** 동일한 엔드포인트를 Node.js와 Python FastAPI가 각각 제공합니다. 로컬 개발은 Node.js, 운영 배포는 Docker(Python)를 사용하세요. 브라우저는 살아있는 쪽을 자동 감지합니다.

> **JS 모듈 분리:** 메인 HTML 의 inline `<script>` 블록을 기능 단위(시스템 프롬프트 / LLM 클라이언트 / 서버 통신)로 끊어서 `js/` 하위로 분리했습니다. 글로벌 스코프 공유는 그대로 (모듈 시스템 미사용 — 단순 script tag 분할). 동기 로드 순서로 원래 inline 코드와 동일하게 동작합니다.

---

## 빠른 시작

### A. 로컬 개발 (Node.js dev 서버)

#### 1. 환경 설정

```bash
cp env.example .env
```

`.env` 파일을 열어 LLM 서버 정보를 입력합니다:

```env
BASE_URL=http://your-llm-server/v1   # OpenAI Compatible 서버 주소
API_KEY=sk-...                        # API Key (없으면 빈칸)
DEFAULT_MODEL=your-model-name         # 기본 모델명
```

#### 2. dev 서버 실행

```bash
node rtl-dev-server.js
```

브라우저에서 `http://localhost:3000` 접속.

#### 3. 직접 열기 (dev 서버 없이)

`rtl_algo_converter.html`을 브라우저에서 직접 열어도 UI는 동작합니다.  
이 경우 `localhost:8080` 으로 fallback ping을 시도하므로, Docker 운영 서버가 떠 있으면 그쪽에 연결됩니다. 둘 다 없으면 `.env` 자동 로드, LLM 프록시(CORS 우회), 로그 저장, lint 검사는 사용 불가합니다.

---

### B. 운영 배포 (Docker / Python FastAPI)

#### 1. 환경 설정

```bash
cp env.example .env
# .env 편집
```

#### 2. Docker 실행

```bash
docker compose up -d
```

브라우저에서 `http://localhost:8080` 접속. (포트는 `docker-compose.yml`의 `PORT` 환경변수로 변경 가능)

#### 3. 외부 시스템에서 자동 변환 트리거 (선택)

운영 서버는 외부 자동화 시스템에서 변환을 트리거할 수 있는 명령 큐 API를 제공합니다.

```bash
# 분석만 실행
curl -X POST http://your-host:8080/api/auto-run-analysis

# RTL 변환만 실행
curl -X POST http://your-host:8080/api/auto-run-convert

# 분석 + 변환 전체 실행
curl -X POST http://your-host:8080/api/auto-run
```

브라우저가 열려있는 상태에서 3초 간격으로 `/api/poll` 폴링을 통해 명령을 받아 자동 실행합니다. CI/CD 또는 사내 자동화 시스템과 연동할 때 사용합니다.

> **주의:** 명령 큐는 서버 메모리(in-memory deque)에 저장되므로 서버 재시작 시 소실됩니다. uvicorn 워커는 반드시 1개로 유지하세요(docker-compose 기본 설정).

---

## 주요 기능

### 전체 변환 플로우 (7단계)

```
Step 1: RTL / SystemC 파일 업로드
Step 2: Algorithm 문서 등록 (AS-IS / TO-BE 매핑)
Step 3: Algo Diff → AI 분석 (ALGO-xxx ID 부여)
Step 4: μArch 문서 등록 (AS-IS / TO-BE 매핑)
Step 5: μArch Diff → AI 분석 (ARCH-xxx ID 부여)
Step 6: Summary (Target 파일 선정 + μArch 섹션 매핑)
Step 7: 변환 결과 (Results + Iteration)
```

### 일괄 실행 (`⚡ 일괄 실행` 버튼)

파일 등록 후 버튼 하나로 전체 흐름을 자동 실행합니다.

- Algo AI 분석 + μArch AI 분석을 **병렬** 실행
- 완료 후 Summary 분석 자동 수행
- 토큰 수 자동 계산 → 128K 초과 시 순차 처리 자동 전환

### 출력 언어 선택

Step 1에서 출력 언어를 선택합니다:

| 언어 | 입력 파일 | 특징 |
|---|---|---|
| Verilog / SystemVerilog | `.v`, `.sv` | RTL 레벨 변환 |
| SystemC (HLS) | `.cpp`, `.h`, `.hpp` | HLS 레벨 변환 |

### 변환 강도 슬라이더

cfg 바의 슬라이더로 LLM 파라미터를 조절합니다:

| 단계 | temperature | seed | 용도 |
|---|---|---|---|
| ① 정확 | 0 | 42 (고정) | 기본, 항상 동일한 결과 |
| ② 재시도 | 0.2 | 랜덤 | 결과가 아쉬울 때 |
| ③ 탐색 | 0.5 | 랜덤 | 완전히 다른 방법 시도 |

### 모듈 의존성 그래프 (2-hop)

파일 업로드 시 자동으로 모듈 간 인스턴스 연결 관계를 파싱합니다.  
Phase 1과 변환 프롬프트에 upstream/downstream 정보를 자동 주입하여 2-hop 이상의 포트 변경을 LLM이 인지하도록 합니다.

### Lint 검증 (생성 후 자동)

RTL/SystemC 변환 완료 후 dev 서버를 통해 자동으로 lint를 실행합니다.

- 오류 발견 시 LLM에 자동 재시도 (최대 2회)
- Results 탭에 `✓ lint` / `⚠ lint N개 오류` 배지 표시
- 우측 패널에 오류 목록과 라인 번호 표시

---

## Lint 도구 설치 (선택)

dev 서버가 실행 중일 때만 동작합니다. 미설치 시 lint 건너뜀.

### Verilog / SystemVerilog

```bash
# Debian / Ubuntu (WSL2)
# verible 권장
apt install verible

# 또는 iverilog (fallback)
apt install iverilog
```

verible이 없으면 iverilog로 자동 fallback됩니다.

### SystemC (HLS)

```bash
apt install clang
```

기본 헤더 경로는 `/usr/include/systemc`입니다. 사내 빌드 환경에서 SystemC가 다른 경로에 설치되어 있다면 `.env`에 `SYSTEMC_INCLUDE`를 설정하세요:

```env
# 단일 경로
SYSTEMC_INCLUDE=/opt/systemc/include

# 콜론 구분 다중 경로
SYSTEMC_INCLUDE=/opt/systemc/include:/usr/local/include/tlm
```

---

## 설정 파일 (`rtl-converter-config.js`)

dev 서버 실행 시 `/config` 엔드포인트로 자동 로드됩니다.  
직접 열기 시에는 HTML 내 기본값이 사용됩니다.

### 주요 설정 항목

```js
RTL_CONVERTER_CONFIG = {
  // μArch 문서 청크 분할 전략
  uarchChunk: {
    strategy: 'both',          // 'heading' | 'token' | 'both'
    activeHeadingLevel: 2,     // ## 까지 헤딩으로 분할
    maxChunkTokens: 1500,      // 청크당 최대 토큰
    overlapTokens: 200,        // 청크 간 overlap
    bothMergeSmall: true,      // 작은 청크 병합
    bothMergeThreshold: 300,   // 병합 기준 토큰 수
  },

  // Phase 1 Target 선정
  targetRtl: {
    includeExcludedAsRef: false,  // 제외 파일 참조용 포함 여부
    signatureOnly: true,           // 참조 포함 시 시그니처만 전달
  },

  // Phase 2 μArch 섹션 매핑
  uarchMapping: {
    maxSectionsPerFile: 5,  // 파일당 최대 관련 섹션 수
  },

  // 128K 초과에도 단일 컨텍스트로 실행할 모델 목록
  // 대소문자 무시 + 부분 일치로 비교
  largeCxtModels: [
    'Kimi-K2.5',   // Moonshot Kimi K2.5 — 256K context
  ],
};
```

---

## μArch 문서 테이블 포맷

μArch 문서에 테이블이 포함된 경우 아래 형식으로 인코딩하면 LLM이 정확히 해석합니다:

```
[TABLE 1 | SCHEMA]: 항목; 값; 비고
[TABLE 1 | ROW 1]: 항목=data_width; 값=64; 비고=ALU 출력 폭
[TABLE 1 | ROW 2]: 항목=pipeline_stage; 값=3; 비고=<SAME_AS_ABOVE>

<SAME_AS_ABOVE>  = 위 셀과 동일한 값
<SAME_AS_LEFT>   = 왼쪽 셀과 동일한 값
■, ●, ✔, ▶      = 선택/True
□, ○, △          = 미선택/False
```

---

## 서버 엔드포인트

Node.js dev 서버(`:3000`)와 Python FastAPI 서버(`:8080`) 모두 아래 엔드포인트를 제공합니다.

| 경로 | 메서드 | 설명 | Node | Python |
|---|---|---|:---:|:---:|
| `/ping` | GET | 서버 상태 확인 | ✓ | ✓ |
| `/env` | GET | `.env` 설정값 반환 | ✓ | ✓ |
| `/config` | GET | `rtl-converter-config.js` 반환 | ✓ | ✓ |
| `/hooks` | GET | `rtl-converter-hooks.js` 반환 |   | ✓ |
| `/llm-proxy` | POST | LLM 요청 프록시 (`X-Target-URL` 헤더 필요) | ✓ | ✓ |
| `/get-proxy` | GET | GET 요청 프록시 (모델 목록 조회 등) | ✓ | ✓ |
| `/save-log` | POST | LLM 대화 로그 저장 | ✓ | ✓ |
| `/lint` | POST | Verilog/SystemC lint 실행 | ✓ | ✓ |
| `/hook` | POST | 외부 Webhook 호출 (Slack 등) |   | ✓ |
| `/api/auto-run-analysis` | POST | 분석 명령 큐에 적재 |   | ✓ |
| `/api/auto-run-convert` | POST | 변환 명령 큐에 적재 |   | ✓ |
| `/api/auto-run` | POST | 전체 명령 큐에 적재 |   | ✓ |
| `/api/poll` | GET | 브라우저용 명령 큐 폴링 |   | ✓ |

> Hook 시스템과 명령 큐 API는 Python 서버 전용입니다. 운영 환경(Docker)에서만 사용 가능.

---

## Hook 시스템 (운영 서버 전용)

분석 완료 또는 변환 완료 시 외부 시스템에 알림을 보낼 수 있습니다. `rtl-converter-hooks.js` 파일을 작성하여 사용합니다.

```js
// rtl-converter-hooks.js
window.RTL_CONVERTER_HOOKS = {
  enabled: true,

  // 변환 완료 시 호출
  onComplete: {
    name: 'Slack 알림',
    url: 'https://hooks.slack.com/services/XXX/YYY/ZZZ',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    bodyPayload: {
      text: 'RTL 변환 완료: {fileCount}개 파일',  // {ctx} 치환 변수 지원
    },
  },

  // 분석 완료 시 호출 (선택)
  onAnalysisComplete: { /* ... */ },
};
```

`docker-compose.yml`에 `./rtl-converter-hooks.js:/app/rtl-converter-hooks.js:ro` 마운트가 이미 설정되어 있습니다.

---

## 보안 주의사항

- **TLS 검증 — `verify=False` 고정:** Python 서버의 `make_client()` 는 TLS 인증서 검증을 사용하지 않습니다. 사내망 자체가 신뢰 경계로 동작하고 자체 서명 인증서/사설 CA 가 다양해 일관된 검증이 어렵기 때문이며, 의도된 설정입니다. **공인 외부 LLM 서버에 직접 연결하는 용도로 사용하지 마세요.** 인트라넷 사내 LLM 전용입니다.
- **API Key 보호:** `.env`는 docker-compose에서 `:ro`(read-only) 마운트로 컨테이너에 전달됩니다. 이미지에는 포함되지 않습니다.
- **CORS:** 두 서버 모두 `Access-Control-Allow-Origin: *`로 동작합니다. 인트라넷 환경 가정이며, 외부 노출 시 nginx 프록시로 origin 제한을 추가하세요(docker-compose.yml의 nginx 섹션 참조).
- **명령 큐 인증 없음:** `/api/auto-run-*` 엔드포인트는 인증을 거치지 않습니다. 외부 노출 시 nginx에서 IP 제한 또는 Basic Auth를 추가하세요.

---

## 아웃바운드 프록시 정책

LLM 서버로 가는 요청은 **명시적 opt-in 방식**으로만 프록시를 사용합니다.

- 시스템 프록시 / `HTTP_PROXY` 환경변수는 **자동으로 적용되지 않습니다.** (사내 OS 가 외부망용 프록시를 광고하는 경우, 인트라넷 LLM 서버 요청까지 그 프록시로 우회되어 407 에러 발생하는 회귀 방지)
- 정말 프록시 경유가 필요하면 `.env` 의 `OUTBOUND_PROXY` 에 명시:

```env
OUTBOUND_PROXY=http://proxy.company.com:8080
# 인증 필요한 경우:
OUTBOUND_PROXY=http://user:pass@proxy.company.com:8080
```

### 트러블슈팅 — 407 Proxy Authentication Required

```
"HTTP/1.1 407 authenticationrequired"
INFO: GET /get-proxy HTTP/1.1 → 407
```

이 오류는 LLM 서버 요청이 의도치 않게 회사 외부망 프록시를 경유할 때 발생합니다. 진단 절차:

1. `.env` 의 `OUTBOUND_PROXY` 값을 확인 — 잘못된 프록시가 설정돼 있으면 비우세요.
2. 위 항목이 비어있는데도 407 이 나면 사내 환경이 시스템 프록시를 광고하고 있는 것입니다. 현재 버전은 자동 적용을 차단하지만, 만약 옛날 버전을 쓰고 있다면 최신 `rtl_server.py` 로 업데이트하세요.
3. 사내 LLM 서버는 보통 **프록시 경유 없이 직접 도달 가능**합니다. `BASE_URL` 도메인이 사내 DNS 로 해석되는지, 방화벽 룰이 직접 연결을 허용하는지 확인하세요.

---

## 주의 사항

- 일괄 실행 시 사용자 확인 없이 자동으로 변환됩니다. AI 분석 결과가 부정확하면 변환 결과도 부정확할 수 있습니다.
- 변환 결과는 사람이 검토 후 사용하는 것을 전제로 합니다.
- 인트라넷 환경에서는 외부 CDN 없이 동작하도록 설계되어 있습니다.
