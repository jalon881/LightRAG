# syntax=docker/dockerfile:1

# Frontend build stage
# Build frontend assets on the native build platform to avoid
# cross-architecture emulation issues during multi-platform builds.
FROM --platform=$BUILDPLATFORM oven/bun:1 AS frontend-builder

ARG USE_MIRROR=0
ARG BUN_MIRROR=https://registry.npmjs.org
ARG VITE_DISABLE_GUEST_MODE=true
ENV BUN_CONFIG_REGISTRY=$BUN_MIRROR

WORKDIR /app

# Copy frontend source code
COPY lightrag_webui/ ./lightrag_webui/

# Build frontend assets for inclusion in the API package
# Limit Node memory to avoid OOM on low-memory servers (1G-2G RAM)
ENV NODE_OPTIONS="--max-old-space-size=512"
RUN --mount=type=cache,target=/root/.bun/install/cache \
    cd lightrag_webui \
    && VITE_DISABLE_GUEST_MODE=$VITE_DISABLE_GUEST_MODE bun install --frozen-lockfile \
    && VITE_DISABLE_GUEST_MODE=$VITE_DISABLE_GUEST_MODE bun run build

# Python build stage - use python slim as base, install uv via pip.
# Avoids ghcr.io which has no Chinese mirror.
FROM python:3.12-slim-bookworm AS builder

# Mirror support: set ARGs for Chinese mirrors
ARG USE_MIRROR=0
ARG PYPI_MIRROR=https://pypi.org/simple
ARG SPACY_DOWNLOAD_MIRROR

ENV DEBIAN_FRONTEND=noninteractive
ENV UV_SYSTEM_PYTHON=1
ENV UV_COMPILE_BYTECODE=1
ENV PIP_INDEX_URL=$PYPI_MIRROR

WORKDIR /app

# Install system deps + uv + Rust (required by some wheels)
# Use Tsinghua mirrors for apt. Mount caches so repeated builds are instant.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    if [ "$USE_MIRROR" = "1" ]; then \
        sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        build-essential \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Install Rust via rustup with China mirror + cache
RUN --mount=type=cache,target=/root/.rustup \
    --mount=type=cache,target=/root/.cargo \
    if [ "$USE_MIRROR" = "1" ]; then \
        export RUSTUP_DIST_SERVER=https://mirrors.tuna.tsinghua.edu.cn/rustup; \
        export RUSTUP_UPDATE_ROOT=https://mirrors.tuna.tsinghua.edu.cn/rustup/rustup; \
    fi \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

ENV PATH="/root/.cargo/bin:/root/.local/bin:${PATH}"

RUN pip install --no-cache-dir uv

ENV UV_INDEX_URL=$PYPI_MIRROR

# Ensure shared data directory exists for uv caches
RUN mkdir -p /root/.local/share/uv

# Copy project metadata and sources
COPY pyproject.toml .
COPY setup.py .
COPY uv.lock .

# Install base, API, and offline extras without the project to improve caching
RUN --mount=type=cache,target=/root/.local/share/uv \
    uv sync --frozen --no-dev --extra api --extra offline --no-install-project --no-editable

# Copy project sources after dependency layer
COPY lightrag/ ./lightrag/

# Include pre-built frontend assets from the previous stage
COPY --from=frontend-builder /app/lightrag/api/webui ./lightrag/api/webui

# Sync project in non-editable mode and ensure pip is available for runtime installs
RUN --mount=type=cache,target=/root/.local/share/uv \
    uv sync --frozen --no-dev --extra api --extra offline --no-editable \
    && /app/.venv/bin/python -m ensurepip --upgrade

# Prepare offline cache directory, pre-populate tiktoken data, and download the
# pinned spaCy model wheels for the docx smart_heading engine parameter.
# Use uv run to execute commands from the virtual environment.
# Cache the spaCy downloads so repeated builds are instant.
RUN --mount=type=cache,target=/root/.cache/pip \
    mkdir -p /app/data/tiktoken \
    && SPACY_DOWNLOAD_MIRROR=$SPACY_DOWNLOAD_MIRROR PIP_INDEX_URL=$PYPI_MIRROR uv run lightrag-download-cache --cache-dir /app/data/tiktoken --spacy --spacy-dir /app/spacy_models || status=$?; \
    if [ -n "${status:-}" ] && [ "$status" -ne 0 ] && [ "$status" -ne 2 ]; then exit "$status"; fi

# Final stage
# Pin to bookworm: keeps Python 3.12 (venv compat with the builder stage) while
# avoiding Debian trixie's perl 5.40.x exposure (CVE-2026-12087, no patch yet),
# and aligns the final Debian release with the builder (also bookworm).
FROM python:3.12-slim-bookworm

WORKDIR /app

# Mirror support for final stage
ARG USE_MIRROR=0
ARG PYPI_MIRROR=https://pypi.org/simple
ENV PIP_INDEX_URL=$PYPI_MIRROR

# Install uv via pip (avoids ghcr.io dependency)
RUN pip install --no-cache-dir uv

ENV UV_SYSTEM_PYTHON=1
ENV UV_INDEX_URL=$PYPI_MIRROR

# Copy installed packages and application code
COPY --from=builder /root/.local /root/.local
COPY --from=builder /app/.venv /app/.venv
COPY --from=builder /app/lightrag ./lightrag
COPY pyproject.toml .
COPY setup.py .
COPY uv.lock .

# Ensure the installed scripts are on PATH
ENV PATH=/app/.venv/bin:/root/.local/bin:$PATH

# Install dependencies with uv sync (uses locked versions from uv.lock)
# and ensure pip is available for runtime installs. The pinned spaCy model
# wheels (docx smart_heading) MUST be installed after uv sync — sync is exact
# and would remove packages that are not in the lock. The bind mount exposes
# the wheels downloaded in the builder stage without adding an image layer.
RUN --mount=type=cache,target=/root/.local/share/uv \
    --mount=type=bind,from=builder,source=/app/spacy_models,target=/tmp/spacy_models \
    uv sync --frozen --no-dev --extra api --extra offline --no-editable \
    && /app/.venv/bin/python -m ensurepip --upgrade \
    && /app/.venv/bin/python -m pip install --no-index --no-cache-dir \
        --find-links=/tmp/spacy_models zh_core_web_sm en_core_web_sm

# Create persistent data directories AFTER package installation
RUN mkdir -p /app/data/rag_storage /app/data/inputs /app/data/prompts /app/data/tiktoken

# Copy offline cache into the newly created directory
COPY --from=builder /app/data/tiktoken /app/data/tiktoken

# Point to the prepared cache
ENV TIKTOKEN_CACHE_DIR=/app/data/tiktoken
ENV WORKING_DIR=/app/data/rag_storage
ENV INPUT_DIR=/app/data/inputs
ENV PROMPT_DIR=/app/data/prompts

# Create a non-root user (CIS Docker 4.1) and install gosu for privilege drop.
# Fixed UID/GID 1000 gives predictable ownership for bind-mounts / PVCs.
# chown -R /app MUST run after every data COPY above so the venv (pipmaster
# installs packages at runtime), data dirs, and the tiktoken cache are writable.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1000 lightrag \
    && useradd -u 1000 -g lightrag -m -d /home/lightrag -s /usr/sbin/nologin lightrag \
    && chown -R lightrag:lightrag /app /home/lightrag

# HOME and cache dirs for the non-root user so pipmaster's runtime pip installs
# never fall back to an unwritable /root or a missing HOME.
ENV HOME=/home/lightrag \
    XDG_CACHE_HOME=/home/lightrag/.cache \
    PIP_CACHE_DIR=/home/lightrag/.cache/pip \
    UV_CACHE_DIR=/home/lightrag/.cache/uv

# Entrypoint starts as root, fixes mount ownership, then drops to lightrag.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose API port
EXPOSE 9621

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["python", "-m", "lightrag.api.lightrag_server"]
