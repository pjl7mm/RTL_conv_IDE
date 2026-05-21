// ── prompts.js ──────────────────────────────────────────
// 시스템 프롬프트 / 언어 설정 / μArch 테이블 해석 규칙
// 메인 HTML 의 inline <script> 에서 분리된 모듈.
// 글로벌 스코프 공유 (script 태그 분리만 하고 모듈 시스템 미사용).
//
// 정의: _outputLang, UARCH_TABLE_RULES, LANG_CFG, getLang(), setOutputLang()
// 외부 의존: renderRtl, updateCtxEstimate, dbgLog (메인 HTML 정의)
// ────────────────────────────────────────────────────────

// ── 출력 언어 설정 ────────────────────────────────────────
let _outputLang = 'rtl';  // 'rtl' | 'systemc'

// ── μArch 문서 테이블 해석 규칙 ─────────────────────────
// μArch 내용을 LLM에 전달할 때 항상 앞에 포함
const UARCH_TABLE_RULES = `[μArch Document Interpretation Rules]
The following μArch content may contain plain text and/or encoded table data.

Table encoding format:
  [TABLE n | SCHEMA]: column names of table n
  [TABLE n | ROW k]: row k of table n, encoded as column=value pairs separated by semicolons

Rules for interpreting tables:
- Treat tables as the PRIMARY source of factual information over plain text.
- For questions involving conditions, numbers, criteria, periods, comparisons, or lists — check table rows first.
- Each row is a complete, independent record.
- Merged cells have already been expanded into individual rows.
- Restore these markers before interpreting:
    <SAME_AS_ABOVE> = same value as the cell above in the same column
    <SAME_AS_LEFT>  = same value as the cell to the left in the same row
- If multiple rows match a query, consider ALL relevant rows.
- Do not guess missing or unclear values.
- For multiple-choice / checkbox items:
    A filled/checked/emphasized mark (■ ● ✔ ▶) means SELECTED / TRUE.
    An empty/unemphasized mark (□ ○ △) means UNSELECTED / FALSE.
    Judge by mark state only, not by shape.
`;



// ── μArch 원문 compaction ─────────────────────────────
// uArch 전문을 변환 컨텍스트에 넣을 때, RTL 분석/설계와 무관한 섹션을
// 헤딩 기반 휴리스틱으로 제거해서 토큰 절약.
//
// 제거 대상 (헤딩 패턴 — 대소문자 무시):
//   목차, Table of Contents, TOC, Contents
//   Changelog, Change log, 변경이력, Revision History, Document History, 개정이력
//   References, 참조, 참고문헌, Bibliography
//   Glossary, 용어집, Acronyms, Abbreviations, 약어집
//   Index, 색인
//   Appendix(만약 RTL 무관 부속자료처럼 보이면), 부록
//   Cover, 표지, Document Information, 문서정보
//   Author/작성자/검토자/승인 등 메타 섹션
//
// 원칙:
//   - 헤딩 라인(`#`/`##`/`###` 또는 `[Section ...]` 같은 인코딩) 기반으로만 제거
//     본문의 단어 우연 매칭은 절대 제거 안 함
//   - 한 섹션 = 헤딩 라인 + 다음 헤딩 직전까지의 본문
//   - RTL 코드/설계 관련 키워드(register, signal, port, clock, datapath, FSM 등)가 본문에
//     포함되면 그 섹션은 제거하지 않음 (false positive 방어)
// 무조건 제거 — 헤딩 자체가 명백히 메타성 (RTL 본문 가능성 거의 없음)
// 사용자 의도: "RTL 분석/설계와 무관한 내용 제거" — 메타 섹션은 본문 키워드와 무관하게 제거
const _UARCH_DROP_STRICT = [
  // 참조/색인
  /^references?$/i,
  /^참고\s*문헌$/i,
  /^참조(\s*문서)?$/i,
  /^bibliography$/i,
  /^index$/i,
  /^색인$/i,
  // 표지/문서정보/메타
  /^cover$/i,
  /^표지$/i,
  /^document\s+information$/i,
  /^문서\s*정보$/i,
  /^author(s)?$/i,
  /^작성(자|일)?$/i,
  /^검토(자|일)?$/i,
  /^승인(자|일)?$/i,
  /^배포\s*(이력|대상)?$/i,
  /^distribution$/i,
  /^approval$/i,
  // 목차/이력
  /^목\s*차$/i,
  /^table\s+of\s+contents$/i,
  /^contents$/i,
  /^toc$/i,
  /^change\s*log$/i,
  /^changelog$/i,
  /^변경\s*이력$/i,
  /^개정\s*이력$/i,
  /^revision\s+history$/i,
  /^document\s+history$/i,
  // 용어/약어 (정의 자체는 본문에 흩어진 정의만으로 충분 — 별도 섹션 불필요)
  /^glossary$/i,
  /^용어\s*(집|정의)?$/i,
  /^acronyms?$/i,
  /^abbreviations?$/i,
  /^약어\s*(집|표|정의)?$/i,
];

// soft 패턴: 본문에 RTL 키워드 있으면 보존.
// 현재는 비어있음 — 위 strict 패턴이 명백한 메타만 잡으므로 soft 보호 필요한 케이스 없음.
// 새 패턴 추가 시 false positive 위험이 있는 경우만 soft 로 (예: "Configuration", "Interface" 같은
// 모호한 헤딩 — 현재 _UARCH_DROP_PATTERNS 에 들어있지 않음).
const _UARCH_DROP_SOFT = [];

// 본문에 RTL 설계 관련 키워드가 있으면 섹션 보존 — false positive 방어용
// (예: '용어집' 헤딩이지만 그 안에 신호 정의가 들어있는 케이스)
const _UARCH_PRESERVE_KEYWORDS = /\b(register|signal|port|clock|reset|fsm|state\s*machine|datapath|pipeline|interface|protocol|bus|memory|fifo|ram|rom|cache|axi|apb|ahb|valid|ready|handshake|bit\s*width|word\s*width|address\s*map|sfr|csr|encoding|opcode|threshold|latency|throughput|bandwidth|timing)\b/i;

// 헤딩 라인 인식: markdown(#/##/...), 번호+제목(1. xxx / 1.2 xxx), [TABLE n | ...] 인코딩 마커
function _isUarchHeadingLine(line) {
  if (/^\s*#{1,6}\s+\S/.test(line)) return true;        // markdown 헤딩
  if (/^\s*\[(TABLE|SECTION|FIGURE)\s+\d/i.test(line)) return false;  // 표/섹션 인코딩 — 헤딩 아님
  // "1. 제목" / "1.2 제목" / "1.2.3 제목" — 줄 전체가 짧고 숫자.제목 패턴
  if (/^\s*\d+(\.\d+)*\.?\s+\S.{0,80}$/.test(line.trim())) return true;
  return false;
}

function _extractHeadingText(line) {
  // # / ## 등의 마크다운 마커와 번호 제거하고 제목 텍스트만
  return line
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*\d+(\.\d+)*\.?\s+/, '')
    .trim();
}

// uArch 원문에서 RTL 무관 섹션을 휴리스틱으로 제거.
// 반환: { text: 정제된 본문, dropped: [{title, lines, tokens}], origTokens, newTokens }
function compactUarchForRtl(rawText) {
  if (!rawText) return { text: '', dropped: [], origTokens: 0, newTokens: 0 };

  const origLines = rawText.split('\n');
  const origTokens = Math.ceil(rawText.length / 3.5);

  // 헤딩 인덱스 수집
  const headings = [];
  for (let i = 0; i < origLines.length; i++) {
    if (_isUarchHeadingLine(origLines[i])) {
      headings.push({ idx: i, title: _extractHeadingText(origLines[i]) });
    }
  }

  // 섹션화: heading[i].idx ~ heading[i+1].idx-1
  // 헤딩 이전의 본문이 있다면 그것은 무조건 보존 (서두/요약 가능성)
  const keep = new Array(origLines.length).fill(true);
  const dropped = [];

  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].idx;
    const end   = i + 1 < headings.length ? headings[i+1].idx : origLines.length;
    const title = headings[i].title;

    // 1단계: strict 패턴 매칭 — 본문 무관하게 제거
    const matchStrict = _UARCH_DROP_STRICT.some(re => re.test(title));
    if (matchStrict) {
      const sectionBody = origLines.slice(start + 1, end).join('\n');
      for (let j = start; j < end; j++) keep[j] = false;
      dropped.push({
        title,
        lines: end - start,
        tokens: Math.ceil(sectionBody.length / 3.5),
      });
      continue;
    }

    // 2단계: soft 패턴 매칭 — 본문에 RTL 키워드가 있으면 보존 (false positive 방어)
    const matchSoft = _UARCH_DROP_SOFT.some(re => re.test(title));
    if (!matchSoft) continue;

    const sectionBody = origLines.slice(start + 1, end).join('\n');
    if (_UARCH_PRESERVE_KEYWORDS.test(sectionBody)) continue;

    for (let j = start; j < end; j++) keep[j] = false;
    dropped.push({
      title,
      lines: end - start,
      tokens: Math.ceil(sectionBody.length / 3.5),
    });
  }

  const newText   = origLines.filter((_, i) => keep[i]).join('\n');
  const newTokens = Math.ceil(newText.length / 3.5);

  return { text: newText, dropped, origTokens, newTokens };
}


const LANG_CFG = {
  rtl: {
    label:        'Verilog / SystemVerilog',
    badge:        'Verilog / SystemVerilog',
    fileAccept:   '.v,.sv,.verilog',
    fileExts:     /\.(v|sv|verilog)$/i,
    dzHint:       '.v / .sv',
    modeHint:     '— .v / .sv 파일 · RTL 레벨 변환',
    expert:       'You are an expert RTL (Verilog/SystemVerilog) engineer.',
    iterExpert:   'You are an expert RTL (Verilog/SystemVerilog) engineer.',
    impactExpert: 'You are an expert RTL (Verilog/SystemVerilog) engineer.',
    commentStyle: '// ALGO: / // UARCH: / // BOTH:',
    commentIter:  '// ITER:',
    fileDesc:     'RTL',
    sampleFile:   'filename.v',
    construct:    'signal/port/always block/parameter',
    noFileHint:   'RTL 파일 없음 — Step 1에서 추가하세요',
    sigLabel:     '=== Module signature:',
    extractSig:   'verilog',
  },
  systemc: {
    label:        'SystemC (HLS)',
    badge:        'SystemC / HLS',
    fileAccept:   '.cpp,.h,.hpp,.cc',
    fileExts:     /\.(cpp|h|hpp|cc)$/i,
    dzHint:       '.cpp / .h / .hpp',
    modeHint:     '— .cpp / .h / .hpp 파일 · HLS/SystemC 레벨 변환',
    expert:       'You are an expert SystemC/HLS (High-Level Synthesis) engineer.',
    iterExpert:   'You are an expert SystemC/HLS engineer.',
    impactExpert: 'You are an expert SystemC/HLS engineer familiar with Verilog RTL concepts.',
    commentStyle: '// ALGO: / // UARCH: / // BOTH:',
    commentIter:  '// ITER:',
    fileDesc:     'SystemC',
    sampleFile:   'filename.cpp',
    construct:    'SC_MODULE/port/signal/process/channel/HLS pragma',
    noFileHint:   'SystemC 파일 없음 — Step 1에서 추가하세요',
    sigLabel:     '=== SC_MODULE signature:',
    extractSig:   'systemc',
  },
};

function getLang() { return LANG_CFG[_outputLang] || LANG_CFG.rtl; }

function setOutputLang(lang) {
  _outputLang = lang;
  const cfg = getLang();

  // 헤더 badge
  const badge = document.getElementById('langBadge');
  if (badge) badge.textContent = cfg.badge;

  // 파일 업로드 input accept
  const rtlIn = document.getElementById('rtlIn');
  if (rtlIn) rtlIn.accept = cfg.fileAccept;

  // DZ 힌트
  const dzHint = document.getElementById('dzFileHint');
  if (dzHint) dzHint.textContent = cfg.dzHint;

  // 모드 힌트
  const modeHint = document.getElementById('langModeHint');
  if (modeHint) modeHint.textContent = cfg.modeHint;

  // 파일 확장자 필터 업데이트 → 기존 파일 목록 클리어 안 함 (언어 전환 시 파일 유지)
  // Diff 패널 헤더 동적 갱신
  ['algoPanelHdr','uarchPanelHdr'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = `${cfg.fileDesc} 관련 변경점`;
  });
  document.querySelectorAll('.langFileDesc').forEach(el => {
    el.textContent = cfg.fileDesc;
  });

  // Step 1 stepbar 버튼 텍스트 업데이트
  const s0 = document.getElementById('s0');
  if (s0) s0.querySelector('.sn').nextSibling ? null : null; // 구조 유지

  renderRtl();
  updateCtxEstimate();
  dbgLog('INF', `[lang] 출력 언어 전환: ${cfg.label}`, 'inf');
}
