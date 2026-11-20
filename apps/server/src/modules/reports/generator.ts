/**
 * 报告内容生成器：把情报集合组织成可直接发布的中文 Markdown（契约 §9）。
 *
 * 设计原则：
 * - 纯函数：只依赖入参（items/settings/period），不读写数据库，便于单测与复用；
 * - 章节顺序取 settings.reportSections（管理员可裁剪），每章按「KEV > severity > importance > 时间」排序；
 * - 每章最多 30 条，超出提示去面板查看，避免日报/周报变成流水账；
 * - 所有外部文本先做单行化与表格转义（Markdown 注入防护的第一层，HTML 层仍会全量转义）。
 */
import {
  APP_NAME,
  ITEM_CATEGORY_LABELS,
  REPORT_SECTIONS,
  REPORT_TYPE_LABELS,
  SEVERITY_LABELS,
  SEVERITY_WEIGHT,
  type AppSettings,
  type ItemCategory,
  type ItemDTO,
  type ReportType,
} from '@knetsec/shared';

/** 每章最多展示条数（契约 §9）。 */
export const MAX_ITEMS_PER_SECTION = 30;
/** 「本周速览」条数。 */
const OVERVIEW_COUNT = 5;

/** 报告构建入参。 */
export interface ReportBuildInput {
  items: ItemDTO[];
  type: ReportType;
  /** ISO 8601 区间起点（含）。 */
  periodStart: string;
  /** ISO 8601 区间终点（含）。 */
  periodEnd: string;
  /** 自定义标题；缺省按类型自动生成。 */
  title?: string;
  settings: AppSettings;
  /** 生成时间（测试注入固定值，避免快照不稳定）。 */
  now?: Date;
}

/** 报告构建结果。 */
export interface ReportBuildResult {
  title: string;
  markdown: string;
  itemCount: number;
}

/** 补零。 */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** ISO 时间 → 本地 YYYY-MM-DD；非法值退化为字符串前 10 位。 */
export function formatReportDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** ISO 时间 → 本地 YYYY-MM-DD HH:mm。 */
function formatDateTime(iso: string | null): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${formatReportDate(iso)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 清洗上游文本中的 Markdown 语法。
 *
 * 为什么需要：GitHub Advisory 的 summary 里常带 "### Impact""**bold**" 等 Markdown，
 * 直接写进报告会出现裸露的 ### 与 **，既影响可读性，也可能破坏报告的标题层级。
 * 这里只做保守清理（代码块/行内代码/强调/标题/链接/分隔线），不改变正文语义。
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-*_]{3,}\s*$/gm, ' ')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 单行化 + 去 Markdown + 转义 HTML 特殊字符 + 限制长度。
 *
 * 为什么要转义 < 和 >：NVD 的标题常带版本范围（如 ">= V11.15.0 = V11.12.6 < V11.12.7"），
 * 裸的 < 会被 Markdown 解析器当成 HTML 标签起始，导致加粗/链接解析错乱（实测踩过）。
 * 转义为 &lt;/&gt; 后，Markdown 阅读器与 HTML 渲染都能正确显示。
 */
function inlineText(text: string | null | undefined, maxLength = 200): string {
  if (!text) return '';
  return stripMarkdown(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .slice(0, maxLength);
}

/** 摘要压缩：去掉链接/多余空白，按句号截断到指定长度。 */
function shortSummary(item: ItemDTO, maxLength: number): string {
  const summary = inlineText(item.summary, maxLength * 2);
  if (summary.length <= maxLength) return summary;
  return `${summary.slice(0, maxLength)}…`;
}

/** 报告默认标题（周报格式与契约 §9 完全一致）。 */
export function defaultReportTitle(type: ReportType, periodStart: string, periodEnd: string): string {
  return `${APP_NAME} AI 安全与网络安全${REPORT_TYPE_LABELS[type]}（${formatReportDate(periodStart)} ~ ${formatReportDate(periodEnd)}）`;
}

/** 排序：KEV 优先，其次 severity 权重、importance、时间倒序。 */
export function compareReportItems(a: ItemDTO, b: ItemDTO): number {
  if (a.isKev !== b.isKev) return a.isKev ? -1 : 1;
  const severityDiff = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
  if (severityDiff !== 0) return severityDiff;
  if (b.importance !== a.importance) return b.importance - a.importance;
  return (b.publishedAt ?? b.fetchedAt).localeCompare(a.publishedAt ?? a.fetchedAt);
}

/** 条目的编号展示（CVE 优先，其次 GHSA）。 */
function itemIds(item: ItemDTO): string {
  const ids = [...item.cveIds, ...item.ghsaIds];
  return ids.length > 0 ? ids.join('、') : '—';
}

/** 渲染「本周速览」。 */
function renderOverview(items: ItemDTO[]): string[] {
  const top = [...items].sort(compareReportItems).slice(0, OVERVIEW_COUNT);
  if (top.length === 0) return ['本期没有新增情报。'];
  const lines: string[] = [];
  top.forEach((item, index) => {
    const flags = [SEVERITY_LABELS[item.severity]];
    if (item.isKev) flags.push('KEV 在野利用');
    const summary = shortSummary(item, 100);
    lines.push(
      `${index + 1}. **${inlineText(item.title, 180)}**（${flags.join('，')}）${summary ? `——${summary}` : ''}`,
    );
    lines.push(
      `   > 点评：（待运营补充）｜来源：${inlineText(item.sourceName, 40)}，${formatReportDate(item.publishedAt ?? item.fetchedAt)}`,
    );
  });
  return lines;
}

/** 渲染漏洞与补丁章节（表格化：编号 / 组件 / CVSS / 状态）。 */
function renderVulnSection(items: ItemDTO[]): string[] {
  const lines = ['| 编号 | 组件 | CVSS | 状态 |', '|---|---|---|---|'];
  for (const item of items) {
    const component = inlineText(item.vendor ?? item.sourceName, 40);
    const cvss = item.cvssScore === null ? '—' : item.cvssScore.toFixed(1);
    const status = item.isKev
      ? '在野利用（KEV）'
      : item.severity === 'critical' || item.severity === 'high'
        ? '需优先修复'
        : SEVERITY_LABELS[item.severity];
    lines.push(`| ${itemIds(item)} | ${component} | ${cvss} | ${status} |`);
  }
  return lines;
}

/** 渲染普通条目章节（标题 + 摘要 + 来源 + 时间 + 编号 + 链接）。 */
function renderItemList(items: ItemDTO[]): string[] {
  const lines: string[] = [];
  for (const item of items) {
    lines.push(`### ${inlineText(item.title, 200)}`);
    lines.push('');
    const meta = [
      `- 来源：${inlineText(item.sourceName, 40)}`,
      `- 时间：${formatDateTime(item.publishedAt ?? item.fetchedAt)}`,
      `- 严重度：${SEVERITY_LABELS[item.severity]}${item.isKev ? '（KEV 在野利用）' : ''}`,
      `- 编号：${itemIds(item)}`,
    ];
    if (item.url) meta.push(`- 链接：<${item.url}>`);
    lines.push(...meta);
    const summary = shortSummary(item, 240);
    if (summary) {
      lines.push('');
      lines.push(`> ${summary}`);
    }
    lines.push('');
  }
  return lines;
}

/** 渲染数据统计章节。 */
function renderStats(items: ItemDTO[]): string[] {
  const sourceCounts = new Map<string, number>();
  const severityCounts = new Map<string, number>();
  for (const item of items) {
    sourceCounts.set(item.sourceName, (sourceCounts.get(item.sourceName) ?? 0) + 1);
    severityCounts.set(item.severity, (severityCounts.get(item.severity) ?? 0) + 1);
  }

  const lines = [`- 本期共收录情报：**${items.length}** 条`];
  const severityText = [...severityCounts.entries()]
    .sort(
      (a, b) =>
        (SEVERITY_WEIGHT[b[0] as keyof typeof SEVERITY_WEIGHT] ?? 0) -
        (SEVERITY_WEIGHT[a[0] as keyof typeof SEVERITY_WEIGHT] ?? 0),
    )
    .map(
      ([severity, count]) =>
        `${SEVERITY_LABELS[severity as keyof typeof SEVERITY_LABELS] ?? severity} ${count}`,
    )
    .join('、');
  if (severityText) lines.push(`- 严重度分布：${severityText}`);

  const topSources = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (topSources.length > 0) {
    lines.push('');
    lines.push('| 数据源 | 条数 |');
    lines.push('|---|---|');
    for (const [source, count] of topSources) {
      lines.push(`| ${inlineText(source, 40)} | ${count} |`);
    }
  }
  return lines;
}

/** 渲染「下期关注」：按关注关键词命中数推荐。 */
function renderNextFocus(items: ItemDTO[], settings: AppSettings): string[] {
  const lines: string[] = [];
  const keywordCounts = settings.watchKeywords
    .filter((keyword) => keyword.length > 0)
    .map((keyword) => {
      const lower = keyword.toLowerCase();
      const count = items.filter((item) =>
        `${item.title} ${item.summary ?? ''}`.toLowerCase().includes(lower),
      ).length;
      return { keyword, count };
    })
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  if (keywordCounts.length > 0) {
    lines.push('本周关注关键词命中情况（建议下期继续跟踪）：');
    lines.push('');
    for (const entry of keywordCounts) {
      lines.push(`- ${inlineText(entry.keyword, 60)}：${entry.count} 条`);
    }
  } else {
    lines.push('本周关注关键词暂无命中，建议复核「系统设置 → 重点关注关键词」是否需要调整。');
  }

  const focus = [...items]
    .filter((item) => item.isKev || item.severity === 'critical')
    .sort(compareReportItems)
    .slice(0, 3);
  if (focus.length > 0) {
    lines.push('');
    lines.push('建议优先复核：');
    lines.push('');
    focus.forEach((item) => {
      lines.push(`- ${inlineText(item.title, 160)}${item.url ? `（<${item.url}>）` : ''}`);
    });
  }
  return lines;
}

/**
 * 生成报告 Markdown。
 *
 * 章节：本周速览 → settings.reportSections 逐章 → 本周数据统计 → 下期关注。
 */
export function buildReportMarkdown(input: ReportBuildInput): ReportBuildResult {
  const { items, type, periodStart, periodEnd, settings } = input;
  const now = input.now ?? new Date();
  const title = input.title?.trim() || defaultReportTitle(type, periodStart, periodEnd);

  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(
    `> 生成时间：${formatDateTime(now.toISOString())}｜统计区间：${formatReportDate(periodStart)} ~ ${formatReportDate(periodEnd)}｜共收录 ${items.length} 条情报`,
  );
  lines.push('> 本报告由 Knetsec_Ai 自动生成，仅聚合公开披露信息；发布前请人工复核。');
  lines.push('');

  // 本周速览
  lines.push('## 本周速览');
  lines.push('');
  lines.push(...renderOverview(items));
  lines.push('');

  // 按配置生成业务章节
  const configuredSections = settings.reportSections.filter((section) =>
    (REPORT_SECTIONS as ItemCategory[]).includes(section),
  );
  const sections = configuredSections.length > 0 ? configuredSections : REPORT_SECTIONS;

  for (const section of sections) {
    const sectionItems = items.filter((item) => item.category === section).sort(compareReportItems);
    if (sectionItems.length === 0) continue;

    const label = ITEM_CATEGORY_LABELS[section] ?? section;
    lines.push(`## ${label}`);
    lines.push('');
    const visible = sectionItems.slice(0, MAX_ITEMS_PER_SECTION);
    lines.push(...(section === 'vuln' ? renderVulnSection(visible) : renderItemList(visible)));
    if (sectionItems.length > MAX_ITEMS_PER_SECTION) {
      lines.push(
        `> 其余 ${sectionItems.length - MAX_ITEMS_PER_SECTION} 条请在管理面板「情报中心」按分类「${label}」查看。`,
      );
      lines.push('');
    }
  }

  // 统计
  lines.push('## 本周数据统计');
  lines.push('');
  lines.push(...renderStats(items));
  lines.push('');

  // 下期关注
  lines.push('## 下期关注');
  lines.push('');
  lines.push(...renderNextFocus(items, settings));
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(`_本报告由 ${APP_NAME} 自动生成，如需调整章节请在「系统设置 → 报告设置」中修改。_`);

  return { title, markdown: `${lines.join('\n')}\n`, itemCount: items.length };
}