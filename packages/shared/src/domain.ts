/**
 * Knetsec_Ai 领域字典。
 *
 * 本文件是前后端、数据库、采集器共用的「唯一事实来源」：
 * - 数据库里的 category / severity / adapter 等字段，只允许取本文件枚举中的值；
 * - 前端的中文标签、颜色映射统一引用 {@link ITEM_CATEGORY_LABELS} 等字典；
 * - 新增枚举值时必须同步数据库迁移脚本与文档（docs/00-项目总览与架构契约.md）。
 */

/** 情报条目的业务分类（信息架构的第一维度）。 */
export const ITEM_CATEGORIES = [
  'ai-security',
  'vuln',
  'cyber',
  'research',
  'tool',
  'policy',
  'news',
] as const;

export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

/** 分类的中文展示名，管理面板与报告模板都使用它，避免多处硬编码。 */
export const ITEM_CATEGORY_LABELS: Record<ItemCategory, string> = {
  'ai-security': 'AI 安全',
  vuln: '漏洞与补丁',
  cyber: '网络安全',
  research: '安全研究',
  tool: '工具与项目',
  policy: '政策与合规',
  news: '综合资讯',
};

/** 严重程度（与 CVSS 分值、KEV 标记联动推导，允许人工校正）。 */
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info', 'unknown'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: '严重',
  high: '高危',
  medium: '中危',
  low: '低危',
  info: '信息',
  unknown: '未知',
};

/** 严重度排序权重：数值越大越严重，用于 SQL / 前端排序。 */
export const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
  unknown: 0,
};

/** 数据源类别，决定管理面板的分组与默认采集频率。 */
export const SOURCE_CATEGORIES = [
  'github',
  'vuln-db',
  'vendor',
  'research',
  'media',
  'community',
] as const;
export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

export const SOURCE_CATEGORY_LABELS: Record<SourceCategory, string> = {
  github: 'GitHub 平台',
  'vuln-db': '漏洞库',
  vendor: '厂商公告',
  research: '研究机构',
  media: '安全媒体',
  community: '社区与个人',
};

/**
 * 采集器适配器 ID。
 *
 * 每新增一个适配器，必须同时在 apps/server/src/collectors/index.ts 注册，
 * 并在 docs/04-数据源接入与采集设计.md 中补充说明。
 */
export const ADAPTER_IDS = [
  'github_advisories',
  'github_search',
  'github_releases',
  'nvd_cve',
  'cisa_kev',
  'msrc_cvrf',
  'arxiv',
  'rss',
  'json_list',
  'html_list',
] as const;
export type AdapterId = (typeof ADAPTER_IDS)[number];

export const ADAPTER_LABELS: Record<AdapterId, string> = {
  github_advisories: 'GitHub 安全公告库（GHSA）',
  github_search: 'GitHub 仓库搜索',
  github_releases: 'GitHub 仓库发布',
  nvd_cve: 'NVD CVE 漏洞库',
  cisa_kev: 'CISA 已知被利用漏洞',
  msrc_cvrf: '微软 MSRC 安全公告',
  arxiv: 'arXiv 论文',
  rss: 'RSS / Atom 订阅',
  json_list: '通用 JSON 列表接口',
  html_list: '通用 HTML 列表页',
};

/** 报告类型：日报 / 周报 / 月报 / 自定义区间。 */
export const REPORT_TYPES = ['daily', 'weekly', 'monthly', 'custom'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  daily: '日报',
  weekly: '周报',
  monthly: '月报',
  custom: '自定义报告',
};

/** 用户角色：admin 可写、viewer 只读。 */
export const USER_ROLES = ['admin', 'viewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** 情报列表允许的排序字段。 */
export const ITEM_SORT_FIELDS = ['published_at', 'fetched_at', 'severity', 'importance'] as const;
export type ItemSortField = (typeof ITEM_SORT_FIELDS)[number];

/** 采集任务触发来源。 */
export const RUN_TRIGGERS = ['manual', 'schedule', 'api'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** 采集任务状态机：running -> success | partial | failed。 */
export const RUN_STATUSES = ['running', 'success', 'partial', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** 通知渠道（Webhook 报文格式不同，但都是 POST JSON）。 */
export const NOTIFICATION_CHANNELS = ['generic', 'wecom', 'dingtalk', 'feishu'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_CHANNEL_LABELS: Record<NotificationChannel, string> = {
  generic: '通用 JSON Webhook',
  wecom: '企业微信机器人',
  dingtalk: '钉钉机器人',
  feishu: '飞书机器人',
};
