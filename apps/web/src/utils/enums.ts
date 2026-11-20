/**
 * 共享枚举到界面展示的映射表。
 *
 * 为什么单独一层：颜色、Tag 类型属于「界面决策」，不应污染 @knetsec/shared 的领域契约；
 * 但中文文案来自 shared 字典，保证前后端与报告用词一致。
 */
import {
  ADAPTER_IDS,
  ADAPTER_LABELS,
  ITEM_CATEGORIES,
  ITEM_CATEGORY_LABELS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_CHANNEL_LABELS,
  REPORT_TYPES,
  REPORT_TYPE_LABELS,
  SEVERITIES,
  SEVERITY_LABELS,
  SOURCE_CATEGORIES,
  SOURCE_CATEGORY_LABELS,
  type AdapterId,
  type ItemCategory,
  type NotificationChannel,
  type ReportType,
  type RunStatus,
  type RunTrigger,
  type Severity,
  type SourceCategory,
} from '@knetsec/shared';

/** Element Plus Tag 支持的语义色。 */
type TagType = 'primary' | 'success' | 'info' | 'warning' | 'danger';

/** 严重度对应的 Tag 颜色：严重=红、高危=橙、中危=蓝、低危=绿。 */
export const SEVERITY_TAG_TYPES: Record<Severity, TagType> = {
  critical: 'danger',
  high: 'warning',
  medium: 'primary',
  low: 'success',
  info: 'info',
  unknown: 'info',
};

/** 严重度的数字权重（与 shared 一致，用于前端稳定排序展示）。 */
export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 6,
  high: 5,
  medium: 4,
  low: 3,
  info: 2,
  unknown: 1,
};

/** 下拉选项通用结构。 */
export interface EnumOption<T extends string> {
  value: T;
  label: string;
}

/** 严重度下拉选项。 */
export const SEVERITY_OPTIONS: Array<EnumOption<Severity>> = SEVERITIES.map((value) => ({
  value,
  label: SEVERITY_LABELS[value],
}));

/** 情报分类下拉选项。 */
export const CATEGORY_OPTIONS: Array<EnumOption<ItemCategory>> = ITEM_CATEGORIES.map((value) => ({
  value,
  label: ITEM_CATEGORY_LABELS[value],
}));

/** 数据源分类下拉选项。 */
export const SOURCE_CATEGORY_OPTIONS: Array<EnumOption<SourceCategory>> = SOURCE_CATEGORIES.map((value) => ({
  value,
  label: SOURCE_CATEGORY_LABELS[value],
}));

/** 适配器下拉选项。 */
export const ADAPTER_OPTIONS: Array<EnumOption<AdapterId>> = ADAPTER_IDS.map((value) => ({
  value,
  label: ADAPTER_LABELS[value],
}));

/** 报告类型下拉选项。 */
export const REPORT_TYPE_OPTIONS: Array<EnumOption<ReportType>> = REPORT_TYPES.map((value) => ({
  value,
  label: REPORT_TYPE_LABELS[value],
}));

/** 通知渠道下拉选项。 */
export const NOTIFICATION_CHANNEL_OPTIONS: Array<EnumOption<NotificationChannel>> = NOTIFICATION_CHANNELS.map(
  (value) => ({ value, label: NOTIFICATION_CHANNEL_LABELS[value] }),
);

/** 采集任务状态展示元数据。 */
export const RUN_STATUS_META: Record<RunStatus, { label: string; type: TagType }> = {
  running: { label: '运行中', type: 'primary' },
  success: { label: '成功', type: 'success' },
  partial: { label: '部分成功', type: 'warning' },
  failed: { label: '失败', type: 'danger' },
};

/** 采集触发来源中文名。 */
export const RUN_TRIGGER_LABELS: Record<RunTrigger, string> = {
  manual: '手动',
  schedule: '定时',
  api: '接口',
};

/** 审计动作到中文名的映射；未收录的动作直接展示原始英文，避免漏报。 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'auth.login': '登录',
  'auth.change_password': '修改密码',
  'settings.update': '更新设置',
  'source.create': '新建数据源',
  'source.update': '修改数据源',
  'source.delete': '删除数据源',
  'source.enable': '启用数据源',
  'source.disable': '停用数据源',
  'source.test': '试采数据源',
  'items.mark_read': '批量标记已读',
  'items.mark_unread': '批量标记未读',
  'items.star': '批量星标',
  'items.unstar': '批量取消星标',
  'items.delete': '批量删除情报',
  'tasks.fetch': '触发采集',
  'report.generate': '生成报告',
  'report.delete': '删除报告',
};

/**
 * 各适配器的配置示例。
 *
 * 为什么内置示例而不是空输入框：config 是 JSON 结构，运营人员很难凭记忆填写；
 * 给出可直接改的模板能显著降低新建数据源的出错率。
 */
export const ADAPTER_CONFIG_TEMPLATES: Record<AdapterId, string> = {
  github_advisories: JSON.stringify(
    { perPage: 50, severities: ['critical', 'high'], ecosystems: ['pip', 'npm'], days: 30 },
    null,
    2,
  ),
  github_search: JSON.stringify(
    { query: 'topic:ai-security stars:>50', sort: 'updated', perPage: 20 },
    null,
    2,
  ),
  github_releases: JSON.stringify(
    { repos: ['vllm-project/vllm', 'langchain-ai/langchain'], perRepo: 5 },
    null,
    2,
  ),
  nvd_cve: JSON.stringify(
    { keywords: ['large language model', 'prompt injection'], days: 7, minCvss: 7 },
    null,
    2,
  ),
  cisa_kev: JSON.stringify({ days: 30 }, null, 2),
  msrc_cvrf: JSON.stringify({ maxDocuments: 5, includeSeverities: ['Critical', 'Important'] }, null, 2),
  arxiv: JSON.stringify({ categories: ['cs.CR'], keywords: ['llm security'], maxResults: 30 }, null, 2),
  rss: JSON.stringify({ url: 'https://example.com/feed.xml', maxItems: 30, keepDays: 30 }, null, 2),
  json_list: JSON.stringify(
    {
      url: 'https://example.com/api/items',
      itemsPath: 'data.items',
      fieldMap: { title: 'name', url: 'link', publishedAt: 'date' },
    },
    null,
    2,
  ),
  html_list: JSON.stringify(
    {
      url: 'https://example.com/list',
      itemSelector: 'table.list tr',
      titleSelector: 'a',
      linkSelector: 'a',
      dateSelector: 'td:last-child',
    },
    null,
    2,
  ),
};
