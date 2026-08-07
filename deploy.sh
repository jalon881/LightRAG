#!/usr/bin/env bash
# =============================================================================
# LightRAG Docker 生产部署脚本
#
# 用法： ./deploy.sh [动作] [选项...]
#   动作: up(默认) | down | logs | restart | pull | status
#   选项: --compose docker-compose.yml        (默认，纯 LightRAG)
#         --compose docker-compose-full.yml   (含 PG/Neo4j/Milvus/VLLM)
#
# ===== 快速上手 =====
#   # 首次部署（拉取官方镜像）
#   cp env.example .env && vi .env            # 编辑 LLM / 嵌入模型配置
#   ./deploy.sh pull                          # 拉取最新镜像
#   ./deploy.sh up                            # 启动服务
#
#   # 自己构建镜像
#   ./deploy.sh up --build                    # 本地构建并启动
#
#   # 全栈部署（PG + Neo4j + Milvus + VLLM，需要 GPU）
#   ./deploy.sh up --compose docker-compose-full.yml
#
#   # 日常运维
#   ./deploy.sh logs                          # 查看日志
#   ./deploy.sh restart                       # 重启
#   ./deploy.sh status                        # 查看状态
#   ./deploy.sh down                          # 停止
# =============================================================================

set -euo pipefail

# ==================== 全局配置 ====================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# PROJECT_DIR 默认为脚本所在目录，可通过环境变量覆盖
PROJECT_DIR="${LIGHTRAG_PROJECT_DIR:-$SCRIPT_DIR}"
COMPOSE_FILE="docker-compose.yml"
LIGHTRAG_PORT="${LIGHTRAG_PORT:-9621}"
BUILD_MODE=false
MIRROR_MODE=false

# Git 拉取配置
GIT_REPO="${LIGHTRAG_GIT_REPO:-git@github.com:jalon881/LightRAG.git}"
GIT_BRANCH="${LIGHTRAG_GIT_BRANCH:-jalon}"
GIT_MODE=false

# .env 文件备份（git 拉取前自动备份，拉取后自动恢复）
DOTENV_BACKUP=""

# ==================== 工具函数 ====================

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log()   { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()   { echo -e "${RED}[ERROR]${NC} $1"; }
header(){ echo ""; echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; echo -e "${BLUE}  $1${NC}"; echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; echo ""; }

show_usage() {
    echo "用法: $0 [动作] [选项...]"
    echo ""
    echo "动作:"
    echo "  up              启动服务 (默认)"
    echo "  down            停止并移除容器"
    echo "  logs            查看服务日志 (Ctrl+C 退出)"
    echo "  restart         重启服务"
    echo "  pull            拉取最新 Docker 镜像"
    echo "  status          查看服务运行状态"
    echo ""
    echo "选项:"
    echo "  --git           从 Git 拉取源码后构建启动"
    echo "  --repo URL      Git 仓库地址"
    echo "  --branch NAME   Git 分支名"
    echo "  --build         本地构建镜像 (而非拉取镜像)"
    echo "  --compose FILE  指定 compose 文件 (默认: docker-compose.yml)"
    echo "  --help, -h      显示此帮助"
    echo ""
    echo "环境变量:"
    echo "  LIGHTRAG_PROJECT_DIR   项目部署目录 (默认: 脚本所在目录)"
    echo "  LIGHTRAG_PORT          HTTP 端口 (默认: 9621)"
    echo "  LIGHTRAG_GIT_REPO      Git 仓库地址"
    echo "  LIGHTRAG_GIT_BRANCH    Git 分支"
    echo ""
    echo "示例:"
    echo "  # 从 Git 拉取 jalon 分支 → 构建镜像 → 启动"
    echo "  $0 up --git"
    echo ""
    echo "  # 部署到指定目录"
    echo "  LIGHTRAG_PROJECT_DIR=/opt/lightrag $0 up --git"
    echo ""
    echo "  # 本地已有代码，只构建启动"
    echo "  $0 up --build"
    echo ""
    echo "  # 拉取官方镜像启动"
    echo "  $0 pull && $0 up"
    echo ""
    echo "  # 日常运维"
    echo "  $0 logs && $0 restart && $0 status && $0 down"
}

# ==================== 参数解析 ====================

parse_args() {
    ACTION="up"

    while [ $# -gt 0 ]; do
        case "$1" in
            --help|-h)
                show_usage; exit 0 ;;
            --compose)
                shift; [ $# -eq 0 ] && { err "--compose 需要一个文件路径"; exit 1; }
                COMPOSE_FILE="$1"; shift ;;
            --build)
                BUILD_MODE=true; shift ;;
            --mirror)
                MIRROR_MODE=true; shift ;;
            --git)
                GIT_MODE=true; shift ;;
            --repo)
                shift; [ $# -eq 0 ] && { err "--repo 需要 Git 仓库地址"; exit 1; }
                GIT_REPO="$1"; shift ;;
            --branch)
                shift; [ $# -eq 0 ] && { err "--branch 需要分支名"; exit 1; }
                GIT_BRANCH="$1"; shift ;;
            up|down|logs|restart|pull|status)
                ACTION="$1"; shift ;;
            *)
                err "无效参数: $1 (用 --help 查看用法)"; exit 1 ;;
        esac
    done

    # Normalize compose file path
    [[ "$COMPOSE_FILE" != /* ]] && COMPOSE_FILE="$PROJECT_DIR/$COMPOSE_FILE"
    if [ ! -f "$COMPOSE_FILE" ]; then
        err "Compose 文件不存在: $COMPOSE_FILE"
        exit 1
    fi
}

# ==================== 环境检查 ====================

check_deps() {
    log "检查运行环境..."

    # Docker
    if ! command -v docker >/dev/null 2>&1; then
        err "未安装 Docker。安装指引: https://docs.docker.com/engine/install/"
        exit 1
    fi
    if ! docker info >/dev/null 2>&1; then
        err "Docker 守护进程未运行或当前用户无权限。"
        err "  启动: sudo systemctl start docker"
        err "  权限: sudo usermod -aG docker \$USER && newgrp docker"
        exit 1
    fi
    log "  ✓ docker $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',')"

    # Docker Compose
    if docker compose version >/dev/null 2>&1; then
        COMPOSE_CMD="docker compose"
    elif command -v docker-compose >/dev/null 2>&1; then
        COMPOSE_CMD="docker-compose"
    else
        err "未安装 docker compose。安装指引: https://docs.docker.com/compose/install/"
        exit 1
    fi
    log "  ✓ docker compose"

    # Git (only required in --git mode)
    if [ "$GIT_MODE" = true ]; then
        if ! command -v git >/dev/null 2>&1; then
            err "未安装 git（--git 模式需要）。安装: apt install git / yum install git"
            exit 1
        fi
        log "  ✓ git $(git --version 2>/dev/null | awk '{print $3}')"

        # Pre-flight SSH check
        log "  检查 GitHub SSH 连接..."
        if ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=5 -T git@github.com 2>&1 | grep -q "successfully authenticated"; then
            log "  ✓ GitHub SSH 认证成功"
        else
            warn "  无法通过 SSH 连接 GitHub，请确保 SSH Key 已配置:"
            warn "    ssh-keygen -t ed25519 -C \"your@email.com\""
            warn "    cat ~/.ssh/id_ed25519.pub  # 添加到 https://github.com/settings/keys"
            warn "    ssh -T git@github.com       # 测试连接"
            warn "  脚本将继续运行，但 git clone/pull 可能会失败"
        fi
    fi

    # .env — MUST be at $PROJECT_DIR/.env (e.g. /opt/lightrag/.env)
    if [ -f "$PROJECT_DIR/.env" ]; then
        log "  ✓ .env 已就绪 ($PROJECT_DIR/.env)"
    else
        err "  .env 不存在: $PROJECT_DIR/.env"
        err "  请先创建并编辑 .env: cp env.example .env && vi .env"
        exit 1
    fi
}

# ==================== Git 拉取 ====================

update_code_from_git() {
    log "从 Git 拉取源码..."
    log "  Repo:   $GIT_REPO"
    log "  Branch: $GIT_BRANCH"

    # 备份 .env（拉取后自动恢复）
    DOTENV_BACKUP=""
    if [ -f "$PROJECT_DIR/.env" ]; then
        DOTENV_BACKUP="$(mktemp /tmp/lightrag-dotenv-backup.XXXXXX)"
        cp "$PROJECT_DIR/.env" "$DOTENV_BACKUP"
        log "  📦 .env 已备份到: $DOTENV_BACKUP"
    fi

    if [ -d "$PROJECT_DIR/.git" ]; then
        # ── 已有 Git 仓库 ──
        log "  📂 更新已有仓库..."

        local current_remote
        current_remote=$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null || echo "")
        if [ "$current_remote" != "$GIT_REPO" ] && [ -n "$current_remote" ]; then
            warn "  remote 不匹配 ($current_remote → $GIT_REPO)，正在更新..."
            git -C "$PROJECT_DIR" remote set-url origin "$GIT_REPO"
        fi

        # 暂存本地未提交改动
        if ! git -C "$PROJECT_DIR" diff --quiet 2>/dev/null || \
           ! git -C "$PROJECT_DIR" diff --cached --quiet 2>/dev/null; then
            log "  📦 暂存本地改动到 stash..."
            git -C "$PROJECT_DIR" stash push --include-untracked \
                -m "deploy.sh auto stash $(date '+%Y-%m-%d %H:%M')" 2>/dev/null || true
        fi

        # 拉取远程
        git -C "$PROJECT_DIR" fetch origin --prune --tags || {
            err "无法连接远程仓库。请检查网络和 SSH Key: ssh -T git@github.com"
            exit 1
        }

        # 检查目标分支是否存在
        if ! git -C "$PROJECT_DIR" rev-parse --verify "origin/${GIT_BRANCH}" >/dev/null 2>&1; then
            err "远程分支 origin/${GIT_BRANCH} 不存在"
            err "  可用分支: $(git -C "$PROJECT_DIR" branch -r | head -10)"
            exit 1
        fi

        git -C "$PROJECT_DIR" checkout "$GIT_BRANCH" 2>/dev/null || \
            git -C "$PROJECT_DIR" checkout -b "$GIT_BRANCH" "origin/${GIT_BRANCH}"
        git -C "$PROJECT_DIR" reset --hard "origin/${GIT_BRANCH}"
        log "  ✓ 已切换到: $GIT_BRANCH ($(git -C "$PROJECT_DIR" rev-parse --short HEAD))"

    else
        # ── 首次克隆 ──
        log "  📥 首次克隆..."

        # 如果目标目录有内容，克隆到临时目录再搬移
        if [ -d "$PROJECT_DIR" ] && [ "$(ls -A "$PROJECT_DIR" 2>/dev/null | head -1)" ]; then
            local tmp_clone
            tmp_clone=$(mktemp -d /tmp/lightrag-clone.XXXXXX)
            log "  📥 克隆到临时目录: $tmp_clone"

            git clone -b "$GIT_BRANCH" --single-branch "$GIT_REPO" "$tmp_clone" || {
                err "克隆失败。请检查: 1) SSH Key 已配置  2) 仓库地址和分支正确"
                err "  ssh -T git@github.com"
                rm -rf "$tmp_clone"
                exit 1
            }

            # 搬移：保留原始目录作为备份，把 clone 内容搬进来
            local bak="$PROJECT_DIR.bak.$(date '+%Y%m%d_%H%M%S')"
            log "  📦 旧目录备份到: $bak"
            mv "$PROJECT_DIR" "$bak"

            # 搬移 clone 内容 + 恢复 .env 和数据目录
            mv "$tmp_clone" "$PROJECT_DIR"
            if [ -d "$bak/data" ]; then
                log "  📦 恢复数据目录..."
                cp -rn "$bak/data" "$PROJECT_DIR/" 2>/dev/null || true
            fi
            # 恢复备份的 .env
            if [ -f "$bak/.env" ] && [ ! -f "$PROJECT_DIR/.env" ]; then
                cp "$bak/.env" "$PROJECT_DIR/.env"
                log "  📄 已恢复 .env"
            fi
            log "  ✓ 克隆完成"
        else
            mkdir -p "$PROJECT_DIR"
            git clone -b "$GIT_BRANCH" --single-branch "$GIT_REPO" "$PROJECT_DIR" || {
                err "克隆失败。请检查 SSH Key 和仓库地址:"
                err "  ssh -T git@github.com"
                rmdir "$PROJECT_DIR" 2>/dev/null || true
                exit 1
            }
            log "  ✓ 克隆完成"
        fi
    fi

    # 确保 .env 存在（优先恢复备份，否则从 env.example 创建）
    if [ -n "$DOTENV_BACKUP" ] && [ -f "$DOTENV_BACKUP" ]; then
        cp "$DOTENV_BACKUP" "$PROJECT_DIR/.env"
        rm -f "$DOTENV_BACKUP"
        log "  ✓ .env 已恢复"
    elif [ ! -f "$PROJECT_DIR/.env" ] && [ -f "$PROJECT_DIR/env.example" ]; then
        cp "$PROJECT_DIR/env.example" "$PROJECT_DIR/.env"
        warn "  .env 从 env.example 创建，请修改 LLM API Key:"
        warn "    vi $PROJECT_DIR/.env"
    fi

    # 确保 docker-compose.yml 存在
    if [ ! -f "$COMPOSE_FILE" ]; then
        warn "  $COMPOSE_FILE 不存在，尝试 docker-compose.yml"
        COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"
    fi
}

# ==================== 数据目录 ====================

prepare_dirs() {
    log "准备数据目录..."

    mkdir -p "$PROJECT_DIR/data/rag_storage"
    mkdir -p "$PROJECT_DIR/data/inputs"
    mkdir -p "$PROJECT_DIR/data/prompts"

    log "  ✓ 数据目录已就绪"
}

# ==================== 前端预构建 ====================
# 在服务器主机上构建前端，避免 Docker 内 Vite build OOM

build_frontend_if_needed() {
    local webui_dir="$PROJECT_DIR/lightrag_webui"
    local output_dir="$PROJECT_DIR/lightrag/api/webui"

    if [ -f "$output_dir/index.html" ]; then
        log "  ✓ 前端已有预构建产物，跳过"
        return 0
    fi

    log "  前端未预构建，尝试在主机上构建..."

    # Ensure a JS runtime is available
    if ! command -v bun >/dev/null 2>&1 && ! command -v npm >/dev/null 2>&1; then
        log "  主机上未安装 bun/npm，尝试安装 bun..."
        if command -v npm >/dev/null 2>&1; then
            npm install -g bun --registry=https://registry.npmmirror.com
        elif command -v curl >/dev/null 2>&1; then
            curl -fsSL https://bun.sh/install | bash
            export PATH="$HOME/.bun/bin:$PATH"
        fi
    fi

    if command -v bun >/dev/null 2>&1; then
        log "  使用 bun 构建前端..."
        cd "$webui_dir"
        bun install && bun run build
        cd "$PROJECT_DIR"
        if [ -f "$output_dir/index.html" ]; then
            log "  ✓ 前端构建完成 (bun)"
            return 0
        fi
        warn "  bun 构建失败，尝试 Docker 内构建"
    fi

    if command -v npm >/dev/null 2>&1; then
        log "  使用 npm 构建前端..."
        cd "$webui_dir"
        npm install && npx vite build
        cd "$PROJECT_DIR"
        if [ -f "$output_dir/index.html" ]; then
            log "  ✓ 前端构建完成 (npm)"
            return 0
        fi
    fi

    warn "  主机上构建前端失败，将在 Docker 内构建（可能需要较多内存）"
    return 0
}

# ==================== spaCy 模型预下载 ====================
# 在主机上下载 spaCy 模型 wheel，避免 Docker 内慢速 GitHub 下载。
# 下载一次后 Dockerfile 的 _download_cache.py 检测到已存在就跳过。

SPACY_MODELS=(
    "https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"
    "https://github.com/explosion/spacy-models/releases/download/zh_core_web_sm-3.8.0/zh_core_web_sm-3.8.0-py3-none-any.whl"
)

download_spacy_models_if_needed() {
    local dest="$PROJECT_DIR/spacy_wheels"
    mkdir -p "$dest"

    local all_cached=true
    for url in "${SPACY_MODELS[@]}"; do
        local fname="${url##*/}"
        if [ ! -f "$dest/$fname" ]; then
            all_cached=false
            break
        fi
    done

    if $all_cached; then
        log "  ✓ spaCy 模型已预下载，跳过"
        return 0
    fi

    log "  预下载 spaCy 模型到主机（避免 Docker 内慢速下载）..."
    for url in "${SPACY_MODELS[@]}"; do
        local fname="${url##*/}"
        if [ -f "$dest/$fname" ]; then
            # Validate: minimum wheel size is ~10MB; anything smaller is truncated
            local fsize
            fsize=$(stat -c%s "$dest/$fname" 2>/dev/null || stat -f%z "$dest/$fname" 2>/dev/null || echo 0)
            if [ "$fsize" -gt 10000000 ]; then
                log "    ✓ $fname 已存在 ($((fsize / 1024 / 1024))MB)"
                continue
            else
                log "    ⚠ $fname 文件不完整 (${fsize} bytes)，重新下载"
                rm -f "$dest/$fname"
            fi
        fi
        log "    ⏳ 下载 $fname ..."
        # Try wget with resume support first, fall back to curl
        wget -c -q --show-progress --timeout=600 -O "$dest/$fname" "$url" 2>/dev/null \
            || curl -fSL --connect-timeout 30 --max-time 600 -o "$dest/$fname" "$url" \
            || { warn "    ✗ $fname 下载失败"; }
    done

    # Download spacy-pkuseg via pip (PyPI mirror, fast)
    local pkuseg_file=$(ls "$dest"/spacy_pkuseg-*.whl 2>/dev/null | head -1)
    if [ -z "$pkuseg_file" ]; then
        log "    ⏳ 下载 spacy-pkuseg ..."
        pip download --no-deps --timeout 60 --dest "$dest" spacy-pkuseg==1.0.1 \
            -i https://pypi.tuna.tsinghua.edu.cn/simple 2>/dev/null \
            || pip download --no-deps --timeout 60 --dest "$dest" spacy-pkuseg==1.0.1 2>/dev/null \
            || warn "    ✗ spacy-pkuseg 下载失败"
    fi

    log "  ✓ spaCy 模型预下载完成"
}

# ==================== 核心操作 ====================

do_pull() {
    log "拉取最新镜像..."
    cd "$PROJECT_DIR"
    $COMPOSE_CMD -f "$COMPOSE_FILE" pull
    log "拉取完成"
}

do_up() {
    log "启动 LightRAG 服务..."
    cd "$PROJECT_DIR"

    # Build args for Chinese mirrors
    local build_args=""
    if [ "$MIRROR_MODE" = true ]; then
        log "  镜像加速: 使用国内镜像源"
        export BUN_CONFIG_REGISTRY="https://registry.npmmirror.com"
        export UV_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"
        export PIP_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"
        export UV_PYPI_URL="https://pypi.tuna.tsinghua.edu.cn/simple"
        build_args="--build-arg USE_MIRROR=1 --build-arg BUN_MIRROR=https://registry.npmmirror.com --build-arg PYPI_MIRROR=https://pypi.tuna.tsinghua.edu.cn/simple"
    fi

    if [ "$BUILD_MODE" = true ]; then
        log "  模式: 本地构建 + 启动"
        $COMPOSE_CMD -f "$COMPOSE_FILE" build --progress=plain $build_args
        $COMPOSE_CMD -f "$COMPOSE_FILE" up -d
    else
        log "  模式: 使用已有镜像启动"
        $COMPOSE_CMD -f "$COMPOSE_FILE" up -d
    fi

    log ""
    log "等待服务就绪..."
    local max_wait=30
    local waited=0
    local healthy=0

    while [ $waited -lt $max_wait ]; do
        if curl -s -o /dev/null -w "%{http_code}" "http://localhost:${LIGHTRAG_PORT}/health" 2>/dev/null | grep -q "200"; then
            healthy=1
            break
        fi
        sleep 1
        waited=$((waited + 1))
    done

    if [ "$healthy" -eq 1 ]; then
        log "✓ 服务已启动 (耗时 ${waited}s)"
    else
        warn "服务可能仍在启动中，可以运行 ./deploy.sh logs 查看日志"
    fi

    show_access_info
}

do_down() {
    log "停止 LightRAG 服务..."
    cd "$PROJECT_DIR"
    $COMPOSE_CMD -f "$COMPOSE_FILE" down
    log "已停止"
}

do_logs() {
    cd "$PROJECT_DIR"
    $COMPOSE_CMD -f "$COMPOSE_FILE" logs -f
}

do_restart() {
    log "重启 LightRAG 服务..."
    cd "$PROJECT_DIR"
    $COMPOSE_CMD -f "$COMPOSE_FILE" restart
    log "已重启"
}

do_status() {
    cd "$PROJECT_DIR"
    echo ""
    $COMPOSE_CMD -f "$COMPOSE_FILE" ps
    echo ""

    # Quick health check
    local status_code
    status_code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${LIGHTRAG_PORT}/health" 2>/dev/null || echo "000")
    if [ "$status_code" = "200" ]; then
        log "健康检查: ✓ HTTP $status_code"
    else
        warn "健康检查: ✗ HTTP $status_code (服务可能未启动或正在初始化)"
    fi
}

cleanup_images() {
    local count
    count=$(docker images -f "dangling=true" -q 2>/dev/null | wc -l | tr -d ' ')
    if [ "$count" -gt 0 ] 2>/dev/null; then
        log "清理 $count 个悬空镜像..."
        docker images -f "dangling=true" -q 2>/dev/null | xargs -r docker rmi -f 2>/dev/null && log "  ✓ 清理完成" || true
    fi
}

show_access_info() {
    local ip
    # Try public IP first, fall back to private IP, then localhost
    ip=$(curl -sf --connect-timeout 3 https://ifconfig.me 2>/dev/null \
        || curl -sf --connect-timeout 3 https://api.ipify.org 2>/dev/null \
        || curl -sf --connect-timeout 3 https://icanhazip.com 2>/dev/null)
    [ -z "$ip" ] && ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    [ -z "$ip" ] && ip="localhost"

    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  LightRAG 已就绪${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "  WebUI:     ${GREEN}http://${ip}:${LIGHTRAG_PORT}${NC}"
    echo -e "  API 文档:  ${GREEN}http://${ip}:${LIGHTRAG_PORT}/docs${NC}"
    echo -e "  Health:    ${GREEN}http://${ip}:${LIGHTRAG_PORT}/health${NC}"
    echo ""
    echo -e "  查看日志:  ${YELLOW}$0 logs${NC}"
    echo -e "  停止服务:  ${YELLOW}$0 down${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# ==================== 主流程 ====================

main() {
    parse_args "$@"

    header "LightRAG Docker 部署"
    echo "  Compose: $(basename "$COMPOSE_FILE")"
    echo "  动作:    $ACTION"
    [ "$GIT_MODE" = true ] && echo "  代码:    Git 拉取 → $GIT_REPO ($GIT_BRANCH)"
    [ "$BUILD_MODE" = true ] && echo "  构建:    本地构建"
    echo ""

    case "$ACTION" in
        pull)
            check_deps
            do_pull
            ;;
        up)
            check_deps
            if [ "$GIT_MODE" = true ]; then
                update_code_from_git
                BUILD_MODE=true  # git 模式必须本地构建
            fi
            prepare_dirs
            build_frontend_if_needed
            download_spacy_models_if_needed
            do_up
            cleanup_images
            ;;
        down)
            check_deps
            do_down
            ;;
        logs)
            check_deps
            do_logs
            ;;
        restart)
            check_deps
            do_restart
            ;;
        status)
            check_deps
            do_status
            ;;
    esac
}

main "$@"
