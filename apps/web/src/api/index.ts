/**
 * API 调用矩阵：按业务域分组，页面只依赖本文件，不直接拼 URL。
 *
 * 为什么这样组织：
 * 1. URL 与 HTTP 方法集中可见，便于对照 docs/09-API接口文档.md 评审；
 * 2. 请求/响应类型全部来自 @knetsec/shared，前后端编译期即校验契约；
 * 3. 少数契约尚未固化到 shared 的接口（调度器状态、系统信息）在本文件内定义
 *    最小只读视图类型，并在字段上保持宽松，避免后端字段微调导致面板白屏。
 */
import {
  type AuditLogDTO,
  type AuthUser,
  type BulkItemInput,
  type ChangePasswordRequest,
  type CreateSourceInput,
  type DashboardSummary,
  type GenerateReportInput,
  type ItemDTO,
  type ItemListQuery,
  type ItemListResult,
  type LoginRequest,
  type LoginResponse,
  type Paginated,
  type ReportDTO,
  type ReportDetailDTO,
  type ReportListQuery,
  type ReportType,
  type RunDTO,
  type SettingsDTO,
  type SourceDTO,
  type SourceTestResult,
  type StartFetchInput,
  type StartFetchResult,
  type UpdateItemInput,
  type UpdateSettingsInput,
  type UpdateSourceInput,
} from '@knetsec/shared';
import { downloadFile, request } from './client';

/** 构建查询参数：去掉空字符串、undefined，避免服务端把它当成有效筛选值。 */
function cleanParams(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    result[key] = value;
  }
  return result;
}

/** 情报导出格式。 */
export type ExportFormat = 'csv' | 'json' | 'markdown';

// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------
export const authApi = {
  /**
   * 登录。
   *
   * @param payload 用户名密码
   * @param silent 是否静默失败（登录页自行展示行内错误，避免弹两次提示）
   */
  login(payload: LoginRequest, silent = false): Promise<LoginResponse> {
    return request<LoginResponse>({ url: '/auth/login', method: 'post', data: payload, silent });
  },
  me(): Promise<AuthUser> {
    return request<AuthUser>({ url: '/auth/me', method: 'get' });
  },
  changePassword(payload: ChangePasswordRequest): Promise<void> {
    return request<void>({ url: '/auth/change-password', method: 'post', data: payload });
  },
};

// ---------------------------------------------------------------------------
// 仪表盘
// ---------------------------------------------------------------------------
export const dashboardApi = {
  summary(): Promise<DashboardSummary> {
    return request<DashboardSummary>({ url: '/dashboard/summary', method: 'get' });
  },
};

// ---------------------------------------------------------------------------
// 情报条目
// ---------------------------------------------------------------------------
export const itemsApi = {
  list(query: ItemListQuery): Promise<ItemListResult> {
    return request<ItemListResult>({ url: '/items', method: 'get', params: cleanParams({ ...query }) });
  },
  detail(id: number): Promise<ItemDTO> {
    return request<ItemDTO>({ url: `/items/${id}`, method: 'get' });
  },
  update(id: number, input: UpdateItemInput): Promise<ItemDTO> {
    return request<ItemDTO>({ url: `/items/${id}`, method: 'patch', data: input });
  },
  bulk(input: BulkItemInput): Promise<void> {
    return request<void>({ url: '/items/bulk', method: 'post', data: input });
  },
  /** 按当前筛选条件导出，浏览器直接下载。 */
  exportItems(format: ExportFormat, query: ItemListQuery): Promise<void> {
    return downloadFile(
      '/items/export',
      cleanParams({ ...query, format }),
      `knetsec-items-${Date.now()}.${format === 'markdown' ? 'md' : format}`,
    );
  },
};

// ---------------------------------------------------------------------------
// 数据源
// ---------------------------------------------------------------------------
export const sourcesApi = {
  /** 服务端契约是数组；同时兼容分页外壳，避免后端改用 Paginated 后前端崩溃。 */
  async list(): Promise<SourceDTO[]> {
    const data = await request<SourceDTO[] | Paginated<SourceDTO>>({ url: '/sources', method: 'get' });
    return Array.isArray(data) ? data : data.items;
  },
  create(input: CreateSourceInput): Promise<SourceDTO> {
    return request<SourceDTO>({ url: '/sources', method: 'post', data: input });
  },
  update(id: number, input: UpdateSourceInput): Promise<SourceDTO> {
    return request<SourceDTO>({ url: `/sources/${id}`, method: 'patch', data: input });
  },
  remove(id: number): Promise<void> {
    return request<void>({ url: `/sources/${id}`, method: 'delete' });
  },
  /** 启停走 PATCH 的 enabled 字段：幂等，避免与 toggle 端点的“翻转语义”产生竞态。 */
  setEnabled(id: number, enabled: boolean): Promise<SourceDTO> {
    return request<SourceDTO>({ url: `/sources/${id}`, method: 'patch', data: { enabled } });
  },
  test(id: number): Promise<SourceTestResult> {
    return request<SourceTestResult>({ url: `/sources/${id}/test`, method: 'post' });
  },
};

// ---------------------------------------------------------------------------
// 采集任务
// ---------------------------------------------------------------------------

/**
 * 调度器定时任务状态（与后端 modules/core/context.ts 的 SchedulerJobStatus 对齐）。
 *
 * shared 契约未固化这两个结构，因此在本文件内以只读视图类型声明；字段命名与后端一致，
 * 后端后续若把结构提升进 shared，只需删除这里的定义并改为 import。
 */
export interface SchedulerJobStatus {
  /** 任务名称（中文），例如「到期数据源扫描」 */
  name: string;
  /** cron 表达式，排障用 */
  cron: string;
  /** 下一次触发时间；调度器未启动时为 null */
  nextRunAt: string | null;
}

/** 到期数据源：调度器按 last_run_at + interval 算出的应采集候选。 */
export interface SchedulerDueSource {
  key: string;
  name: string;
  lastRunAt: string | null;
  /** 应采集时间（ISO） */
  dueAt: string;
  intervalMinutes: number;
}

/** 调度器状态快照（GET /tasks/status 与 /system/info 内的 scheduler 字段）。 */
export interface SchedulerStatus {
  /** 调度器是否启动 */
  enabled: boolean;
  jobs: SchedulerJobStatus[];
  /** 当前运行中的采集任务 id，无则为 null */
  runningRunId: number | null;
  /** 前 10 个到期数据源 */
  dueSources: SchedulerDueSource[];
}

/** 采集任务触发结果。 */
export interface TaskFetchResult extends StartFetchResult {
  /** 服务端可能直接回运行中状态，该字段仅用于展示。 */
  message?: string;
}

export const tasksApi = {
  startFetch(input: StartFetchInput): Promise<TaskFetchResult> {
    return request<TaskFetchResult>({ url: '/tasks/fetch', method: 'post', data: input });
  },
  runs(page: number, pageSize: number): Promise<Paginated<RunDTO>> {
    return request<Paginated<RunDTO>>({ url: '/tasks/runs', method: 'get', params: { page, pageSize } });
  },
  run(id: number): Promise<RunDTO> {
    return request<RunDTO>({ url: `/tasks/runs/${id}`, method: 'get' });
  },
  status(): Promise<SchedulerStatus> {
    return request<SchedulerStatus>({ url: '/tasks/status', method: 'get', silent: true });
  },
};

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
export const reportsApi = {
  list(query: ReportListQuery): Promise<Paginated<ReportDTO>> {
    return request<Paginated<ReportDTO>>({
      url: '/reports',
      method: 'get',
      params: cleanParams({ ...query }),
    });
  },
  generate(input: GenerateReportInput): Promise<ReportDTO> {
    return request<ReportDTO>({ url: '/reports/generate', method: 'post', data: input });
  },
  detail(id: number): Promise<ReportDetailDTO> {
    return request<ReportDetailDTO>({ url: `/reports/${id}`, method: 'get' });
  },
  remove(id: number): Promise<void> {
    return request<void>({ url: `/reports/${id}`, method: 'delete' });
  },
  download(id: number, format: 'md' | 'html', type: ReportType): Promise<void> {
    const suffix = format === 'md' ? 'md' : 'html';
    return downloadFile(`/reports/${id}/download`, { format }, `Knetsec_Ai-${type}-${id}.${suffix}`);
  },
};

// ---------------------------------------------------------------------------
// 系统设置
// ---------------------------------------------------------------------------
export const settingsApi = {
  get(): Promise<SettingsDTO> {
    return request<SettingsDTO>({ url: '/settings', method: 'get' });
  },
  update(input: UpdateSettingsInput): Promise<SettingsDTO> {
    return request<SettingsDTO>({ url: '/settings', method: 'put', data: input });
  },
};

// ---------------------------------------------------------------------------
// 审计日志
// ---------------------------------------------------------------------------

/** 审计查询条件：契约未固化为 DTO，服务端按支持则过滤、不支持则忽略。 */
export interface AuditLogQuery {
  page?: number;
  pageSize?: number;
  username?: string;
  action?: string;
}

export const auditApi = {
  list(query: AuditLogQuery): Promise<Paginated<AuditLogDTO>> {
    return request<Paginated<AuditLogDTO>>({
      url: '/audit-logs',
      method: 'get',
      params: cleanParams({ ...query }),
    });
  },
};

// ---------------------------------------------------------------------------
// 系统信息
// ---------------------------------------------------------------------------

/**
 * 系统信息（GET /system/info）。
 *
 * 与后端 modules/system/index.ts 的 SystemInfoDTO 一一对齐；展示层只使用 version /
 * uptimeSeconds / counts.sourcesEnabled / scheduler，其余字段保留给后续「系统信息」页扩展。
 */
export interface SystemInfo {
  appName: string;
  version: string;
  env: string;
  nodeVersion: string;
  startedAt: string;
  uptimeSeconds: number;
  dataDir: string;
  dbPath: string;
  /** SQLite 主库文件大小（字节） */
  dbSizeBytes: number;
  counts: {
    items: number;
    sources: number;
    sourcesEnabled: number;
    reports: number;
    runs: number;
  };
  scheduler: SchedulerStatus;
}

export const systemApi = {
  /** 侧边栏底部展示版本/运行时长；失败静默，不影响主流程。 */
  info(): Promise<SystemInfo> {
    return request<SystemInfo>({ url: '/system/info', method: 'get', silent: true });
  },
};
