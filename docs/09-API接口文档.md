# 09 · API 接口文档

> 文档编号：KNETSEC-API-009　版本：v1.0　日期：2026-11-17
> 作者：Knetsec_Ai 项目组（docs-deploy）　适用对象：前端开发者、第三方集成方、测试与验收人
> 口径来源：`packages/shared/src/api.ts` 契约 + `apps/server/src/modules/**` **实际路由实现**（逐一对照）。
> 约定：所有路径均相对服务地址 `http://127.0.0.1:8787`；命令用 Windows PowerShell，`curl` 指 `curl.exe`（PowerShell 的 `curl` 是 `Invoke-WebRequest` 别名）。

---

## 1. 总览

| 项目 | 说明 |
|---|---|
| 基础地址 | `http://127.0.0.1:8787`（默认只监听本机，端口可用 `KNETSEC_PORT` 修改） |
| API 前缀 | `/api/v1`（契约 `API_PREFIX`）；根路径另有 `/health`、`/docs`、`/openapi.json` |
| 传输格式 | JSON（UTF-8）；下载类接口返回原始文本/文件流 |
| 时间格式 | ISO 8601 UTC 字符串，如 `2026-11-17T03:20:00.000Z`；前端按本地时区展示 |
| 鉴权 | `Authorization: Bearer <JWT>`，默认 12 小时有效 |
| 请求标识 | 响应信封中的 `requestId`（UUID v4）与 pino 日志 `reqId` 对应，排障时提供给运维；本文示例为便于阅读写成 `req-1` 等简写 |
| 字符集 | 请求/响应均 UTF-8；CSV 导出带 BOM，Excel 直接打开不乱码 |

**公开端点**（无需登录）：`POST /api/v1/auth/login`、`GET /health`、`GET /api/v1/health`、`GET /docs`、`GET /openapi.json`。其余全部需要 JWT。

其他服务级约定：

- **请求体上限 2 MB**（Fastify `bodyLimit`），超限返回 413/400；
- **限流只作用于登录路由**（`@fastify/rate-limit` 配置为 `global:false`，登录 5 次/分钟/IP）；其余接口不限流，安全依赖 JWT 与默认仅监听 127.0.0.1；
- **CORS**：无 Origin 头（同源/curl）直接放行；开发期允许 `127.0.0.1`/`localhost` 任意端口；其余来源按 `KNETSEC_CORS_ORIGINS` 白名单；
- **SPA 回退**：`apps/web/dist` 存在时，非 `/api`、`/docs`、`/openapi.json` 的 GET 请求回退 `index.html`；接口路径不存在返回 JSON 404；
- **静态面板**：生产模式直接访问 `http://127.0.0.1:8787/` 即可打开管理面板（服务端托管前端构建产物）。

---

## 2. 认证

### 2.1 登录获取 Token

```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "admin123"
}
```

约束：`username` 1-64 字符（首尾空格自动去除）；`password` 1-200 字符；**同一 IP 每分钟最多 5 次**（超出 429）。

成功响应（200）：

```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxx.yyy",
    "expiresIn": 43200,
    "user": {
      "id": 1,
      "username": "admin",
      "displayName": "系统管理员",
      "role": "admin",
      "mustChangePassword": true,
      "lastLoginAt": "2026-11-17T03:20:00.000Z"
    }
  },
  "requestId": "req-1"
}
```

失败响应（401，不区分「用户不存在」与「密码错误」）：

```json
{
  "success": false,
  "error": { "code": "UNAUTHORIZED", "message": "用户名或密码错误" },
  "requestId": "req-2"
}
```

后续请求携带：

```http
Authorization: Bearer <token>
```

### 2.2 当前用户

```http
GET /api/v1/auth/me
Authorization: Bearer <token>
```

`data` 为 `AuthUser`：`{ id, username, displayName, role, mustChangePassword, lastLoginAt }`。

> 用途：前端刷新页面后恢复用户态、根据 `role` 控制菜单/按钮显隐。`mustChangePassword=true` 时面板提示修改初始密码。

### 2.3 修改密码

```http
POST /api/v1/auth/change-password
Authorization: Bearer <token>
Content-Type: application/json

{
  "oldPassword": "admin123",
  "newPassword": "Knetsec2026"
}
```

校验规则：原密码必须正确（否则 400「原密码不正确」）；新密码 ≥ 8 位且同时包含字母与数字；不能与原密码相同。成功返回：

```json
{ "success": true, "data": { "changed": true }, "requestId": "req-3" }
```

修改成功后 `must_change_password` 清零，并写审计（`auth.change_password`）。

### 2.4 Token 失效处理

| 场景 | 服务端 | 前端 |
|---|---|---|
| 缺少 `Authorization` | 401 `UNAUTHORIZED` | 跳登录页 |
| 签名错误 / 过期 | 401 `UNAUTHORIZED` | 清 token 并跳登录页 |
| 用户已被删除 | 401 `UNAUTHORIZED`（消息：账号不存在或已被删除） | 同上 |
| 角色不足（viewer 调写接口） | 403 `FORBIDDEN` | 提示无权操作，不跳登录 |

---

## 3. 统一响应信封与分页

### 3.1 成功信封

```json
{ "success": true, "data": <T>, "requestId": "req-1" }
```

### 3.2 失败信封

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "单次最多 500 条",
    "details": { "field": "ids" }
  },
  "requestId": "req-2"
}
```

> `details` 可选，仅在校验失败等场景返回辅助信息；错误 message 面向用户，可直接展示。

### 3.3 分页结构

列表接口统一返回 `Paginated<T>`：

```json
{
  "items": [],
  "page": 1,
  "pageSize": 20,
  "total": 0,
  "totalPages": 0
}
```

- `page` 从 1 开始；`pageSize` 默认 20、上限 100；
- 传入超限的 `pageSize` 会被**夹到 100**（不报错）；非法数字回退默认值；
- `totalPages` 在 `total=0` 时为 0。

---

## 4. 错误码

| HTTP | code | 触发场景 | 前端建议 |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | 参数缺失/类型错/超长、业务校验失败（如新密码太弱、key 不可修改） | 展示 message，聚焦出错字段 |
| 401 | `UNAUTHORIZED` | 未登录、token 过期/无效、用户已删除 | 清 token 跳登录 |
| 403 | `FORBIDDEN` | viewer 调用写接口、查审计 | 提示「当前账号无权执行该操作」 |
| 404 | `NOT_FOUND` | 情报/源/运行/报告 id 不存在 | 提示资源不存在，刷新列表 |
| 409 | `CONFLICT` | 数据源 key 重复、已有采集任务在运行 | 提示刷新后重试 |
| 429 | `RATE_LIMITED` | 登录超过 5 次/分钟（仅登录路由限流） | 提示稍后再试 |
| 502 | `UPSTREAM_ERROR` | 上游数据源/LLM 调用失败（采集内部记录，API 层较少直接返回） | 提示上游异常 |
| 500 | `INTERNAL_ERROR` | 未预期异常（不会返回堆栈） | 提示查看服务端日志 |

> 校验失败（zod）统一转 400；未捕获异常统一 500 且只返回通用文案，堆栈只进日志。

---

## 5. 权限矩阵

| 端点 | admin | viewer | 说明 |
|---|---|---|---|
| `POST /auth/login` | 公开 | 公开 | 限流 5/分/IP |
| `GET /auth/me` | ✓ | ✓ | |
| `POST /auth/change-password` | ✓ | ✓ | 仅改自己 |
| `GET /dashboard/summary` | ✓ | ✓ | |
| `GET /items` / `GET /items/:id` | ✓ | ✓ | |
| `GET /items/export` | ✓ | ✓ | 导出属读操作 |
| `PATCH /items/:id` | ✓ | ✗ | 403 |
| `POST /items/bulk` | ✓ | ✗ | 403 |
| `GET /sources` | ✓ | ✓ | |
| `POST /sources` / `PATCH` / `DELETE` / `toggle` | ✓ | ✗ | 403 |
| `POST /sources/:id/test` | ✓ | ✗ | 试采是写操作（有审计） |
| `POST /tasks/fetch` | ✓ | ✗ | |
| `GET /tasks/runs` / `:id` / `status` | ✓ | ✓ | |
| `GET /reports` / `:id` / `:id/download` | ✓ | ✓ | |
| `POST /reports/generate` / `DELETE` | ✓ | ✗ | |
| `GET /settings` | ✓ | ✓ | Key 脱敏 |
| `PUT /settings` | ✓ | ✗ | |
| `GET /audit-logs` | ✓ | ✗ | 仅 admin |
| `GET /system/info` | ✓ | ✓ | |
| `GET /health`（根与 `/api/v1`） | 公开 | 公开 | 容器探活 |
| `GET /docs` / `GET /openapi.json` | 公开 | 公开 | Swagger UI |

> `POST /sources/:id/test` 为 admin 专属：试采会发起真实外部请求，并写审计 `source.test`。

---

## 6. 端点总览

| 方法 | 路径 | 鉴权 | 成功状态码 | 返回 data 类型 |
|---|---|---|---|---|
| POST | `/api/v1/auth/login` | 公开 | 200 | `LoginResponse` |
| GET | `/api/v1/auth/me` | 登录 | 200 | `AuthUser` |
| POST | `/api/v1/auth/change-password` | 登录 | 200 | `{ changed: true }` |
| GET | `/api/v1/dashboard/summary` | 登录 | 200 | `DashboardSummary` |
| GET | `/api/v1/items` | 登录 | 200 | `Paginated<ItemDTO>` |
| GET | `/api/v1/items/:id` | 登录 | 200 | `ItemDTO` |
| PATCH | `/api/v1/items/:id` | admin | 200 | `ItemDTO` |
| POST | `/api/v1/items/bulk` | admin | 200 | `{ affected: number }` |
| GET | `/api/v1/items/export` | 登录 | 200 | 原始文件流 |
| GET | `/api/v1/sources` | 登录 | 200 | `SourceDTO[]` |
| POST | `/api/v1/sources` | admin | **201** | `SourceDTO` |
| PATCH | `/api/v1/sources/:id` | admin | 200 | `SourceDTO` |
| DELETE | `/api/v1/sources/:id` | admin | 200 | `{ deleted: true, id }` |
| POST | `/api/v1/sources/:id/toggle` | admin | 200 | `SourceDTO` |
| POST | `/api/v1/sources/:id/test` | admin | 200 | `SourceTestResult` |
| POST | `/api/v1/tasks/fetch` | admin | **202** | `StartFetchResult` |
| GET | `/api/v1/tasks/runs` | 登录 | 200 | `Paginated<RunDTO>`（无 logs） |
| GET | `/api/v1/tasks/runs/:id` | 登录 | 200 | `RunDTO`（含 logs） |
| GET | `/api/v1/tasks/status` | 登录 | 200 | `SchedulerStatus` |
| GET | `/api/v1/reports` | 登录 | 200 | `Paginated<ReportDTO>` |
| POST | `/api/v1/reports/generate` | admin | 200 | `ReportDetailDTO` |
| GET | `/api/v1/reports/:id` | 登录 | 200 | `ReportDetailDTO` |
| GET | `/api/v1/reports/:id/download` | 登录 | 200 | 原始文件流 |
| DELETE | `/api/v1/reports/:id` | admin | 200 | `{ deleted: true, id }` |
| GET | `/api/v1/settings` | 登录 | 200 | `SettingsDTO`（Key 脱敏） |
| PUT | `/api/v1/settings` | admin | 200 | `SettingsDTO` |
| GET | `/api/v1/audit-logs` | admin | 200 | `Paginated<AuditLogDTO>` |
| GET | `/api/v1/system/info` | 登录 | 200 | `SystemInfoDTO` |
| GET | `/health`、`/api/v1/health` | 公开 | 200 | `HealthDTO` |
| GET | `/docs` | 公开 | 200 | Swagger UI（HTML） |
| GET | `/openapi.json` | 公开 | 200 | OpenAPI 3 JSON |

---

## 7. 端点详解

### 7.1 仪表盘

#### GET /api/v1/dashboard/summary

一次返回首页全部聚合数据（6 组），避免多次请求往返。需要登录。

响应示例（截断）：

```json
{
  "success": true,
  "data": {
    "totals": {
      "items": 12480,
      "itemsToday": 86,
      "items7d": 612,
      "unread": 42,
      "critical7d": 9,
      "sources": 18,
      "sourcesEnabled": 16,
      "reports": 12
    },
    "severityDistribution": [
      { "severity": "critical", "count": 12 },
      { "severity": "high", "count": 128 },
      { "severity": "medium", "count": 342 },
      { "severity": "low", "count": 88 },
      { "severity": "info", "count": 5 },
      { "severity": "unknown", "count": 10 }
    ],
    "categoryDistribution": [
      { "category": "ai-security", "count": 356 },
      { "category": "vuln", "count": 742 },
      { "category": "cyber", "count": 210 },
      { "category": "research", "count": 132 },
      { "category": "tool", "count": 48 },
      { "category": "policy", "count": 12 },
      { "category": "news", "count": 24 }
    ],
    "sourceDistribution": [
      { "sourceKey": "github-ghsa", "sourceName": "GitHub 安全公告库", "count": 880 }
    ],
    "trend": [
      { "date": "2026-11-04", "total": 42, "aiSecurity": 12, "vuln": 20 }
    ],
    "latestItems": [],
    "recentRuns": []
  },
  "requestId": "req-10"
}
```

字段说明：

| 字段 | 说明 |
|---|---|
| `totals.itemsToday` | 按 `fetched_at` ≥ 本地当日 0 点统计 |
| `totals.items7d` / `critical7d` | 近 7 天（按 `fetched_at`） |
| `severityDistribution` | 始终包含全部 6 种严重度（缺项补 0），按严重程度降序 |
| `categoryDistribution` | 包含 7 个业务分类（缺项补 0） |
| `sourceDistribution` | 按条目数降序，最多 20 个来源 |
| `trend` | 最近 14 天（含今天，从旧到新），按 `fetched_at` 日期分桶 |
| `latestItems` | 按 importance 降序取 10 条 |
| `recentRuns` | 最近 5 次采集（不含 logs） |

```powershell
curl.exe -H "Authorization: Bearer $token" http://127.0.0.1:8787/api/v1/dashboard/summary
```

---

### 7.2 情报中心

#### GET /api/v1/items

分页查询情报。需要登录。默认按 `importance` 降序。

查询参数：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page` | int | 否 | 页码，默认 1 |
| `pageSize` | int | 否 | 每页条数，默认 20，上限 100（超限夹到 100） |
| `q` | string | 否 | 关键词，匹配 title/summary（LIKE，最长 200） |
| `category` | enum | 否 | `ai-security\|vuln\|cyber\|research\|tool\|policy\|news` |
| `severity` | enum | 否 | `critical\|high\|medium\|low\|info\|unknown` |
| `sourceKey` | string | 否 | 数据源 key，如 `github-ghsa` |
| `from` | string | 否 | 起始时间，ISO 或可被 `Date.parse` 解析的字符串 |
| `to` | string | 否 | 结束时间 |
| `read` | bool | 否 | `true/false`（也接受 `1/0`） |
| `starred` | bool | 否 | 同上 |
| `watched` | bool | 否 | `true` 时只返回命中系统「关注关键词」的条目 |
| `sort` | enum | 否 | `published_at\|fetched_at\|severity\|importance`，默认 `importance` |
| `order` | enum | 否 | `asc\|desc`，默认 `desc` |

> 时间筛选口径：`COALESCE(published_at, fetched_at)`，即发布时间优先、缺失时用抓取时间。
> `severity` 排序按严重度权重（critical > high > …），不是字典序。
> 未配置关注关键词时，`watched=true` 返回空集（不会退化为全部）。

响应示例：

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": 1024,
        "uid": "9f2c…",
        "sourceKey": "github-ghsa",
        "sourceName": "GitHub 安全公告库",
        "title": "vLLM 远程代码执行漏洞（GHSA-xxxx-xxxx-xxxx）",
        "summary": "攻击者可通过构造请求触发反序列化……",
        "url": "https://github.com/advisories/GHSA-xxxx-xxxx-xxxx",
        "author": "GitHub",
        "publishedAt": "2026-11-16T08:00:00.000Z",
        "fetchedAt": "2026-11-17T03:10:00.000Z",
        "category": "vuln",
        "tags": ["llm-app"],
        "severity": "critical",
        "cveIds": ["CVE-2026-12345"],
        "ghsaIds": ["GHSA-xxxx-xxxx-xxxx"],
        "cvssScore": 9.8,
        "isKev": false,
        "vendor": "vLLM",
        "lang": "en",
        "isRead": false,
        "isStarred": false,
        "importance": 78
      }
    ],
    "page": 1,
    "pageSize": 20,
    "total": 1,
    "totalPages": 1
  },
  "requestId": "req-11"
}
```

```powershell
curl.exe -H "Authorization: Bearer $token" "http://127.0.0.1:8787/api/v1/items?q=vllm&severity=critical&pageSize=10"
```

#### GET /api/v1/items/:id

返回单条 `ItemDTO`（字段同上，不含原始快照 `raw`）。不存在返回 404 `NOT_FOUND`。

#### PATCH /api/v1/items/:id

admin 更新已读/星标；body 至少提供一个字段：

```json
{ "isRead": true, "isStarred": true }
```

返回更新后的 `ItemDTO`；id 不存在返回 404。

#### POST /api/v1/items/bulk

admin 批量操作：

```json
{
  "ids": [1, 2, 3],
  "action": "mark_read"
}
```

`action` 取值：`mark_read`、`mark_unread`、`star`、`unstar`、`delete`；`ids` 长度 1-500（非整数/负数直接 400）。
返回 `{ "affected": 3 }`（实际影响行数；含不存在的 id 不报错）。写审计 `items.<action>`，detail 含 ids 与 affected。

#### GET /api/v1/items/export

按列表同款筛选条件导出（不分页），最多 **5000** 条，按 importance 降序。

| 参数 | 说明 |
|---|---|
| `format` | `csv`（默认）`json` `markdown`；非法值回退 `csv` |
| 其余筛选参数 | 同 `GET /items`（不含分页/排序） |

**注意**：返回**原始文件流**，不是 JSON 信封：

- CSV：`text/csv; charset=utf-8`，带 BOM，列：标题/来源/分类/严重度/CVE/GHSA/CVSS/KEV/发布时间/链接；
- JSON：`application/json`，内容为 `ItemDTO[]` 数组；
- Markdown：`text/markdown`，表格形式；
- `Content-Disposition: attachment; filename="knetsec-items-YYYY-MM-DD.<ext>"`。

```powershell
curl.exe -H "Authorization: Bearer $token" -o items.csv "http://127.0.0.1:8787/api/v1/items/export?format=csv&severity=high"
```

---

### 7.3 数据源管理

#### GET /api/v1/sources

返回全部数据源（含停用），按 `priority ASC, id ASC` 排序。`data` 为 `SourceDTO[]`（**不是分页结构**）。

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "key": "github-ghsa",
      "name": "GitHub 安全公告库",
      "category": "github",
      "adapter": "github_advisories",
      "url": "https://github.com/advisories",
      "config": { "perPage": 50, "severities": ["critical", "high"], "ecosystem": "pip" },
      "enabled": true,
      "intervalMinutes": 360,
      "priority": 10,
      "lastRunAt": "2026-11-17T03:10:00.000Z",
      "lastStatus": "success",
      "lastError": null,
      "successCount": 128,
      "failureCount": 2,
      "createdAt": "2026-11-14T00:00:00.000Z",
      "updatedAt": "2026-11-17T03:10:00.000Z"
    }
  ],
  "requestId": "req-12"
}
```

#### POST /api/v1/sources

admin 新建数据源，成功返回 **201** + 新 `SourceDTO`。

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `key` | string | 是 | `^[a-z0-9][a-z0-9-]{1,63}$`，全局唯一（重复 409） |
| `name` | string | 是 | 1-100 字符 |
| `category` | enum | 是 | `github\|vuln-db\|vendor\|research\|media\|community` |
| `adapter` | enum | 是 | 10 种适配器之一（见下表） |
| `url` | string | 否 | 空或 `http(s)://` 开头 |
| `config` | object | 否 | 适配器私有配置，缺省 `{}` |
| `enabled` | bool | 否 | 默认 true |
| `intervalMinutes` | int | 否 | 5-10080；缺省取系统设置 `fetchIntervalMinutes`（默认 360） |
| `priority` | int | 否 | 1-9999，默认 100（越小越优先） |

适配器取值：`github_advisories`、`github_search`、`github_releases`、`nvd_cve`、`cisa_kev`、`msrc_cvrf`、`arxiv`、`rss`、`json_list`、`html_list`。

```powershell
$body = @{
  key = 'my-rss'
  name = '某安全媒体'
  category = 'media'
  adapter = 'rss'
  url = 'https://example.com/feed'
  config = @{ url = 'https://example.com/feed'; maxItems = 30; keepDays = 30 }
  intervalMinutes = 360
  priority = 100
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/v1/sources -Headers @{ Authorization = "Bearer $token" } -Body $body -ContentType 'application/json'
```

#### PATCH /api/v1/sources/:id

admin 修改；`key` 与 `adapter` **创建后不可修改**（传相同值允许，传不同值 400）。其余字段同新建，全部可选。返回更新后的 `SourceDTO`。

#### DELETE /api/v1/sources/:id

admin 删除源登记；**历史情报条目不删除**（`items.source_key` 冗余保留）。返回：

```json
{ "success": true, "data": { "deleted": true, "id": 5 }, "requestId": "req-13" }
```

#### POST /api/v1/sources/:id/toggle

admin 启用/停用（取反），返回更新后的 `SourceDTO`；审计动作 `source.enable` / `source.disable`。

#### POST /api/v1/sources/:id/test

admin 试采：调用适配器但**不写库**，超时 **60 秒**。返回：

```json
{
  "success": true,
  "data": {
    "ok": true,
    "adapter": "github_advisories",
    "fetched": 42,
    "durationMs": 1832,
    "sample": ["标题 1", "标题 2", "标题 3"],
    "error": null
  },
  "requestId": "req-14"
}
```

失败时 `ok=false`、`error` 为错误摘要（HTTP 仍为 200）；写审计 `source.test`。

---

### 7.4 采集任务

#### POST /api/v1/tasks/fetch

admin 触发采集，**202 Accepted**，异步执行。

```json
{ "sourceKeys": ["github-ghsa", "nvd-ai"] }
```

`sourceKeys` 可省略（= 全部启用源）；数组最多 50 个，重复值自动去重；不存在的 key 返回 400 并列出缺失项。

响应：

```json
{ "success": true, "data": { "runId": 88, "status": "running" }, "requestId": "req-15" }
```

冲突与错误：已有任务运行中返回 **409 CONFLICT**（消息含正在运行的 runId）；没有启用源返回 400。
前端拿到 `runId` 后轮询 `GET /tasks/runs/:id` 看进度与日志。

#### GET /api/v1/tasks/runs

分页查询运行历史，按 id 倒序。

| 参数 | 说明 |
|---|---|
| `status` | 可选：`running\|success\|partial\|failed` |
| `page` / `pageSize` | 分页，默认 20，上限 100 |

列表**不含 logs**（`logs` 恒为 `[]`），避免响应过大；`data` 为 `Paginated<RunDTO>`。

#### GET /api/v1/tasks/runs/:id

运行详情，含逐行日志 `logs: string[]`。不存在返回 404。

#### GET /api/v1/tasks/status

调度器状态（调度器未启用时返回 `enabled=false` 的空结构）：

```json
{
  "success": true,
  "data": {
    "enabled": true,
    "jobs": [
      { "name": "到期数据源扫描", "cron": "*/5 * * * *", "nextRunAt": "2026-11-17T03:25:00.000Z" },
      { "name": "每周自动周报", "cron": "0 8 * * 1", "nextRunAt": "2026-11-23T00:00:00.000Z" },
      { "name": "保留策略清理", "cron": "0 3 * * *", "nextRunAt": "2026-11-18T19:00:00.000Z" }
    ],
    "runningRunId": null,
    "dueSources": [
      {
        "key": "github-ghsa",
        "name": "GitHub 安全公告库",
        "lastRunAt": "2026-11-17T00:00:00.000Z",
        "dueAt": "2026-11-17T06:00:00.000Z",
        "intervalMinutes": 360
      }
    ]
  },
  "requestId": "req-16"
}
```

> 调度器时区固定 `Asia/Shanghai`；三个任务：每 5 分钟扫描到期源、每周一 08:00 自动周报、每天 03:00 按保留天数清理。

---

### 7.5 报告中心

#### GET /api/v1/reports

分页查询报告列表，按 id 倒序。

| 参数 | 说明 |
|---|---|
| `type` | 可选：`daily\|weekly\|monthly\|custom` |
| `page` / `pageSize` | 分页 |

返回 `Paginated<ReportDTO>`，`preview` 为 Markdown 前 800 字符（列表不返回全文）。

#### POST /api/v1/reports/generate

admin 生成报告，同步返回完整报告（含 markdown/html）。

```json
{
  "type": "weekly",
  "periodStart": "2026-11-10T00:00:00.000Z",
  "periodEnd": "2026-11-17T00:00:00.000Z",
  "title": "AI 安全与网络安全周报（2026-11-10 ~ 2026-11-17）",
  "itemIds": [1, 2, 3]
}
```

| 字段 | 说明 |
|---|---|
| `type` | 可选，默认 `weekly`；非法值按 weekly |
| `periodStart` / `periodEnd` | 可选；缺省按类型推断：daily=1 天、weekly=7 天、monthly=30 天、custom=系统设置 `reportRangeDays`；结束时间缺省为当前时间；起止颠倒会自动交换；无法解析的时间被忽略 |
| `title` | 可选，最长 200 |
| `itemIds` | 可选，专题报告；最多 500 个，重复自动去重 |

生成内容：装载最多 2000 条条目 → 按系统设置章节渲染 Markdown → 生成内联 CSS 的单文件 HTML → 写 `reports` 表 → 落盘 `data/reports/<id>-<type>-<yyyyMMdd>/report.md` 与 `report.html`（落盘失败不影响数据库中的报告可用性）。

返回 `ReportDetailDTO`（`id/type/title/periodStart/periodEnd/itemCount/createdAt/createdBy/preview/markdown/html`）。

#### GET /api/v1/reports/:id

报告详情（含 markdown/html）；不存在 404。

#### GET /api/v1/reports/:id/download

下载报告文件（**原始文件流**，非信封）。

| 参数 | 说明 |
|---|---|
| `format` | `md`（默认）或 `html`；非法值按 `md` |

- 文件名：`knetsec-report-<id>-<type>-<yyyyMMdd>.<ext>`；
- 从数据库内容生成，不依赖落盘文件（文件被删也能下载）；
- HTML 内容为空返回 400。

```powershell
curl.exe -H "Authorization: Bearer $token" -o report.md "http://127.0.0.1:8787/api/v1/reports/12/download?format=md"
```

#### DELETE /api/v1/reports/:id

admin 删除报告记录并清理落盘目录；不存在 404。返回 `{ deleted: true, id }`。

---

### 7.6 系统设置

#### GET /api/v1/settings

返回 `SettingsDTO`，其中 `llmApiKey` 为脱敏值（如 `sk-****abcd`），**绝不明文返回**。

```json
{
  "success": true,
  "data": {
    "watchKeywords": ["openai", "mcp", "prompt injection"],
    "aiSecurityKeywords": ["llm", "prompt injection"],
    "reportRangeDays": 7,
    "reportSections": ["ai-security", "vuln", "cyber", "research", "tool", "policy", "news"],
    "notificationEnabled": false,
    "notificationChannel": "generic",
    "notificationWebhook": "",
    "llmEnabled": false,
    "llmBaseUrl": "https://api.deepseek.com",
    "llmApiKey": "",
    "llmModel": "deepseek-chat",
    "retentionDays": 180,
    "fetchIntervalMinutes": 360
  },
  "requestId": "req-17"
}
```

#### PUT /api/v1/settings

admin 部分更新；只传需要修改的字段，未传字段保持原值。

| 字段 | 约束 |
|---|---|
| `watchKeywords` | 字符串数组，每项 1-100，最多 500 |
| `aiSecurityKeywords` | 字符串数组，每项 1-100，最多 1000 |
| `reportRangeDays` | 1-90 |
| `reportSections` | 分类数组，1-7 项（必须至少 1 个） |
| `notificationEnabled` | bool |
| `notificationChannel` | `generic\|wecom\|dingtalk\|feishu` |
| `notificationWebhook` | 字符串，最长 500 |
| `llmEnabled` | bool |
| `llmBaseUrl` | 空或 `http(s)://` 开头，最长 300 |
| `llmApiKey` | 最长 300；**传空字符串或含 `****` 的脱敏值表示保持原值** |
| `llmModel` | 最长 100 |
| `retentionDays` | 7-3650 |
| `fetchIntervalMinutes` | 5-10080 |

返回更新后的 `SettingsDTO`（Key 仍脱敏）；保存后即时生效（关键词、报告章节、采集间隔等），写审计 `settings.update`（detail 只记字段名，不记值）。

---

### 7.7 审计日志

#### GET /api/v1/audit-logs

仅 admin。分页查询，按 `created_at DESC, id DESC`。

| 参数 | 说明 |
|---|---|
| `username` | 可选，精确匹配 |
| `action` | 可选，模糊匹配（LIKE），如 `source` |
| `page` / `pageSize` | 分页 |

返回 `Paginated<AuditLogDTO>`：

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": 501,
        "username": "admin",
        "action": "source.create",
        "target": "source:my-rss",
        "detail": { "adapter": "rss", "category": "media" },
        "ip": "127.0.0.1",
        "createdAt": "2026-11-17T03:21:00.000Z"
      }
    ],
    "page": 1,
    "pageSize": 20,
    "total": 1,
    "totalPages": 1
  },
  "requestId": "req-18"
}
```

审计动作清单（实际实现）：`auth.login`、`auth.change_password`、`items.mark_read` / `items.mark_unread` / `items.star` / `items.unstar` / `items.delete`、`source.create`、`source.update`、`source.delete`、`source.enable`、`source.disable`、`source.test`、`tasks.fetch`、`report.generate`、`report.delete`、`settings.update`。

> 说明：登录失败目前只写应用日志（warn）与限流，不写审计表；单条 `PATCH /items/:id` 也不写审计（批量操作才写）。

---

### 7.8 系统信息与健康检查

#### GET /api/v1/system/info

需要登录，返回版本、运行环境、运行时长、数据库文件大小、各类计数与调度器状态：

```json
{
  "success": true,
  "data": {
    "appName": "Knetsec_Ai",
    "version": "1.0.0",
    "env": "production",
    "nodeVersion": "v24.22.0",
    "startedAt": "2026-11-17T03:00:00.000Z",
    "uptimeSeconds": 1260,
    "dataDir": "D:\\Knetsec_Ai\\data",
    "dbPath": "D:\\Knetsec_Ai\\data\\knetsec.db",
    "dbSizeBytes": 41234432,
    "counts": { "items": 12480, "sources": 18, "sourcesEnabled": 16, "reports": 12, "runs": 96 },
    "scheduler": {
      "enabled": true,
      "jobs": [],
      "runningRunId": null,
      "dueSources": []
    }
  },
  "requestId": "req-19"
}
```

> 注意：该接口返回 `dataDir` / `dbPath` 绝对路径，属于运维信息；对 viewer 也可见（本机单租户场景可接受，公网部署请仅授予可信人员）。

#### GET /health 与 GET /api/v1/health

公开（无需登录），供启动脚本与容器 HEALTHCHECK 使用；两个路径返回同一结构：

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "app": "Knetsec_Ai",
    "version": "1.0.0",
    "db": "ok",
    "uptimeSeconds": 1260,
    "now": "2026-11-17T03:21:00.000Z"
  },
  "requestId": "req-20"
}
```

> 实现说明：健康检查内部会执行 `SELECT 1`；数据库异常时抛出错误 → 500 `INTERNAL_ERROR`（当前实现不会返回 503，`db` 字段固定为 `ok`）。容器探活以 HTTP 200 为准。

---

### 7.9 API 文档端点

| 端点 | 说明 |
|---|---|
| `GET /docs` | Swagger UI（HTML 页面，可在线展开并调用所有端点） |
| `GET /openapi.json` | OpenAPI 3 文档（JSON），可直接导入 Postman/Apifox/代码生成器 |

两个端点均公开（不返回敏感数据）。Swagger 文档的 `servers` 由服务端启动配置生成；在 Swagger UI 中点击 **Authorize** 填入 `Bearer <token>` 后即可直接调试受保护接口。

若部署在反向代理后，请确保 `/docs` 与 `/openapi.json` 一并转发（`deploy/nginx.conf` 已配置）。

`/docs` 使用 `@fastify/swagger-ui` 路由前缀实现，`/openapi.json` 直接返回 `app.swagger()` 生成的 OpenAPI 3 文档；文档标签（tags）当前包括 auth/items/sources/tasks/reports/settings。

---

## 8. 完整调用示例（PowerShell）

```powershell
$base = 'http://127.0.0.1:8787'

# 1) 登录
$login = Invoke-RestMethod -Method Post -Uri "$base/api/v1/auth/login" -ContentType 'application/json' -Body (@{
  username = 'admin'
  password = 'admin123'
} | ConvertTo-Json)
$token = $login.data.token
$headers = @{ Authorization = "Bearer $token" }

# 2) 触发一次采集
$run = Invoke-RestMethod -Method Post -Uri "$base/api/v1/tasks/fetch" -Headers $headers -ContentType 'application/json' -Body '{}'
Write-Host "runId = $($run.data.runId)"

# 3) 轮询运行详情
Start-Sleep -Seconds 3
$detail = Invoke-RestMethod -Uri "$base/api/v1/tasks/runs/$($run.data.runId)" -Headers $headers
$detail.data.status

# 4) 查询高危情报
Invoke-RestMethod -Uri "$base/api/v1/items?severity=critical&pageSize=5" -Headers $headers | ConvertTo-Json -Depth 6

# 5) 生成周报
$report = Invoke-RestMethod -Method Post -Uri "$base/api/v1/reports/generate" -Headers $headers -ContentType 'application/json' -Body (@{
  type = 'weekly'
} | ConvertTo-Json)
Write-Host "reportId = $($report.data.id)"

# 6) 下载 HTML 报告
Invoke-WebRequest -Uri "$base/api/v1/reports/$($report.data.id)/download?format=html" -Headers $headers -OutFile 'D:Knetsec_Aidataweekly.html'
```

---

## 9. 与 shared 类型的对应关系

| API 数据 | shared 类型 | 前端使用 |
|---|---|---|
| 登录响应 | `LoginResponse` | `stores/auth.ts` |
| 当前用户 | `AuthUser` | 路由守卫/菜单权限 |
| 情报 | `ItemDTO` | 列表、详情抽屉、报告 |
| 数据源 | `SourceDTO` | 数据源管理页 |
| 采集运行 | `RunDTO` | 任务页与仪表盘 |
| 报告 | `ReportDTO` / `ReportDetailDTO` | 报告中心/预览页 |
| 设置 | `SettingsDTO` | 设置页 |
| 审计 | `AuditLogDTO` | 审计页 |
| 仪表盘 | `DashboardSummary` | 仪表盘 |
| 分页 | `Paginated<T>` | 所有列表页 |

> `SystemInfoDTO` 与 `SchedulerStatus` 目前由服务端定义（`modules/system/index.ts`、`modules/core/context.ts`），尚未进入 shared 包；前端若引用需同步（已知差异，见《02》与《03》）。

---

## 10. 版本与兼容策略

1. 路径版本化：`/api/v1`；破坏性变更升 `/api/v2`，v1 只做向后兼容的字段追加；
2. 新增可选查询参数/可选响应字段不影响旧客户端；
3. 错误码枚举只增不改；文案可优化（前端不要依赖 message 做逻辑，应依赖 code）；
4. 鉴权方式（Bearer JWT）与信封结构在 v1 内保持不变；
5. 接口变更必须同步更新本文与 Swagger 注解，并在《02》需求矩阵中体现。

---

## 附录 A 枚举字典（与 `@knetsec/shared` 一致）

### A.1 情报分类 `category`

| 值 | 中文 | 说明 |
|---|---|---|
| `ai-security` | AI 安全 | 提示注入、Agent、RAG、模型供应链等 |
| `vuln` | 漏洞与补丁 | CVE/GHSA、厂商补丁公告 |
| `cyber` | 网络安全 | 攻击事件、APT、勒索、数据泄露 |
| `research` | 安全研究 | arXiv、实验室报告、方法论 |
| `tool` | 工具与项目 | 开源安全工具、项目发布 |
| `policy` | 政策与合规 | 法规、标准、监管动态 |
| `news` | 综合资讯 | 无法归入以上分类的资讯 |

### A.2 严重度 `severity`

| 值 | 中文 | 排序权重 |
|---|---|---|
| `critical` | 严重 | 5 |
| `high` | 高危 | 4 |
| `medium` | 中危 | 3 |
| `low` | 低危 | 2 |
| `info` | 信息 | 1 |
| `unknown` | 未知 | 0 |

### A.3 数据源分类与适配器

| 分类 `category` | 中文 |
|---|---|
| `github` | GitHub 平台 |
| `vuln-db` | 漏洞库 |
| `vendor` | 厂商公告 |
| `research` | 研究机构 |
| `media` | 安全媒体 |
| `community` | 社区与个人 |

| 适配器 `adapter` | 用途 |
|---|---|
| `github_advisories` | GitHub 安全公告（GHSA） |
| `github_search` | GitHub 仓库搜索 |
| `github_releases` | GitHub 仓库发布 |
| `nvd_cve` | NVD CVE 漏洞库 |
| `cisa_kev` | CISA 已知被利用漏洞 |
| `msrc_cvrf` | 微软 MSRC 安全公告 |
| `arxiv` | arXiv 论文 |
| `rss` | RSS / Atom 订阅 |
| `json_list` | 通用 JSON 列表接口 |
| `html_list` | 通用 HTML 列表页 |

### A.4 其他枚举

| 枚举 | 取值 |
|---|---|
| 报告类型 `report.type` | `daily` 日报、`weekly` 周报、`monthly` 月报、`custom` 自定义 |
| 运行状态 `run.status` | `running`、`success`、`partial`、`failed` |
| 触发方式 `run.trigger` | `manual` 手动、`schedule` 定时、`api` 接口 |
| 通知渠道 | `generic`、`wecom` 企微、`dingtalk` 钉钉、`feishu` 飞书 |
| 用户角色 | `admin` 管理员、`viewer` 只读 |
| 语言 `lang` | `zh`、`en`、`other` |

---

## 附录 B DTO 字段字典

### B.1 ItemDTO（情报条目）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | number | 自增主键 |
| `uid` | string | 去重键（sha256） |
| `sourceKey` / `sourceName` | string | 来源 key / 中文名（快照冗余） |
| `title` / `summary` / `url` / `author` | string/null | 内容字段，summary 为纯文本 |
| `publishedAt` / `fetchedAt` | string | ISO 时间；publishedAt 可能为 null |
| `category` / `severity` / `lang` | enum | 见附录 A |
| `tags` | string[] | AI 安全标签，如 `prompt-injection` |
| `cveIds` / `ghsaIds` | string[] | 漏洞编号数组 |
| `cvssScore` | number/null | CVSS 分值 |
| `isKev` | boolean | 是否在 CISA KEV |
| `vendor` | string/null | 厂商 |
| `isRead` / `isStarred` | boolean | 运营状态 |
| `importance` | number | 0-100 排序分 |

### B.2 SourceDTO（数据源）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `key` / `name` | number/string | 主键、稳定键、展示名 |
| `category` / `adapter` | enum | 见附录 A，创建后不可改 |
| `url` | string/null | 展示入口 |
| `config` | object | 适配器私有配置 |
| `enabled` | boolean | 是否启用 |
| `intervalMinutes` | number | 采集间隔（分钟） |
| `priority` | number | 越小越优先 |
| `lastRunAt` / `lastStatus` / `lastError` | string/null | 最近运行结果 |
| `successCount` / `failureCount` | number | 累计统计 |
| `createdAt` / `updatedAt` | string | ISO 时间 |

### B.3 RunDTO（采集运行）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `trigger` / `status` | number/enum | 运行标识与状态 |
| `startedAt` / `finishedAt` | string/null | 起止时间 |
| `sourcesTotal` / `sourcesOk` / `sourcesFailed` | number | 源统计 |
| `itemsNew` / `itemsDuplicate` | number | 条目新增/重复统计 |
| `error` | string/null | 顶层错误 |
| `logs` | string[] | 逐行日志（列表接口为空数组） |

### B.4 ReportDTO / ReportDetailDTO（报告）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `type` / `title` | number/enum/string | 标识与标题 |
| `periodStart` / `periodEnd` | string | 统计区间（ISO） |
| `itemCount` | number | 收录条目数 |
| `createdAt` / `createdBy` | string | 生成时间/生成人 |
| `preview` | string | Markdown 前 800 字符（列表用） |
| `markdown` / `html` | string | 详情专有，全文 |

### B.5 AuditLogDTO（审计）与 SettingsDTO（设置）

审计字段：`id`、`username`、`action`、`target`、`detail`（对象或 null）、`ip`、`createdAt`。
设置字段：`watchKeywords`、`aiSecurityKeywords`、`reportRangeDays`、`reportSections`、`notificationEnabled`、`notificationChannel`、`notificationWebhook`、`llmEnabled`、`llmBaseUrl`、`llmApiKey`（脱敏）、`llmModel`、`retentionDays`、`fetchIntervalMinutes`。

---

## 附录 C 调用侧常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 所有接口 401 | token 未带、过期或签名密钥变更（重启且未固定 `KNETSEC_JWT_SECRET` 时不会变；手动轮换会） | 重新登录；确认 `Authorization` 格式为 `Bearer <token>` |
| viewer 调用写接口 403 | 角色限制 | 换 admin 账号，或由管理员代操作 |
| 触发采集 409 | 已有任务在运行 | 等运行结束后重试；面板「采集任务」查看进度 |
| 触发采集 400「数据源不存在」 | `sourceKeys` 拼写错误或源已删除 | 先 `GET /sources` 获取 key |
| 新建源 409 | key 重复 | 换一个 key（key 是稳定标识，不要复用） |
| 导出乱码 | 用 Excel 直接打开 JSON/Markdown | CSV 带 BOM，用 Excel 打开 CSV 才不乱码 |
| 报告下载 400 | 请求 `format=html` 但该报告无 HTML 内容 | 用 `format=md`，或重新生成报告 |
| 列表查询很慢 | 关键词过宽（如单字符） | `q` 至少 2-3 个字符，叠加分类/时间筛选 |
| 时间筛选不符合预期 | 服务端用 UTC ISO 比较 | 前端传 ISO 字符串（dayjs 转 UTC），不要传本地无时区时间 |
| 响应 413 | 请求体超过 2 MB | 批量操作分批（单次 ≤ 500 条） |

---

## 附录 D 典型集成场景

### D.1 首次接入：从空库到可用面板

1. 启动服务，等待日志出现「服务已启动」与「种子数据已就绪」；
2. 用 `admin/admin123` 登录，前端会提示修改初始密码，先完成改密；
3. `GET /api/v1/sources` 确认默认数据源已登记（不可达的源保持停用）；
4. 对目标源调用 `POST /api/v1/sources/:id/test` 做试采，确认返回样本标题符合预期；
5. 调用 `POST /api/v1/tasks/fetch` 触发一轮采集，轮询运行详情直到 `success/partial`；
6. 打开情报中心，按「近 7 天 + 高危」筛选，确认条目已入库且可打开原文链接。

### D.2 每周运营：巡检、筛选、生成周报

1. 仪表盘查看 14 天趋势与严重度分布，确认本周新增量是否异常；
2. 情报中心按「重点关注 + 严重度」筛选，逐条判断并星标值得写的内容；
3. 调用 `POST /api/v1/reports/generate`（type=weekly）生成周报，前端跳转预览页；
4. 预览 Markdown/HTML，补充人工点评后下载 HTML 打印或复制 Markdown 到发布工具；
5. 在报告中心保留该周报，作为后续复盘与统计的依据。

### D.3 新增一个媒体源（无需改代码）

1. `POST /api/v1/sources`，adapter 选 `rss`，config 至少包含 `url`；
2. 调用试采接口验证解析结果；若标题为空或条数为 0，检查 feed 地址与 `maxItems`；
3. 试采通过后启用该源，等待下一轮调度或手动触发采集；
4. 观察运行日志中该源的 warnings，必要时调整 `keepDays` 与采集间隔。

### D.4 排障：某源连续失败

1. `GET /api/v1/sources` 找到 `lastStatus=failed` 的源与 `lastError` 摘要；
2. 对该源调用试采，拿到错误类型（超时/403/解析失败）；
3. 若是限流，补 Token 或调大间隔；若是网络，配置代理；若是解析，停用该源并记录问题；
4. 修复后重新试采，再触发一次只包含该源的采集（`sourceKeys` 精准定位）；
5. 确认运行记录为 success 后，把该源恢复为启用状态。

### D.5 权限与审计核对

1. 用 admin 登录，执行一次「新增源 → 改设置 → 生成报告」；
2. 打开审计页面或 `GET /api/v1/audit-logs`，应能看到 `source.create`、`settings.update`、`report.generate` 三条记录；
3. 用 viewer 账号（若已配置）尝试写操作，应得到 403，且审计无新增写记录；
4. 核对审计 detail 中不包含密码、Token、Webhook 明文，确认脱敏策略生效。

---

## 附录 E 接口安全与性能说明

### E.1 鉴权与越权防护

接口层采用「统一守卫 + 路由声明」的方式：除登录、健康检查与接口文档外，所有路由都挂载登录守卫；写操作再叠加管理员守卫。守卫每次请求都会回查数据库中的用户记录，因此管理员被删除或降权后，旧 Token 会立即失效，而不是等到 12 小时过期。这样做增加了一次主键查询，但换来权限的实时性，代价可以忽略。

前端隐藏按钮只是体验优化，不是安全边界：即使绕过页面直接构造请求，服务端仍会返回 403；这一点在验收时应专门用 viewer 角色验证。

### E.2 数据暴露面控制

响应中不返回密码哈希、JWT 密钥、原始采集快照与完整 Webhook。系统设置接口只返回脱敏后的 Key，更新时传空值或脱敏值都视为「保持原值」，避免前端把脱敏串回写覆盖真实密钥。审计详情只记录字段名与对象标识，不记录密钥、密码、Webhook 的值。健康检查不返回任何配置，系统信息中的绝对路径只对已登录用户可见，适合本机单租户场景；若部署到公网，应限制可登录人员范围。

### E.3 大结果集与慢请求

分页上限固定为 100，导出接口单独限制 5000 条，报告素材限制 2000 条，批量操作限制 500 条，从协议层避免一次请求把内存与网络打满。试采与报告生成可能耗时较长，前端超时设置为 20 秒，但服务端为试采预留 60 秒、反向代理为 API 预留 120 秒读超时，避免「前端已超时、后端仍在写库」造成状态不一致。采集触发采用 202 + 异步执行，HTTP 连接不承担采集时长。

### E.4 幂等与并发

标记已读、批量操作是幂等的，重复调用结果一致；采集触发是非幂等的，因此用「内存锁 + 数据库 running 检查」双重互斥，重复触发返回 409 而不是排队。报告生成是非幂等的，前端需要防重复提交；数据源 key 唯一约束保证不会出现两个语义相同的源。这些约束共同保证在多标签页、误双击、调度与手动触发并发时，系统状态仍然可控。

### E.5 版本兼容

路径版本化是唯一的破坏性变更手段；同一版本内只允许追加可选字段与可选参数。错误码是稳定契约，前端分支逻辑应依赖 code 而不是 message 文案。接口文档与 Swagger 注解同源维护，任何字段调整必须同步更新本文件，否则视为文档缺陷。

---

## 11. 变更记录

| 版本 | 日期 | 变更人 | 说明 |
|---|---|---|---|
| v1.0 | 2026-11-17 | docs-deploy | 首版：按 modules 实际路由逐条整理认证、情报、数据源、任务、报告、设置、审计、系统与文档端点 |
