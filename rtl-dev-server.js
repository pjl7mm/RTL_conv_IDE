#!/usr/bin/env node
'use strict';
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = 3000;
const HTML = 'rtl_algo_converter.html';
const LOG  = path.resolve(__dirname, 'rtl_converter_llm_log.json');
const ENV  = path.resolve(__dirname, '.env');

// ── .env 파서 ─────────────────────────────────────────────
function parseEnv(filepath) {
  const result = {};
  if (!fs.existsSync(filepath)) return result;
  fs.readFileSync(filepath, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = val;
  });
  return result;
}

let envVars = parseEnv(ENV);
console.log('[env] 로드:', Object.keys(envVars).filter(k => k !== 'API_KEY').join(', '),
  envVars.API_KEY ? '+ API_KEY(****)' : '(API_KEY 없음)');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Target-URL');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const buf = [];
    req.on('data', c => buf.push(c));
    req.on('end',  () => resolve(Buffer.concat(buf)));
    req.on('error', reject);
  });
}

function appendLog(entry) {
  let arr = [];
  try { if (fs.existsSync(LOG)) arr = JSON.parse(fs.readFileSync(LOG, 'utf8')); } catch {}

  // REQUEST/RESPONSE 쌍 관리: req_id 기준으로 업데이트 또는 추가
  if (entry.req_id && entry.status === 'RESPONSE') {
    const idx = arr.findIndex(e => e.req_id === entry.req_id);
    if (idx >= 0) {
      arr[idx] = { ...arr[idx], ...entry };  // REQUEST 항목을 RESPONSE로 업데이트
      fs.writeFileSync(LOG, JSON.stringify(arr, null, 2), 'utf8');
      return arr.length;
    }
  }
  arr.push(entry);
  fs.writeFileSync(LOG, JSON.stringify(arr, null, 2), 'utf8');
  return arr.length;
}

// ── 공통 프록시 함수 (GET/POST 모두 처리, 리다이렉트 자동 추적) ──
function doProxy(method, targetUrl, reqHeaders, body, res) {
  let parsed;
  try { parsed = new URL(targetUrl); } catch(e) {
    res.writeHead(400); res.end('URL 파싱 실패: ' + e.message); return;
  }

  console.log(`[proxy] ${method} → ${targetUrl}`);

  const isHttps  = parsed.protocol === 'https:';
  const mod      = isHttps ? https : http;
  const outHdrs  = { 'Accept': 'application/json' };
  if (reqHeaders['authorization']) outHdrs['Authorization'] = reqHeaders['authorization'];
  if (method === 'POST' && body) {
    outHdrs['Content-Type']   = 'application/json';
    outHdrs['Content-Length'] = Buffer.byteLength(body);
  }

  const options = {
    hostname: parsed.hostname,
    port:     parsed.port ? parseInt(parsed.port) : (isHttps ? 443 : 80),
    path:     parsed.pathname + (parsed.search || ''),
    method,
    headers:  outHdrs,
  };

  const proxyReq = mod.request(options, proxyRes => {
    const code = proxyRes.statusCode;
    console.log(`[proxy] ← HTTP ${code}`);

    // 리다이렉트 자동 추적 (301/302/307/308)
    if ([301, 302, 307, 308].includes(code) && proxyRes.headers['location']) {
      const redirectUrl = proxyRes.headers['location'];
      console.log(`[proxy] redirect → ${redirectUrl}`);
      proxyRes.resume();
      doProxy(method, redirectUrl, reqHeaders, body, res);
      return;
    }

    const outHeaders = { 'Access-Control-Allow-Origin': '*' };
    if (proxyRes.headers['content-type'])     outHeaders['Content-Type']     = proxyRes.headers['content-type'];
    if (proxyRes.headers['transfer-encoding']) outHeaders['Transfer-Encoding'] = proxyRes.headers['transfer-encoding'];

    res.writeHead(code, outHeaders);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', e => {
    console.error('[proxy] 오류:', e.message);
    if (!res.headersSent) { res.writeHead(502, {'Content-Type':'application/json'}); res.end(JSON.stringify({error: e.message})); }
  });

  if (method === 'POST' && body) proxyReq.write(body);
  proxyReq.end();
}

// ── HTTP 서버 ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  // 감지용 ping
  if (pathname === '/ping') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ok: true, server: 'rtl-dev-server'}));
    return;
  }

  // .env 값 반환 (API_KEY는 존재 여부만, 값은 마스킹)
  if (pathname === '/env') {
    // 요청 시마다 파일을 다시 읽음 (핫 리로드)
    envVars = parseEnv(ENV);
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({
      BASE_URL:      envVars.BASE_URL      || '',
      API_KEY:       envVars.API_KEY       || '',
      DEFAULT_MODEL: envVars.DEFAULT_MODEL || '',
      OLLAMA_MODE:   envVars.OLLAMA_MODE === 'true',  // Ollama 개발 테스트용
      loaded:        fs.existsSync(ENV),
      path:          ENV,
    }));
    return;
  }

  // config 파일 반환
  if (pathname === '/config') {
    const configPath = path.join(__dirname, 'rtl-converter-config.js');
    if (!fs.existsSync(configPath)) {
      res.writeHead(404, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: 'rtl-converter-config.js 없음'}));
      return;
    }
    // JS 파일을 텍스트로 그대로 반환 (브라우저에서 eval)
    res.writeHead(200, {'Content-Type': 'application/javascript'});
    fs.createReadStream(configPath).pipe(res);
    return;
  }


  // ── /lint: verible(RTL) 또는 clangd(SystemC) 로 문법/포트 검사 ──
  // 두 가지 입력 모드 지원:
  //   1) files: [{name, content}, ...] + target  (권장 — 의존성 파일 동반)
  //   2) code + filename                          (구버전 단일 파일 — 하위 호환)
  if (req.method === 'POST' && pathname === '/lint') {
    const { execFile, execSync } = require('child_process');
    const os   = require('os');
    const body = JSON.parse((await readBody(req)).toString('utf8'));
    const { files, target, code, filename, lang } = body;

    function which(cmd) {
      try { execSync(`which ${cmd}`, {stdio:'ignore'}); return true; } catch { return false; }
    }
    function safeName(name) {
      // 디렉토리 traversal 방지
      const base = (name || '').split(/[\\/]/).pop() || 'unnamed';
      return base.replace(/\.\./g, '_');
    }

    // === 입력 정규화 — files 모드와 code 모드 둘 다 지원 ===
    const isSC = lang === 'systemc';
    const defaultExt = isSC ? '.cpp'
      : ((target||filename||'').endsWith('.sv') ? '.sv' : '.v');

    let inputFiles, targetName;
    if (Array.isArray(files) && files.length > 0) {
      inputFiles = files;
      targetName = target || files[0].name;
    } else if (typeof code === 'string') {
      inputFiles = [{ name: filename || `unnamed${defaultExt}`, content: code }];
      targetName = filename || inputFiles[0].name;
    } else {
      res.writeHead(400, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:false, errors:[{line:0,col:0,msg:'files/code 누락'}], warnings:[]}));
      return;
    }

    // 임시 디렉토리에 모든 파일 풀기
    const tmpDir = path.join(os.tmpdir(), `rtl_lint_${Date.now()}_${Math.random().toString(36).slice(2,8)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const cleanup = () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    };

    const allPaths = [];
    let targetPath = null;
    for (const f of inputFiles) {
      let base = safeName(f.name);
      if (!path.extname(base)) base += defaultExt;
      const p = path.join(tmpDir, base);
      fs.writeFileSync(p, f.content || '', 'utf8');
      allPaths.push(p);
      if (f.name === targetName) targetPath = p;
    }
    if (!targetPath && allPaths.length) {
      targetPath = allPaths[0];
      targetName = path.basename(targetPath);
    }

    let linter, args;
    if (isSC) {
      if (which('clang++')) {
        linter = 'clang++';
        const sysc_paths = (envVars.SYSTEMC_INCLUDE || process.env.SYSTEMC_INCLUDE
                            || '/usr/include/systemc');
        const includeArgs = [];
        sysc_paths.split(':').forEach(p => {
          const t = p.trim();
          if (t) includeArgs.push('-I', t);
        });
        // 임시 디렉토리도 -I 로 추가 (다른 파일이 헤더로 동반 처리)
        includeArgs.push('-I', tmpDir);
        // clang++ 은 단일 .cpp 컴파일 단위만 받으므로 target 만 주 입력
        args = ['--syntax-only', '-std=c++17', ...includeArgs, targetPath];
      } else {
        cleanup();
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true, errors: [], warnings: [],
          note: 'clang++ 미설치 — lint 건너뜀' }));
        return;
      }
    } else {
      // Verilog/SV: 다중 파일 모두 인자로 (verible/iverilog 모두 지원)
      if (which('verible-verilog-syntax')) {
        linter = 'verible-verilog-syntax';
        args   = ['--error_on_unimplemented', ...allPaths];
      } else if (which('iverilog')) {
        linter = 'iverilog';
        args   = ['-t', 'null', '-Wall', ...allPaths];
      } else {
        cleanup();
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true, errors: [], warnings: [],
          note: 'verible/iverilog 미설치 — lint 건너뜀' }));
        return;
      }
    }

    execFile(linter, args, { timeout: 30000 }, (err, stdout, stderr) => {
      const output = (stderr || stdout || '').trim();
      console.log(`[lint] ${linter} files=${allPaths.length} target=${targetName} exit=${err?.code ?? 0} output=${output.slice(0,120)}`);
      cleanup();

      // === 결과 파싱 — 타깃 파일 경로의 오류만 필터링 ===
      const errors   = [];
      const warnings = [];
      const targetBasename = path.basename(targetPath);
      const lineRe = /^(.*?):(\d+):(?:(\d+):)?\s*(error|warning|note):\s*(.+)$/gim;
      let m;
      while ((m = lineRe.exec(output)) !== null) {
        const fileInMsg = path.basename((m[1]||'').trim());
        if (fileInMsg !== targetBasename) continue;  // 다른 파일 오류는 무시
        const item = {
          line: parseInt(m[2]),
          col:  parseInt(m[3]||'0'),
          msg:  m[5].trim(),
        };
        if (m[4].toLowerCase() === 'error') errors.push(item);
        else if (m[4].toLowerCase() === 'warning') warnings.push(item);
      }

      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({
        ok:           errors.length === 0,
        errors,
        warnings,
        raw:          output,
        linter,
        files_count:  allPaths.length,
      }));
    });
    return;
  }

  // 로그 저장
  if (req.method === 'POST' && pathname === '/save-log') {
    try {
      const entry = JSON.parse((await readBody(req)).toString('utf8'));
      const count = appendLog(entry);
      const tag   = entry.status === 'REQUEST'  ? '→ REQ ' :
                    entry.status === 'RESPONSE' ? '← RES ' : '○ LOG ';
      const info  = entry.req_id
        ? `req_id:${entry.req_id}  model:${entry.model||'?'}  mode:${entry.mode||'?'}`
        : `model:${entry.model||'?'}  mode:${entry.mode||'?'}`;
      console.log(`[log] ${tag} #${count}  ${info}`);
      if (entry.timing) {
        console.log(`       http:${entry.timing.http_ms}ms  first_byte:${entry.timing.first_byte_ms}ms  total:${entry.timing.total_ms}ms`);
      }
      res.writeHead(200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ok: true, count, file: LOG}));
    } catch(e) {
      res.writeHead(400, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({ok: false, error: e.message}));
    }
    return;
  }

  // POST 프록시 (LLM 변환 요청)
  if (req.method === 'POST' && pathname === '/llm-proxy') {
    const targetUrl = req.headers['x-target-url'];
    if (!targetUrl) { res.writeHead(400); res.end('X-Target-URL 헤더 필요'); return; }
    const body = await readBody(req);
    doProxy('POST', targetUrl, req.headers, body, res);
    return;
  }

  // GET 프록시 (연결 테스트 /models 등)
  if (req.method === 'GET' && pathname === '/get-proxy') {
    const targetUrl = req.headers['x-target-url'];
    if (!targetUrl) { res.writeHead(400); res.end('X-Target-URL 헤더 필요'); return; }
    doProxy('GET', targetUrl, req.headers, null, res);
    return;
  }

  // 정적 파일 서빙
  const MIME = {'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
  const filename = pathname === '/' ? HTML : pathname.slice(1);
  const filepath = path.join(__dirname, filename);
  if (!fs.existsSync(filepath)) { res.writeHead(404); res.end('Not found: ' + filename); return; }
  res.writeHead(200, {'Content-Type': MIME[path.extname(filepath)] || 'application/octet-stream'});
  fs.createReadStream(filepath).pipe(res);
});

server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `포트 ${PORT} 이미 사용 중` : e.message); process.exit(1); });
server.listen(PORT, () => {
  console.log('');
  console.log('=== RTL Converter Dev Server ===');
  console.log(`  앱         : http://localhost:${PORT}`);
  console.log(`  환경설정   : http://localhost:${PORT}/env  (.env 파일 읽기)`);
  console.log(`  POST 프록시: http://localhost:${PORT}/llm-proxy  (X-Target-URL 헤더)`);
  console.log(`  Lint 검사  : http://localhost:${PORT}/lint  (verible/iverilog/clang++ 필요)`);
  console.log(`  GET  프록시: http://localhost:${PORT}/get-proxy   (X-Target-URL 헤더)`);
  console.log(`  로그파일   : ${LOG}`);
  console.log(`  .env 파일  : ${fs.existsSync(ENV) ? ENV : '(없음 — .env 생성 권장)'}`);
  console.log('  Ctrl+C 종료');
  console.log('');
});
process.on('SIGINT',  () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
