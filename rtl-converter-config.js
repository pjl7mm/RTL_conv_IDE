// ── RTL Converter 설정 파일 ───────────────────────────────
// 이 파일을 수정하여 동작을 튜닝하세요.
// dev 서버 실행 시 /config 엔드포인트로 자동 로드됩니다.
// dev 서버 없이 직접 열 때는 HTML 내 기본값이 사용됩니다.

const RTL_CONVERTER_CONFIG = {

  // ── μArch 청크 분할 설정 ─────────────────────────────────
  uarchChunk: {
    // 분할 전략: 'heading' | 'token' | 'both'
    //   heading : 마크다운 헤딩(#/##/###) 기준으로만 분할
    //   token   : 최대 토큰 크기 기준으로만 분할
    //   both    : 헤딩 분할 후 maxChunkTokens 초과 청크만 추가 토큰 분할
    strategy: 'both',

    // 헤딩 분할 기준 레벨 (1=# 만, 2=## 까지, 3=### 까지)
    activeHeadingLevel: 2,

    // 청크당 최대 토큰 수 (token/both 전략 사용 시)
    maxChunkTokens: 1500,

    // 청크 간 overlap 토큰 수 (문맥 연속성 유지)
    overlapTokens: 200,

    // 'both' 전략: 작은 청크를 다음 청크와 병합할지 여부
    bothMergeSmall: true,

    // 병합 기준 토큰 수 — 이 값 이하인 청크는 다음 청크와 병합
    bothMergeThreshold: 300,
  },

  // ── Phase 1: Target RTL 선정 ─────────────────────────────
  targetRtl: {
    // 제외된 파일을 참조용으로 포함할지 여부 (기본값, UI에서 변경 가능)
    includeExcludedAsRef: false,

    // 참조용 포함 시 시그니처만 전달 (전체 코드 대신)
    signatureOnly: true,
  },

  // ── Phase 2: μArch 섹션 매핑 ─────────────────────────────
  uarchMapping: {
    // 파일당 최대 관련 섹션 수
    maxSectionsPerFile: 5,
  },

  // ── 대형 컨텍스트 모델 목록 ──────────────────────────────
  // 이 목록에 포함된 모델은 예상 토큰이 128K 이상이어도
  // 경고/순차처리 전환 없이 단일 컨텍스트로 바로 실행합니다.
  // 모델명 비교는 대소문자 무시 + 부분 일치 (includes)로 판단합니다.
  largeCxtModels: [
    'Kimi-K2.5',    // Moonshot Kimi K2.5 — 256K context
  ],
};
