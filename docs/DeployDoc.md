# LightRAG 生产环境部署文档

## 架构概述

LightRAG 采用 **单容器一体化** 架构：

```
┌─────────────────────────────────────┐
│            Docker 容器               │
│  ┌───────────┐   ┌───────────────┐  │
│  │  FastAPI   │   │  React WebUI  │  │
│  │  后端 API  │◀──│  静态文件      │  │
│  │  :9621     │   │  /webui/*     │  │
│  └───────────┘   └───────────────┘  │
└─────────────────────────────────────┘
```

- **后端**：Python FastAPI，提供 REST API、Ollama 兼容 API、WebUI 静态文件服务
- **前端**：React 19 + TypeScript，构建为静态文件后由 FastAPI 统一托管
- **无独立前后端分离部署** — 前端始终编译为静态产物嵌入后端容器

---

## 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Docker | 20.10+ | `docker info` 可正常运行 |
| Docker Compose | v2+ | `docker compose version` |
| Git | 2.0+ | 仅 `--git` 模式需要 |
| Bun / npm | — | 前端预构建（可选，Docker 内亦可构建） |

---

## 快速上手

```bash
# 1. 创建并编辑配置文件
cp env.example .env
vi .env   # 填入 LLM API Key、嵌入模型等配置

# 2. 拉取最新镜像
./deploy.sh pull

# 3. 启动服务
./deploy.sh up

# 4. 验证
curl http://localhost:9621/health
```

---

## deploy.sh 命令参考

### 语法

```bash
./deploy.sh [动作] [选项...]
```

### 动作

| 动作 | 说明 |
|------|------|
| `up` | 启动服务（默认） |
| `down` | 停止并移除容器 |
| `logs` | 查看服务日志（Ctrl+C 退出） |
| `restart` | 重启服务 |
| `pull` | 拉取最新 Docker 镜像 |
| `status` | 查看服务运行状态 |

### 选项

| 选项 | 说明 |
|------|------|
| `--compose FILE` | 指定 compose 文件（默认 `docker-compose.yml`） |
| `--build` | 本地构建镜像（而非拉取远程镜像） |
| `--git` | 从 Git 拉取源码后构建启动（自动启用 `--build`） |
| `--mirror` | 使用国内镜像源（清华/淘宝）加速构建 |
| `--repo URL` | Git 仓库地址（默认 `git@github.com:jalon881/LightRAG.git`） |
| `--branch NAME` | Git 分支名（默认 `jalon`） |
| `--help`, `-h` | 显示帮助 |

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LIGHTRAG_PROJECT_DIR` | 脚本所在目录 | 项目部署目录 |
| `LIGHTRAG_PORT` | `9621` | HTTP 端口 |
| `LIGHTRAG_GIT_REPO` | `git@github.com:jalon881/LightRAG.git` | Git 仓库地址 |
| `LIGHTRAG_GIT_BRANCH` | `jalon` | Git 分支 |

---

## 部署场景

### 场景一：部署所有应用（前后端一体化，最常用）

适用于首次部署或全量更新，**后端 + 前端一起打包部署**。从 Git 拉取最新源码 → 构建 Docker 镜像 → 启动服务，一条命令完成。

```bash
# ★ 推荐：国内服务器（华为云/阿里云/腾讯云）前后端一起部署
sh deploy.sh up --git --mirror

# 如果不需要国内镜像加速
sh deploy.sh up --git

# 指定分支部署
sh deploy.sh up --git --mirror --branch main

# 部署到指定目录
LIGHTRAG_PROJECT_DIR=/opt/lightrag sh deploy.sh up --git --mirror
```

> **命令解析**：
> - `--git`：从 Git 拉取最新源码后构建启动（自动启用 `--build`，前后端一起重新构建）
> - `--mirror`：使用清华/淘宝国内镜像源加速 pip、apt、npm 下载，**华为云等国内服务器必备**
> - `up`：启动服务

```bash
# 备选：使用远程官方镜像（不构建，直接拉取）
./deploy.sh pull
./deploy.sh up
```

### 场景二：仅修改后端代码

当你只改了 Python 代码（`lightrag/` 目录下的文件），需要重新构建并部署。

```bash
# 方式 1：本地构建 + 重启
./deploy.sh up --build

# 方式 2：从 Git 拉取最新后端代码（保留 .env）
./deploy.sh up --git
```

> **说明**：由于前后端打包在同一镜像中，目前没有独立的「仅部署后端」命令。但 Docker 构建缓存会使前端构建阶段被跳过（如果 `lightrag/api/webui/index.html` 已存在），因此增量构建后端通常很快。

### 场景三：仅修改前端代码

当你只改了前端代码（`lightrag_webui/` 目录下的文件）：

```bash
# 第一步：在主机上预构建前端（避免 Docker 内 Vite OOM）
cd lightrag_webui
bun install --frozen-lockfile
bun run build
cd ..

# 第二步：启动（Docker 检测到已有预构建产物，跳过前端构建）
./deploy.sh up --build

# 或者一步到位（deploy.sh 会自动检测并执行主机构建）
./deploy.sh up --build
```

> **原理**：`Dockerfile` 构建时检查 `lightrag/api/webui/index.html`，若存在则跳过 `bun install && bun run build`。`deploy.sh` 的 `build_frontend_if_needed()` 函数会在启动前自动在主机上执行前端构建，避免低内存服务器在 Docker 内 Vite 构建时 OOM。

### 场景四：全栈部署（PostgreSQL + Neo4j + Milvus + VLLM）

适用于需要 GPU 的生产环境，部署完整的数据库和推理服务栈。

```bash
# 前置条件：NVIDIA GPU + nvidia-container-toolkit
# 1. 复制全栈环境变量模板
cp env.docker-compose-full .env
vi .env  # 填入必要配置（VLLM 模型、Neo4j 密码等）

# 2. 启动全栈服务
./deploy.sh up --compose docker-compose-full.yml --build
```

全栈服务列表：

| 服务 | 端口 | 说明 |
|------|------|------|
| `lightrag` | 9621 | 主 API 服务 |
| `vllm-embed` | 8001 | 嵌入模型推理 |
| `vllm-rerank` | 8000 | 重排序模型推理 |
| `postgres` | 5432（内部） | PGVector 存储 |
| `neo4j` | 7687（内部） | 图数据库 |
| `milvus` | 19530（内部） | 向量数据库 |
| `milvus-etcd` | — | Milvus 元数据 |
| `milvus-minio` | — | Milvus 对象存储 |

### 场景五：Podman 环境

```bash
# Podman 兼容的 compose 文件
podman-compose -f docker-compose.podman.yml up -d

# 注意：连接宿主机服务使用 host.containers.internal
# 而非 host.docker.internal
```

---

## 日常运维

```bash
# 查看运行状态
./deploy.sh status

# 查看实时日志
./deploy.sh logs

# 重启服务（快速重启，不重建镜像）
./deploy.sh restart

# 停止服务
./deploy.sh down

# 更新到最新镜像
./deploy.sh pull
./deploy.sh up
```

---

## 数据目录结构

```
$PROJECT_DIR/
├── .env                    # 配置文件（必需）
├── data/
│   ├── rag_storage/        # 知识图谱持久化数据
│   ├── inputs/             # 上传的文档
│   └── prompts/            # 自定义提示词
├── lightrag/
│   └── api/
│       └── webui/          # 前端构建产物（预构建后存在）
├── spacy_wheels/           # spaCy 模型预下载缓存
└── docker-compose.yml      # Compose 配置
```

---

## 常见问题

### Q: 启动后无法访问 WebUI

```bash
# 检查健康状态
curl http://localhost:9621/health

# 查看日志
./deploy.sh logs
```

### Q: Docker 构建前端时内存不足（OOM）

```bash
# 在主机上预构建前端，避免 Docker 内构建
cd lightrag_webui
bun install --frozen-lockfile
bun run build
cd ..

# 然后启动
./deploy.sh up --build
```

### Q: Docker 未运行或无权限

```bash
# 启动 Docker
sudo systemctl start docker

# 将当前用户加入 docker 组
sudo usermod -aG docker $USER
newgrp docker
```

### Q: 使用国内网络加速

```bash
# 启用国内镜像源
./deploy.sh up --mirror --build
```

### Q: .env 文件被 Git 拉取覆盖

`deploy.sh --git` 模式会在拉取前自动备份 `.env`，拉取后自动恢复。备份位于 `/tmp/lightrag-dotenv-backup.XXXXXX`。

### Q: Podman 兼容性

使用 `docker-compose.podman.yml`，该文件移除了 Docker 专有的 `deploy.restart_policy` 和 `extra_hosts` 配置。连接宿主机时使用 `host.containers.internal` 替代 `host.docker.internal`。
