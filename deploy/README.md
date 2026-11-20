# deploy · 部署与容器化

> 本目录是 Knetsec_Ai 的**部署资产**：Windows 一键安装/启动脚本、Docker 镜像与 Compose 编排、nginx 配置。
> 完整的安装、.env 说明、备份恢复、排障与安全加固见 [../docs/06-部署与运维手册.md](../docs/06-部署与运维手册.md)。

## 目录结构

```
deploy/
├── Dockerfile.server              # 服务端镜像：多阶段，运行阶段仅生产依赖，非 root，HEALTHCHECK
├── Dockerfile.web                 # 面板镜像：Vite 构建 + nginx 托管 + /api 反代
├── nginx.conf                     # 面板容器内的 nginx 配置（SPA 回退、/api 反代、安全头、gzip）
├── docker-compose.yml             # server + web(nginx)，数据卷 ../data:/app/data，restart
├── .env.example                   # Compose 用环境变量示例（复制为 .env）
├── .dockerignore                  # 构建上下文排除清单
├── Dockerfile.server.dockerignore # 同上（Docker 自动识别的按 Dockerfile 命名版本）
├── Dockerfile.web.dockerignore
└── scripts/
    ├── install.ps1                # 一键安装：环境检查 → npm install → .env → 目录 → 构建 → 可选自启
    └── start.ps1                  # 启动/停止：健康检查、端口占用、前后台模式、浏览器打开
```

## 一、Windows 本机部署（推荐，验收基线）

### 1. 环境要求

| 项目     | 要求                                                          |
| -------- | ------------------------------------------------------------- |
| 操作系统 | Windows 10/11（PowerShell 5.1+ 或 PowerShell 7）              |
| Node.js  | ≥ 22.5，推荐 24 LTS（内置 node:sqlite / fetch / loadEnvFile） |
| 磁盘     | ≥ 2 GB（依赖 + 数据 + 报告）                                  |
| 网络     | 可访问 GitHub / NVD / CISA / MSRC / arXiv 等公开源            |

### 2. 一键安装

```powershell
cd D:\Knetsec_Ai
powershell -ExecutionPolicy Bypass -File .\deploy\scripts\install.ps1
```

脚本会依次完成：检查 Node.js 版本 → `npm install` → 由 `.env.example` 生成 `.env` → 创建 `data\`、`data\reports\`、`data\logs\` → `npm run build`。
如需「登录时自动启动」，追加 `-CreateScheduledTask`（需要管理员权限）：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\scripts\install.ps1 -CreateScheduledTask
```

### 3. 启动与停止

```powershell
# 生产模式（前台，Ctrl+C 停止；默认访问 http://127.0.0.1:8787）
powershell -ExecutionPolicy Bypass -File .\deploy\scripts\start.ps1

# 后台模式（日志写 data\logs\server.stdout.log / server.stderr.log）
powershell -ExecutionPolicy Bypass -File .\deploy\scripts\start.ps1 -Background

# 停止监听 8787 的实例
powershell -ExecutionPolicy Bypass -File .\deploy\scripts\start.ps1 -Stop

# 开发模式（server:8787 + Vite:5173 热更新）
powershell -ExecutionPolicy Bypass -File .\deploy\scripts\start.ps1 -Mode dev
```

启动脚本会先做四件事：检查依赖与构建产物、确保 `.env` 存在、检测端口占用、启动后轮询 `/health` 通过才提示地址。

## 二、Docker Compose 部署（可选）

> 前置：Docker Desktop（Windows）或 Docker Engine + Compose v2。镜像基于 `node:24-alpine` 与 `nginx:1.27-alpine`。

### 1. 准备环境变量

```powershell
cd D:\Knetsec_Ai\deploy
Copy-Item .env.example .env
notepad .env      # 修改 ADMIN_PASSWORD、GITHUB_TOKEN 等
```

### 2. 构建并启动

```powershell
cd D:\Knetsec_Ai\deploy
docker compose up -d --build
docker compose ps
```

启动完成后访问 **http://127.0.0.1:8000**（可用 `WEB_PORT` 改端口）。默认账号 `admin / admin123`，登录后立即修改。

### 3. 常用运维命令

```powershell
docker compose logs -f server        # 跟踪服务端日志
docker compose restart server        # 重启服务端
docker compose down                  # 停止并删除容器（保留 ../data 数据）
docker compose up -d --build         # 代码更新后重建
docker compose exec server node -v   # 进容器检查环境
```

### 4. 数据与端口

| 项             | 值                   | 说明                                               |
| -------------- | -------------------- | -------------------------------------------------- |
| 宿主机面板端口 | `WEB_PORT` 默认 8000 | 只暴露 nginx；server 8787 仅在容器网络内           |
| 数据卷         | `../data:/app/data`  | 数据库、报告、日志、JWT 密钥都在这里，容器重建不丢 |
| 容器内端口     | server 8787 / web 80 | `KNETSEC_HOST=0.0.0.0` 由镜像固定注入              |
| 健康检查       | `GET /health`        | compose 以 `service_healthy` 门控 web 启动         |

> 备份 = 复制仓库根 `data` 目录；恢复 = 停止容器 → 覆盖 `data` → 启动。详见 06 §7。

## 三、环境变量（Compose）

| 变量                                | 默认             | 说明                                            |
| ----------------------------------- | ---------------- | ----------------------------------------------- |
| `WEB_PORT`                          | 8000             | 宿主机访问端口                                  |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | admin / admin123 | 首次启动创建的管理员，只在不存在的库上生效      |
| `GITHUB_TOKEN`                      | 空               | 强烈建议配置；未认证 GitHub API 60 次/小时      |
| `NVD_API_KEY`                       | 空               | 可选；NVD 限流 5 次/30 秒 → 50 次/30 秒         |
| `KNETSEC_HTTP_PROXY`                | 空               | 访问 CNVD 等站点失败时的 HTTP 代理              |
| `KNETSEC_SCHEDULER`                 | on               | off 表示只允许手动采集                          |
| `KNETSEC_JWT_SECRET`                | 空               | 留空则自动生成到 `data/.jwt-secret`（≥16 字符） |
| `LOG_LEVEL`                         | info             | debug/info/warn/error                           |
| `TZ`                                | Asia/Shanghai    | 容器时区                                        |

## 四、nginx 配置说明（`nginx.conf`）

- 静态托管：SPA 路由 `try_files $uri $uri/ /index.html`；
- `/api/` 反代到 `server:8787`，保留 `/api/v1` 前缀（`proxy_pass` 不带路径）；
- `/health`、`/docs`、`/openapi.json` 透传，便于面板同域访问接口文档与健康检查；
- 安全响应头：`X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`；
- gzip 与 `/assets/` 长缓存；`proxy_read_timeout 120s` 覆盖试采/报告生成等慢请求。

## 五、构建细节

`Dockerfile.server` 三阶段：

1. **builder**：`npm ci` 全量依赖 → 编译 shared → server → web（后端镜像也带上 web/dist，直接访问 8787 即可用）；
2. **prod-deps**：`npm ci --omit=dev`，只保留运行依赖（fastify/undici/pino/cheerio 等）；
3. **runner**：`node:24-alpine`，创建非 root 用户 `knetsec`，复制 node_modules / shared/dist / server/dist / web/dist，`EXPOSE 8787`，`HEALTHCHECK` 调 `/health`。

`Dockerfile.web` 两阶段：Vite 构建 `apps/web/dist` → nginx 托管（自带 `nginx.conf`）。

> 镜像内没有 `.env`：配置全部通过环境变量注入，密钥不会打进镜像层。

## 六、排障

| 现象                    | 排查                                                                           |
| ----------------------- | ------------------------------------------------------------------------------ |
| `npm install` 卡住/失败 | 检查网络与 npm registry：`npm config get registry`；可换镜像源                 |
| 启动报端口占用          | `start.ps1 -Stop`，或改 `KNETSEC_PORT`；`Get-NetTCPConnection -LocalPort 8787` |
| 面板空白但 /health 正常 | 确认已 `npm run build` 生成 `apps/web/dist`；或直接访问 `/docs` 验证 API       |
| Docker 构建上下文过大   | 确认使用 `deploy/Dockerfile.*.dockerignore`，且 `node_modules` 未被复制        |
| 容器启动即退出          | `docker compose logs server`；常见为数据卷权限或端口冲突                       |
| 数据源采集失败          | 面板「数据源」看 `lastError` → 试采 → 配置 Token/代理，详见 06 §8              |

## 七、安全提示

1. 默认只监听 `127.0.0.1`，不要把 8787 直接暴露公网；需要远程访问时用 nginx/Caddy + TLS；
2. 首次登录立即修改 `admin` 密码；`.env` 与 `data/` 已在 `.gitignore` 中；
3. 反向代理场景请限制来源 IP、开启 HTTPS，并在 `KNETSEC_CORS_ORIGINS` 中限定域名；
4. 定期备份 `data/`（SQLite + 报告），升级前先备份。
