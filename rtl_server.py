"""
RTL Converter FastAPI Server
────────────────────────────
Node.js dev 서버와 동일한 기능을 FastAPI로 구현.
WSL + Docker 운영 환경 대응.

엔드포인트:
  GET  /            → rtl_algo_converter.html 서빙
  GET  /ping        → 헬스 체크
  GET  /env         → .env 로드 반환
  GET  /config      → rtl-converter-config.js 반환
  GET  /hooks       → rtl-converter-hooks.js 반환
  POST /save-log    → LLM 로그 저장
  POST /llm-proxy   → LLM 스트리밍 프록시
  GET  /get-proxy   → GET 프록시 (모델 목록 조회 등)
  POST /hook        → 완료 Hook URL 호출
  POST /lint        → Verilog/SystemC lint 실행
  POST /api/auto-run-analysis  → 분석 명령 큐 추가
  POST /api/auto-run-convert   → RTL 생성 명령 큐 추가
  POST /api/auto-run           → 전체 실행 명령 큐 추가
  GET  /api/poll    → 브라우저 폴링 (명령 큐 반환)
"""

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
from collections import deque
from pathlib import Path
from typing import Any, Optional

import httpx
from dotenv import dotenv_values
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ── 로깅 ─────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("rtl-server")

# ── 경로 설정 ─────────────────────────────────────────────────
BASE_DIR   = Path(__file__).parent

ENV_FILE   = BASE_DIR / ".env"
CONFIG_JS  = BASE_DIR / "rtl-converter-config.js"
HOOKS_JS   = BASE_DIR / "rtl-converter-hooks.js"
LOG_DIR    = BASE_DIR / "logs"
LOG_FILE   = LOG_DIR / "rtl_converter_llm_log.json"
HTML_FILE  = BASE_DIR / "rtl_algo_converter.html"

PORT = int(os.environ.get("PORT", os.environ.get("DEV_PORT", "8080")))

# ── FastAPI 앱 ───────────────────────────────────────────────
app = FastAPI(title="RTL Converter Server", version="1.0.0")

# CORS — 개발: 전체 허용 / 운영: 필요에 따라 origins 제한
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# ── API 명령 큐 (브라우저 폴링 방식) ─────────────────────────
_api_cmd_queue: deque = deque()

# ── .env 파서 ─────────────────────────────────────────────────
def load_env() -> dict:
    if not ENV_FILE.exists():
        return {}
    return {k: v for k, v in dotenv_values(ENV_FILE).items() if v is not None}


# ── HTTP 클라이언트 팩토리 ────────────────────────────────────
def make_client(**kwargs) -> httpx.AsyncClient:
    """
    httpx 비동기 클라이언트 생성.

    프록시 정책 — 명시적 opt-in 만 허용:
      .env 의 OUTBOUND_PROXY=http://proxy:port 가 설정된 경우에만 그 프록시 사용.
      미설정 시 직접 연결 (사내 인트라넷 LLM 서버는 프록시 경유 불필요).

    ※ trust_env / 시스템 프록시 자동 감지는 의도적으로 사용하지 않습니다.
       사내 환경에서 OS 가 외부망용 프록시를 광고하는 경우, 인트라넷 LLM 서버
       요청까지 그 프록시로 우회되어 407(Proxy Authentication Required) 발생.
       프록시가 정말 필요한 환경이라면 .env 에 OUTBOUND_PROXY 를 명시하세요.

    ⚠️  TLS 검증 — verify=False 로 고정.
    ────────────────────────────────────────────────────
    이 도구는 **사내 인트라넷 LLM 서버 전용**입니다.
    사내 환경의 자체 서명 인증서 / 사설 CA 가 다양해 일관된 검증이 어렵고,
    사내망 자체가 신뢰 경계로 동작하므로 TLS 인증서 검증은 사용하지 않습니다.
    이 동작은 의도적이며 변경 대상이 아닙니다.

    절대 다음 용도로 사용하지 마세요:
      - 공인 인터넷 LLM 서비스(OpenAI / Anthropic 등) 직접 연결
      - 프로덕션 외부 서비스 호출
      - 신뢰 경계 밖(외부망)으로 나가는 요청
    """
    proxy_url = load_env().get('OUTBOUND_PROXY')

    if proxy_url:
        log.info(f"[http] OUTBOUND_PROXY 사용: {proxy_url}")
        return httpx.AsyncClient(
            verify=False,            # 사내망 전용 — 고정 (위 docstring 참조)
            proxy=proxy_url,
            trust_env=False,         # 환경변수 프록시 자동 적용 차단
            follow_redirects=True,
            **kwargs,
        )

    return httpx.AsyncClient(
        verify=False,                # 사내망 전용 — 고정 (위 docstring 참조)
        trust_env=False,             # 시스템/환경변수 프록시 자동 감지 차단 (407 회귀 방지)
        follow_redirects=True,
        **kwargs,
    )


# ── 로그 저장 ─────────────────────────────────────────────────
def append_log(entry: dict) -> int:
    LOG_DIR.mkdir(exist_ok=True)
    logs = []
    if LOG_FILE.exists():
        try:
            logs = json.loads(LOG_FILE.read_text(encoding="utf-8"))
        except Exception:
            logs = []

    # REQUEST/RESPONSE 쌍 관리
    if entry.get("req_id") and entry.get("status") == "RESPONSE":
        for i, e in enumerate(logs):
            if e.get("req_id") == entry["req_id"]:
                logs[i] = {**e, **entry}
                LOG_FILE.write_text(json.dumps(logs, indent=2, ensure_ascii=False), encoding="utf-8")
                return len(logs)

    logs.append(entry)
    LOG_FILE.write_text(json.dumps(logs, indent=2, ensure_ascii=False), encoding="utf-8")
    return len(logs)

# ════════════════════════════════════════════════════════════
# 기본 엔드포인트
# ════════════════════════════════════════════════════════════

@app.get("/ping")
async def ping():
    return {"ok": True, "server": "rtl-fastapi-server"}


@app.get("/env")
async def get_env():
    env = load_env()
    return {
        "BASE_URL":      env.get("BASE_URL", ""),
        "API_KEY":       env.get("API_KEY", ""),
        "DEFAULT_MODEL": env.get("DEFAULT_MODEL", ""),
        "OLLAMA_MODE":   env.get("OLLAMA_MODE", "").lower() == "true",
        "loaded":        ENV_FILE.exists(),
        "path":          str(ENV_FILE),
    }


@app.get("/config")
async def get_config():
    if not CONFIG_JS.exists():
        raise HTTPException(404, "rtl-converter-config.js 없음")
    return Response(
        content=CONFIG_JS.read_text(encoding="utf-8"),
        media_type="application/javascript",
    )


@app.get("/hooks")
async def get_hooks():
    if not HOOKS_JS.exists():
        raise HTTPException(404, "rtl-converter-hooks.js 없음")
    return Response(
        content=HOOKS_JS.read_text(encoding="utf-8"),
        media_type="application/javascript",
    )


# ════════════════════════════════════════════════════════════
# 로그 저장
# ════════════════════════════════════════════════════════════

@app.post("/save-log")
async def save_log(request: Request):
    try:
        entry = await request.json()
    except Exception as e:
        raise HTTPException(400, f"JSON 파싱 실패: {e}")

    count = append_log(entry)

    tag  = ("→ REQ " if entry.get("status") == "REQUEST"
            else "← RES " if entry.get("status") == "RESPONSE"
            else "○ LOG ")
    info = (f"req_id:{entry['req_id']}  model:{entry.get('model','?')}  mode:{entry.get('mode','?')}"
            if entry.get("req_id")
            else f"model:{entry.get('model','?')}  mode:{entry.get('mode','?')}")
    log.info(f"[log] {tag} #{count}  {info}")

    if t := entry.get("timing"):
        log.info(f"       http:{t.get('http_ms')}ms  "
                 f"first_byte:{t.get('first_byte_ms')}ms  "
                 f"total:{t.get('total_ms')}ms")

    return {"ok": True, "count": count, "file": str(LOG_FILE)}


# ════════════════════════════════════════════════════════════
# LLM 프록시 (스트리밍 지원)
# ════════════════════════════════════════════════════════════

@app.post("/llm-proxy")
async def llm_proxy(request: Request):
    target_url = request.headers.get("x-target-url")
    if not target_url:
        raise HTTPException(400, "X-Target-URL 헤더 필요")

    body    = await request.body()
    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in ("host", "content-length", "x-target-url")
    }

    log.info(f"[proxy] POST → {target_url}")

    # 스트리밍 응답 여부 확인
    try:
        req_json = json.loads(body)
        is_stream = req_json.get("stream", False)
    except Exception:
        is_stream = False

    async def stream_response():
        async with make_client(timeout=None) as client:
            async with client.stream("POST", target_url,
                                     content=body, headers=headers) as resp:
                log.info(f"[proxy] ← HTTP {resp.status_code}")
                async for chunk in resp.aiter_bytes():
                    yield chunk

    if is_stream:
        return StreamingResponse(
            stream_response(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache",
                     "X-Accel-Buffering": "no"},
        )
    else:
        timeout_ns = httpx.Timeout(connect=5.0, read=60.0, write=10.0, pool=5.0)
        async with make_client(timeout=timeout_ns) as client:
            resp = await client.post(target_url, content=body, headers=headers)
            log.info(f"[proxy] ← HTTP {resp.status_code}")
            return Response(
                content=resp.content,
                status_code=resp.status_code,
                media_type=resp.headers.get("content-type", "application/json"),
            )


@app.get("/get-proxy")
async def get_proxy(request: Request):
    target_url = request.headers.get("x-target-url")
    if not target_url:
        raise HTTPException(400, "X-Target-URL 헤더 필요")

    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in ("host", "x-target-url")
    }

    log.info(f"[proxy] GET → {target_url}")
    try:
        # 브라우저 timeout(15s)보다 짧게 설정 → 브라우저가 먼저 끊기기 전에 에러 반환
        timeout = httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0)
        async with make_client(timeout=timeout) as client:
            resp = await client.get(target_url, headers=headers)
            log.info(f"[proxy] ← HTTP {resp.status_code}")
            return Response(
                content=resp.content,
                status_code=resp.status_code,
                media_type=resp.headers.get("content-type", "application/json"),
            )
    except httpx.ConnectTimeout:
        log.error(f"[proxy] 연결 timeout → {target_url}")
        return JSONResponse({"error": f"연결 timeout (5s): {target_url}"}, status_code=504)
    except httpx.ReadTimeout:
        log.error(f"[proxy] 읽기 timeout → {target_url}")
        return JSONResponse({"error": f"응답 timeout (10s): {target_url}"}, status_code=504)
    except httpx.ConnectError as e:
        log.error(f"[proxy] 연결 오류 → {target_url}: {e}")
        return JSONResponse({"error": f"연결 실패: {e}"}, status_code=502)
    except Exception as e:
        log.error(f"[proxy] 오류 → {target_url}: {e}")
        return JSONResponse({"error": str(e)}, status_code=502)


# ════════════════════════════════════════════════════════════
# Hook 호출
# ════════════════════════════════════════════════════════════

class HookRequest(BaseModel):
    name:        Optional[str] = None
    url:         str
    method:      str           = "GET"
    headers:     dict          = {}
    bodyPayload: Optional[Any] = None


@app.post("/hook")
async def call_hook(body: HookRequest):
    name = body.name or body.url
    log.info(f'[hook] "{name}" → {body.method} {body.url}')

    try:
        async with make_client(timeout=10) as client:
            if body.method.upper() == "GET":
                resp = await client.get(body.url, headers=body.headers)
            else:
                resp = await client.post(
                    body.url,
                    json=body.bodyPayload,
                    headers=body.headers,
                )
            ok = 200 <= resp.status_code < 300
            resp_text = resp.text[:500]
            log.info(f'[hook] "{name}" ← HTTP {resp.status_code}  {resp_text[:100]}')
            return {"ok": ok, "status": resp.status_code, "response": resp_text}
    except httpx.TimeoutException:
        log.error(f'[hook] "{name}" 타임아웃')
        return {"ok": False, "error": "timeout (10s)"}
    except Exception as e:
        log.error(f'[hook] "{name}" 오류: {e}')
        return {"ok": False, "error": str(e)}


# ════════════════════════════════════════════════════════════
# Lint (Verilog / SystemC)
# ════════════════════════════════════════════════════════════

class LintFile(BaseModel):
    name:    str
    content: str


class LintRequest(BaseModel):
    # 신규 다중 파일 모드 (권장) — files + target
    files:    Optional[list[LintFile]] = None
    target:   Optional[str]            = None   # 결과를 필터링할 파일 이름

    # 구버전 단일 파일 모드 (하위 호환)
    code:     Optional[str]            = None
    filename: Optional[str]            = "unnamed"

    lang:     str = "rtl"   # 'rtl' | 'systemc'


def _which(cmd: str) -> bool:
    return shutil.which(cmd) is not None


def _safe_name(name: str) -> str:
    """파일 이름에서 경로 구분자/상위 디렉토리 제거 (디렉토리 traversal 방지)"""
    return os.path.basename(name).replace("..", "_") or "unnamed"


@app.post("/lint")
async def lint_code(body: LintRequest):
    # === 입력 정규화 — files 모드와 code 모드 둘 다 지원 ===
    is_systemc = body.lang == "systemc"
    default_ext = ".cpp" if is_systemc else (
        ".sv" if (body.target or body.filename or "").endswith(".sv") else ".v"
    )

    if body.files:
        files = list(body.files)
        target_name = body.target or (files[0].name if files else "unnamed")
    elif body.code is not None:
        # 구버전 단일 파일
        files = [LintFile(name=body.filename or f"unnamed{default_ext}", content=body.code)]
        target_name = body.filename or files[0].name
    else:
        return {"ok": False, "errors": [{"line": 0, "col": 0, "msg": "files/code 누락"}],
                "warnings": [], "raw": "", "linter": ""}

    # 모든 파일을 임시 디렉토리에 풀고 lint 도구에 다중 파일로 전달
    tmpdir = tempfile.mkdtemp(prefix="rtl_lint_")
    try:
        all_paths: list[str] = []
        target_path: Optional[str] = None
        for f in files:
            safe_basename = _safe_name(f.name)
            # 확장자 보정 (없으면 기본값)
            if not os.path.splitext(safe_basename)[1]:
                safe_basename += default_ext
            p = os.path.join(tmpdir, safe_basename)
            with open(p, "w", encoding="utf-8") as fp:
                fp.write(f.content)
            all_paths.append(p)
            if f.name == target_name:
                target_path = p
        if target_path is None and all_paths:
            target_path = all_paths[0]
            target_name = os.path.basename(target_path)

        if is_systemc:
            if not _which("clang++"):
                return {"ok": True, "errors": [], "warnings": [],
                        "note": "clang++ 미설치 — lint 건너뜀"}
            linter = "clang++"
            # SystemC 헤더 경로: 환경변수 SYSTEMC_INCLUDE (콜론 구분 다중 경로 지원)
            # 미설정 시 표준 경로(/usr/include/systemc) 사용
            sysc_paths = (load_env().get("SYSTEMC_INCLUDE")
                          or os.environ.get("SYSTEMC_INCLUDE")
                          or "/usr/include/systemc")
            include_args = []
            for p in sysc_paths.split(":"):
                p = p.strip()
                if p:
                    include_args.extend(["-I", p])
            # SystemC: 임시 디렉토리도 -I 로 추가해서 다른 파일이 헤더로 동반 처리될 수 있게
            include_args.extend(["-I", tmpdir])
            # clang++ 은 단일 .cpp 컴파일 단위만 받으므로 target 만 주 입력으로,
            # 다른 파일은 include path 로만 노출 (헤더 의존성 해결).
            args = ["--syntax-only", "-std=c++17", *include_args, target_path]
        else:
            # Verilog/SystemVerilog: 다중 파일을 모두 인자로 넘김 (verible/iverilog 모두 지원)
            if _which("verible-verilog-syntax"):
                linter = "verible-verilog-syntax"
                args   = ["--error_on_unimplemented", *all_paths]
            elif _which("iverilog"):
                linter = "iverilog"
                args   = ["-t", "null", "-Wall", *all_paths]
            else:
                return {"ok": True, "errors": [], "warnings": [],
                        "note": "verible/iverilog 미설치 — lint 건너뜀"}

        result = await asyncio.to_thread(
            subprocess.run,
            [linter, *args],
            capture_output=True, text=True, timeout=30
        )
        output = (result.stderr or result.stdout or "").strip()
        log.info(f"[lint] {linter} files={len(all_paths)} target={target_name} exit={result.returncode}  {output[:120]}")

        # === 결과 파싱 — 타깃 파일 경로의 오류만 필터링 ===
        # 다른 파일의 오류는 사용자가 변환 안 한 파일이라 무관.
        errors, warnings = [], []
        target_basename = os.path.basename(target_path) if target_path else ""
        for m in re.finditer(
            r"^(.*?):(\d+):(?:(\d+):)?\s*(error|warning|note):\s*(.+)$",
            output, re.IGNORECASE | re.MULTILINE
        ):
            file_in_msg = os.path.basename(m.group(1).strip())
            # 타깃 파일에서 발생한 오류만 수집
            if file_in_msg != target_basename:
                continue
            item = {"line": int(m.group(2)),
                    "col":  int(m.group(3) or 0),
                    "msg":  m.group(5).strip()}
            (errors if m.group(4).lower() == "error" else warnings).append(item)

        return {"ok": len(errors) == 0,
                "errors": errors, "warnings": warnings,
                "raw": output, "linter": linter,
                "files_count": len(all_paths)}

    except subprocess.TimeoutExpired:
        return {"ok": False, "errors": [{"line": 0, "col": 0,
                "msg": "lint 타임아웃 (30s)"}], "warnings": [], "raw": "", "linter": ""}
    finally:
        try:
            shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass


# ════════════════════════════════════════════════════════════
# API 트리거 (브라우저 폴링 방식)
# ════════════════════════════════════════════════════════════

_ACTION_MAP = {
    "/api/auto-run-analysis": "auto-run-analysis",
    "/api/auto-run-convert":  "auto-run-convert",
    "/api/auto-run":          "auto-run-all",
}


@app.post("/api/auto-run-analysis")
async def api_analysis():
    _api_cmd_queue.append({"action": "auto-run-analysis", "ts": int(time.time() * 1000)})
    log.info("[api] auto-run-analysis 명령 큐 추가")
    return {"ok": True, "action": "auto-run-analysis", "queued": True,
            "note": "브라우저가 열려있고 dev 서버에 연결된 경우 자동 실행됩니다."}


@app.post("/api/auto-run-convert")
async def api_convert():
    _api_cmd_queue.append({"action": "auto-run-convert", "ts": int(time.time() * 1000)})
    log.info("[api] auto-run-convert 명령 큐 추가")
    return {"ok": True, "action": "auto-run-convert", "queued": True,
            "note": "브라우저가 열려있고 dev 서버에 연결된 경우 자동 실행됩니다."}


@app.post("/api/auto-run")
async def api_auto_run():
    _api_cmd_queue.append({"action": "auto-run-all", "ts": int(time.time() * 1000)})
    log.info("[api] auto-run-all 명령 큐 추가")
    return {"ok": True, "action": "auto-run-all", "queued": True,
            "note": "브라우저가 열려있고 dev 서버에 연결된 경우 자동 실행됩니다."}


@app.get("/api/poll")
async def api_poll(wait: float = 0.0):
    """
    명령 큐에서 명령을 꺼냄.

    - wait=0 (기본): 즉시 큐 확인 후 응답 (기존 동작 호환)
    - wait>0      : long-poll 모드. 큐가 비어있으면 wait 초까지 대기.
                    명령이 도착하면 즉시 응답, 시간 초과 시 command=null 반환.

    클라이언트는 wait=30 정도로 long-poll 후 응답 즉시 재연결하는 패턴 권장.
    이렇게 하면 3초 폴링 대비 명령 도착 즉시 처리되며 (<100ms 지연) HTTP 만 사용하므로
    인트라넷 프록시 호환성도 그대로 유지됩니다.
    """
    # 안전 상한: 60초 (브라우저/프록시 idle timeout 회피)
    wait = max(0.0, min(wait, 60.0))

    if wait > 0 and not _api_cmd_queue:
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            if _api_cmd_queue:
                break
            await asyncio.sleep(0.1)  # 100ms 폴링 간격

    cmd = _api_cmd_queue.popleft() if _api_cmd_queue else None
    return {"ok": True, "command": cmd}


# ════════════════════════════════════════════════════════════
# 정적 파일 서빙 (HTML + JS 설정 파일들)
# ════════════════════════════════════════════════════════════

@app.get("/")
async def serve_html():
    if not HTML_FILE.exists():
        raise HTTPException(404, "rtl_algo_converter.html 없음")
    return FileResponse(HTML_FILE, media_type="text/html")


@app.get("/{filename:path}")
async def serve_static(filename: str):
    filepath = BASE_DIR / filename
    if not filepath.exists() or not filepath.is_file():
        raise HTTPException(404, f"파일 없음: {filename}")
    # 경로 traversal 방지
    try:
        filepath.resolve().relative_to(BASE_DIR.resolve())
    except ValueError:
        raise HTTPException(403, "접근 불가")

    ext_map = {
        ".html": "text/html; charset=utf-8",
        ".js":   "application/javascript",
        ".css":  "text/css",
        ".json": "application/json",
        ".svg":  "image/svg+xml",
        ".md":   "text/markdown",
    }
    media_type = ext_map.get(filepath.suffix.lower(), "application/octet-stream")
    return FileResponse(filepath, media_type=media_type)


# ════════════════════════════════════════════════════════════
# 시작
# ════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import uvicorn

    env = load_env()
    log.info("=== RTL Converter FastAPI Server ===")
    log.info(f"  앱         : http://localhost:{PORT}")
    log.info(f"  환경설정   : http://localhost:{PORT}/env")
    log.info(f"  LLM 프록시 : POST http://localhost:{PORT}/llm-proxy")
    log.info(f"  Lint 검사  : POST http://localhost:{PORT}/lint")
    log.info(f"  Hook 실행  : POST http://localhost:{PORT}/hook")
    log.info(f"  .env 파일  : {ENV_FILE if ENV_FILE.exists() else '(없음)'}")
    log.info(f"  hooks 파일 : {HOOKS_JS if HOOKS_JS.exists() else '(없음 — rtl-converter-hooks.js 를 이 폴더에 복사하세요)'}")
    log.info("")
    log.info("  ⚠️  단일 워커 전용 — _api_cmd_queue 는 in-memory deque 이므로")
    log.info("       uvicorn --workers > 1 또는 다중 인스턴스 운영 시 명령 큐가 분산됨")
    log.info("")
    log.info("  [API 엔드포인트]")
    log.info(f"  분석 실행  : POST http://localhost:{PORT}/api/auto-run-analysis")
    log.info(f"  RTL 생성   : POST http://localhost:{PORT}/api/auto-run-convert")
    log.info(f"  전체 실행  : POST http://localhost:{PORT}/api/auto-run")
    log.info("")
    if env.get("BASE_URL"):
        log.info(f"  BASE_URL={env['BASE_URL']}  MODEL={env.get('DEFAULT_MODEL','(미설정)')}")

    uvicorn.run(
        "rtl_server:app",
        host="0.0.0.0",
        port=PORT,
        reload=False,
        log_level="info",
    )
