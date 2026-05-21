FROM python:3.12-slim

# ── 시스템 의존성 (lint 도구 선택 설치) ──────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    iverilog \
    clang \
    curl \
    && rm -rf /var/lib/apt/lists/*

# verible 설치 (선택 — 없으면 iverilog fallback 사용)
# ARG VERIBLE_VERSION=v0.0-3899-g29e3d261
# RUN curl -L "https://github.com/chipsalliance/verible/releases/download/${VERIBLE_VERSION}/verible-${VERIBLE_VERSION}-linux-static-x86_64.tar.gz" \
#     | tar -xz -C /usr/local/bin --strip-components=2 --wildcards "*/bin/verible-verilog-syntax"

WORKDIR /app

# ── Python 의존성 ────────────────────────────────────────────
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── 앱 파일 복사 ─────────────────────────────────────────────
COPY rtl_server.py              .
COPY rtl_algo_converter.html    .
COPY rtl-converter-config.js    .
COPY js/                        ./js/

# rtl-converter-hooks.js 는 선택 파일 — 없으면 hook 미사용
# rtl-converter-hooks.js — 없어도 서버 실행 가능
RUN touch /app/rtl-converter-hooks.js.placeholder

# .env 는 런타임에 마운트 (이미지에 포함하지 않음)
# docker run -v $(pwd)/.env:/app/.env ...

# ── 포트 ─────────────────────────────────────────────────────
ENV PORT=8080
EXPOSE 8080

# ── 실행 ─────────────────────────────────────────────────────
# CRITICAL: --workers 1 필수
# rtl_server.py 의 _api_cmd_queue 는 in-memory deque 이므로 multi-worker 환경에서
# 외부 자동화(/api/auto-run-*) 명령이 어느 워커로 갈지 불확정해집니다.
# 운영 환경에서 여러 인스턴스가 필요하면 nginx upstream 으로 전체 서버 단위 분산하세요.
CMD ["python", "-m", "uvicorn", "rtl_server:app",\
     "--host", "0.0.0.0", "--port", "8080",\
     "--workers", "1",\
     "--log-level", "info"]
