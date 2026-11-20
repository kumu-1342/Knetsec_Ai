/**
 * REST API 契约（前后端共享）。
 *
 * 约定：
 * - 所有接口返回 { success, data | error, requestId } 信封，分页数据统一为 Paginated<T>；
 * - 时间字段一律 ISO 8601 字符串（带时区），由服务端统一 toISOString()；
 * - 写接口只允许 admin 角色，viewer 只读；
 * - 字段变更必须同步更新 docs/09-API接口文档.md 与 apps/web 的类型引用。
 */
import type {
  AdapterId,
  ItemCategory,
  NotificationChannel,
  ReportType,
  RunStatus,
  RunTrigger,
  Severity,
  SourceCategory,
  UserRole,
} from './domain.js';

/** 成功信封。 */
export interface ApiSuccess<T> {
  success: true;
  data: T;
  requestId: string;
}

/** 失败信封：code 供前端做分支处理，message 面向用户。 */
export interface ApiFailure {
  success: false;
  error: { code: ApiErrorCode; message: string; details?: unknown };
  requestId: string;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'UPSTREAM_ERROR',
  'INTERNAL_ERROR',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** 通用分页结构。 */
export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------
export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  /** token 有效期（秒） */
  expiresIn: number;
  user: AuthUser;
}

export interface ChangePasswordRequest {
  oldPassword: string;
  newPassword: string;
}

// ---------------------------------------------------------------------------
// 情报条目
// ---------------------------------------------------------------------------
export interface ItemDTO {
  id: number;
  uid: string;
  sourceKey: string;
  sourceName: string;
  title: string;
  summary: string | null;
  url: string | null;
  author: string | null;
  publishedAt: string | null;
  fetchedAt: string;
  category: ItemCategory;
  tags: string[];
  severity: Severity;
  cveIds: string[];
  ghsaIds: string[];
  cvssScore: number | null;
  isKev: boolean;
  vendor: string | null;
  lang: string;
  isRead: boolean;
  isStarred: boolean;
  importance: number;
}

export interface ItemListQuery {
  page?: number;
  pageSize?: number;
  q?: string;
  category?: ItemCategory;
  severity?: Severity;
  sourceKey?: string;
  /** ISO 时间，闭区间 */
  from?: string;
  to?: string;
  read?: boolean;
  starred?: boolean;
  /** 仅看重点关注（命中 watchKeywords） */
  watched?: boolean;
  sort?: 'published_at' | 'fetched_at' | 'severity' | 'importance';
  order?: 'asc' | 'desc';
}

export interface ItemListResult extends Paginated<ItemDTO> {}

export interface UpdateItemInput {
  isRead?: boolean;
  isStarred?: boolean;
}

export interface BulkItemInput {
  ids: number[];
  action: 'mark_read' | 'mark_unread' | 'star' | 'unstar' | 'delete';
}

// ---------------------------------------------------------------------------
// 数据源
// ---------------------------------------------------------------------------
export interface SourceDTO {
  id: number;
  key: string;
  name: string;
  category: SourceCategory;
  adapter: AdapterId;
  url: string | null;
  config: Record<string, unknown>;
  enabled: boolean;
  intervalMinutes: number;
  priority: number;
  lastRunAt: string | null;
  lastStatus: RunStatus | null;
  lastError: string | null;
  successCount: number;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSourceInput {
  key: string;
  name: string;
  category: SourceCategory;
  adapter: AdapterId;
  url?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
  intervalMinutes?: number;
  priority?: number;
}

/** 更新数据源：key / adapter 一般不允许修改，服务端会做校验。 */
export type UpdateSourceInput = Partial<CreateSourceInput>;

export interface SourceTestResult {
  ok: boolean;
  adapter: AdapterId;
  fetched: number;
  durationMs: number;
  /** 前 5 条标题预览 */
  sample: string[];
  error: string | null;
}

// ---------------------------------------------------------------------------
// 采集任务
// ---------------------------------------------------------------------------
export interface RunDTO {
  id: number;
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  sourcesTotal: number;
  sourcesOk: number;
  sourcesFailed: number;
  itemsNew: number;
  itemsDuplicate: number;
  error: string | null;
  logs: string[];
}

export interface StartFetchInput {
  /** 为空表示采集全部启用的数据源 */
  sourceKeys?: string[];
}

export interface StartFetchResult {
  runId: number;
  status: RunStatus;
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
export interface ReportDTO {
  id: number;
  type: ReportType;
  title: string;
  periodStart: string;
  periodEnd: string;
  itemCount: number;
  createdAt: string;
  createdBy: string;
  /** 列表页展示用的 Markdown 前 800 字符 */
  preview: string;
}

export interface ReportDetailDTO extends ReportDTO {
  markdown: string;
  html: string;
}

export interface GenerateReportInput {
  type?: ReportType;
  /** 不传则按 type 自动推断区间（周报=最近 7 天） */
  periodStart?: string;
  periodEnd?: string;
  title?: string;
  /** 只针对指定情报生成专题报告 */
  itemIds?: number[];
}

export interface ReportListQuery {
  page?: number;
  pageSize?: number;
  type?: ReportType;
}

// ---------------------------------------------------------------------------
// 仪表盘
// ---------------------------------------------------------------------------
export interface DashboardTotals {
  items: number;
  itemsToday: number;
  items7d: number;
  unread: number;
  critical7d: number;
  sources: number;
  sourcesEnabled: number;
  reports: number;
}

export interface DashboardSummary {
  totals: DashboardTotals;
  severityDistribution: Array<{ severity: Severity; count: number }>;
  categoryDistribution: Array<{ category: ItemCategory; count: number }>;
  sourceDistribution: Array<{ sourceKey: string; sourceName: string; count: number }>;
  /** 最近 14 天按天趋势 */
  trend: Array<{ date: string; total: number; aiSecurity: number; vuln: number }>;
  latestItems: ItemDTO[];
  recentRuns: RunDTO[];
}

// ---------------------------------------------------------------------------
// 系统设置
// ---------------------------------------------------------------------------
export interface SettingsDTO {
  watchKeywords: string[];
  aiSecurityKeywords: string[];
  reportRangeDays: number;
  reportSections: ItemCategory[];
  notificationEnabled: boolean;
  notificationChannel: NotificationChannel;
  notificationWebhook: string;
  llmEnabled: boolean;
  llmBaseUrl: string;
  /** 脱敏后的 Key，例如 sk-****abcd */
  llmApiKey: string;
  llmModel: string;
  retentionDays: number;
  fetchIntervalMinutes: number;
}

/** 更新设置：llmApiKey 传空字符串表示保持原值。 */
export type UpdateSettingsInput = Partial<SettingsDTO>;

// ---------------------------------------------------------------------------
// 审计日志
// ---------------------------------------------------------------------------
export interface AuditLogDTO {
  id: number;
  username: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}
