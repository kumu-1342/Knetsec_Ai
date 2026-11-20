/**
 * 归一化流水线：RawItem → NormalizedItem。
 *
 * 为什么单独抽成纯函数模块：
 * 1. 采集器只负责「把外部数据变成 RawItem」，归一化/补默认值/生成 uid 属于流水线职责，
 *    这样每个适配器都用同一套规则，避免各写一份默认值导致数据质量不一致；
 * 2. 纯函数便于单测：注入固定的 now 与 SourceDescriptor 即可断言输出完全确定；
 * 3. uid 是 items 表的 UNIQUE 键，决定「重复采集是否幂等」，因此必须集中实现，
 *    任何适配器都不能自行拼 uid。
 *
 * 本文件不依赖数据库、网络与日志，可在任意环境（含 vitest 纯函数测试）直接调用。
 */
import crypto from 'node:crypto';
import type {
  CollectorResult,
  ItemCategory,
  RawItem,
  Severity,
  SourceCategory,
  SourceDescriptor,
} from '@knetsec/shared';
import type { NormalizedItem } from '@knetsec/shared';

/** 摘要最大长度：与 items.summary 的展示约定一致（docs/00 §5.2 ≤600 字）。 */
export const SUMMARY_MAX_CHARS = 600;

/** 原始快照最大字符数：落库前裁剪，避免单条 raw 撑爆 SQLite 页（docs/00 §5.2 ≤16KB）。 */
export const RAW_SNAPSHOT_MAX_CHARS = 16 * 1024;

/** CVE 编号正则：CVE-YYYY-NNNN+（至少 4 位序号，兼容历史 4 位与现在的 5-6 位）。 */
const CVE_PATTERN = /CVE-\d{4}-\d{4,}/gi;

/**
 * GHSA 编号正则：GHSA-xxxx-xxxx-xxxx。
 * 允许大小写是因为部分上游（媒体转述）会写成小写，统一在大写化后再去重。
 */
const GHSA_PATTERN = /GHSA(?:-[a-z0-9]{4}){3}/gi;

/** 中文判定：CJK 统一表意文字，命中即认为是中文内容（标题/摘要）。 */
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/** 拉丁字母判定：用于区分 en 与 other。 */
const LATIN_PATTERN = /[A-Za-z]/;

/** HTML 标签与多余空白：摘要必须是纯文本，避免面板/报告出现标签噪音。 */
const HTML_TAG_PATTERN = /<[^>]*>/g;
const WHITESPACE_PATTERN = /\s+/g;

/**
 * 数据源类别 → 情报分类的兜底映射。
 *
 * 适配器通常会给更精确的建议分类（例如 GHSA 的 AI 生态漏洞归 ai-security），
 * 但当适配器未给 category 时，按数据源类别给出最合理的默认值，避免全部落到 news。
 */
const SOURCE_CATEGORY_TO_ITEM_CATEGORY: Record<SourceCategory, ItemCategory> = {
  github: 'tool',
  'vuln-db': 'vuln',
  vendor: 'vuln',
  research: 'research',
  media: 'news',
  community: 'news',
};

/** 合法分类集合，用于校验适配器给出的建议值（外部数据不可信）。 */
const ITEM_CATEGORY_SET: ReadonlySet<string> = new Set<ItemCategory>([
  'ai-security',
  'vuln',
  'cyber',
  'research',
  'tool',
  'policy',
  'news',
]);

/** 合法严重度集合。 */
const SEVERITY_SET: ReadonlySet<string> = new Set<Severity>([
  'critical',
  'high',
  'medium',
  'low',
  'info',
  'unknown',
]);

/**
 * 把标题规范化为「可用于哈希的稳定形式」。
 *
 * 为什么需要：同一篇文章在不同上游的标题可能有大小写、全角半角、首尾空白、
 * 多余标点差异（例如 "GitHub Advisory: X" 与 "github advisory — x"）。
 * 若直接用原始标题做 uid，重复采集会产生多条重复记录。
 *
 * 规则：Unicode NFKC 归一（全角→半角）→ 小写 → 非字母数字（含中日韩文字）折叠为连字符
 * → 去掉首尾连字符。中文按「字母」保留，不会因标点被清空。
 */
export function normalizeTitleForUid(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 512);
}

/** 计算 sha256 十六进制摘要（uid 与原始快照指纹都用它）。 */
function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 生成情报条目的去重键 uid。
 *
 * 契约（docs/00 §5.2 / §7.3）：
 * - 有 externalId：sha256(sourceKey + ':' + externalId)；
 * - 无 externalId：sha256(sourceKey + ':' + 规范化标题)，标题规范化见 {@link normalizeTitleForUid}。
 *
 * 为什么这样设计：externalId 是上游天然的稳定 ID（GHSA 编号、CVE 编号、RSS guid），
 * 保证同一条内容重复采集时 uid 不变（幂等）；无 ID 的源退化为标题哈希，
 * 至少能拦住「标题完全一致」的重复。
 *
 * @param sourceKey 数据源稳定键，如 github-ghsa
 * @param externalId 上游稳定 ID，可为空
 * @param title 标题（仅在无 externalId 时参与哈希）
 * @returns 64 位小写十六进制字符串
 */
export function computeUid(sourceKey: string, externalId: string | undefined, title: string): string {
  const key = (sourceKey ?? '').trim() || 'unknown-source';
  const external = typeof externalId === 'string' ? externalId.trim() : '';
  const basis = external.length > 0 ? external : normalizeTitleForUid(title ?? '');
  return sha256Hex(key + ':' + basis);
}

/**
 * 从任意文本中提取 CVE / GHSA 编号。
 *
 * 用途：
 * 1. 归一化阶段把标题/摘要里出现的编号合并到 cve_ids / ghsa_ids 字段，
 *    让「同一漏洞不同来源」可以靠编号关联；
 * 2. 跨源去重时用编号交集判定重复（比标题相似度更可靠）。
 *
 * 输入大小写不敏感，输出统一为大写并排序（排序保证结果稳定，便于单测与比对）。
 *
 * @param text 待扫描文本（标题 + 摘要 + 适配器已解析出的编号）
 */
export function extractIds(text: string): { cveIds: string[]; ghsaIds: string[] } {
  const input = typeof text === 'string' ? text : '';
  const cveIds = new Set<string>();
  const ghsaIds = new Set<string>();

  for (const match of input.matchAll(CVE_PATTERN)) {
    cveIds.add(match[0].toUpperCase());
  }
  for (const match of input.matchAll(GHSA_PATTERN)) {
    ghsaIds.add(match[0].toUpperCase());
  }

  return {
    cveIds: [...cveIds].sort(),
    ghsaIds: [...ghsaIds].sort(),
  };
}

/** 去掉 HTML 标签、脚本与多余空白，得到可入库的纯文本。 */
function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(HTML_TAG_PATTERN, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(WHITESPACE_PATTERN, ' ')
    .trim();
}

/**
 * 清洗并截断摘要。
 *
 * 为什么在归一化阶段做：上游 description/body 常带 HTML 与超长正文，
 * 面板与报告只需要纯文本摘要；截断上限与 shared 常量保持一致，避免前端二次裁剪。
 */
export function cleanSummary(input: string | undefined, maxChars = SUMMARY_MAX_CHARS): string | null {
  if (typeof input !== 'string') return null;
  const plain = stripHtml(input);
  if (plain.length === 0) return null;
  if (plain.length <= maxChars) return plain;
  // 用省略号表示截断，同时保证最终长度不超过 maxChars
  return plain.slice(0, Math.max(1, maxChars - 1)) + '…';
}

/**
 * 解析上游时间字符串为 ISO 8601（UTC）。
 *
 * 兼容 RFC822（RSS pubDate）、ISO 8601（Atom/NVD/GitHub）与 "YYYY-MM-DD" 日期。
 * 无法解析时返回 undefined，由调用方回退到 fetchedAt —— 上游时间脏数据很常见，
 * 不能因为一个坏时间戳丢掉整条情报。
 */
export function parseIsoDate(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? undefined : fromNumber.toISOString();
  }
  if (typeof value !== 'string') return undefined;

  const raw = value.trim();
  if (raw.length === 0) return undefined;

  // 纯日期（2024-10-01）按 UTC 零点处理，避免被本地时区推到前一天
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const dateOnly = new Date(raw + 'T00:00:00.000Z');
    return Number.isNaN(dateOnly.getTime()) ? undefined : dateOnly.toISOString();
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();

  // 兜底：部分 RSS 使用非标准格式（外部空格、缺时区），折叠空白后再试一次
  const loosened = new Date(raw.replace(/\s+/g, ' '));
  return Number.isNaN(loosened.getTime()) ? undefined : loosened.toISOString();
}

/** 语言判定：中文 → zh；有拉丁字母 → en；其余（纯符号/其他文字）→ other。 */
export function detectLanguage(title: string, summary: string | null): 'zh' | 'en' | 'other' {
  const sample = (title ?? '') + ' ' + (summary ?? '');
  if (CJK_PATTERN.test(sample)) return 'zh';
  if (LATIN_PATTERN.test(sample)) return 'en';
  return 'other';
}

/**
 * 序列化原始快照并裁剪体积。
 *
 * 为什么不能直接 JSON.stringify 后截断字符串：截断会破坏 JSON 结构，
 * 排障页面 JSON.parse 时会抛错。因此超限时改为「保留前 8K 预览 + truncated 标记」的
 * 合法 JSON，既能定位问题又不会撑爆数据库。
 */
export function serializeRawSnapshot(value: unknown): string | null {
  if (value === undefined || value === null) return null;

  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    // 循环引用或含 BigInt 的脏数据：退化为字符串描述
    text = JSON.stringify({ unserializable: String(value) });
  }
  if (typeof text !== 'string') return null;
  if (text.length <= RAW_SNAPSHOT_MAX_CHARS) return text;

  const sample = text.slice(0, 8000);
  const wrapped = JSON.stringify({ truncated: true, bytes: text.length, sample });
  return wrapped.length <= RAW_SNAPSHOT_MAX_CHARS
    ? wrapped
    : JSON.stringify({ truncated: true, bytes: text.length, sample: text.slice(0, 6000) });
}

/** 把适配器给出的候选分类收敛到合法枚举，非法值回退为数据源类别映射。 */
function resolveCategory(raw: RawItem, source: SourceDescriptor): ItemCategory {
  const candidate = typeof raw.category === 'string' ? raw.category : '';
  if (ITEM_CATEGORY_SET.has(candidate)) return candidate as ItemCategory;
  return SOURCE_CATEGORY_TO_ITEM_CATEGORY[source.category] ?? 'news';
}

/** 把适配器给出的严重度收敛到合法枚举，非法值回退 unknown。 */
function resolveSeverity(raw: RawItem): Severity {
  const candidate = typeof raw.severity === 'string' ? raw.severity.toLowerCase() : '';
  if (SEVERITY_SET.has(candidate)) return candidate as Severity;
  return 'unknown';
}

/** 归一化 CVSS 分值：只接受 0-10 的有限数字，保留一位小数。 */
function resolveCvssScore(raw: RawItem): number | null {
  const score = raw.cvssScore;
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  if (score <= 0 || score > 10) return null;
  return Math.round(score * 10) / 10;
}

/** 合并多组编号并去重排序（保持输出稳定）。 */
function mergeIds(lists: Array<readonly string[] | undefined>): string[] {
  const merged = new Set<string>();
  for (const list of lists) {
    if (!list) continue;
    for (const id of list) {
      if (typeof id === 'string' && id.trim().length > 0) merged.add(id.trim().toUpperCase());
    }
  }
  return [...merged].sort();
}

/** 标签清洗：去空、去重（大小写不敏感）、限制数量，避免标签爆炸。 */
function normalizeTags(tags: RawItem['tags']): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const trimmed = tag.trim();
    if (trimmed.length === 0 || trimmed.length > 48) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
    if (result.length >= 16) break;
  }
  return result;
}

/**
 * 把适配器产出的 RawItem 归一化为可入库的 NormalizedItem。
 *
 * 处理内容与「为什么」：
 * 1. uid：交给 {@link computeUid} 统一生成，保证幂等；
 * 2. 时间：publishedAt 缺失或非法时回退 fetchedAt；同时防范上游时钟异常
 *    （发布时间显著晚于抓取时间 → 视为脏数据并回退），避免未来时间污染列表排序；
 * 3. category/severity：收敛到 shared 枚举，非法值回退默认值，防止脏数据写库后前端渲染崩溃；
 * 4. 摘要/原始快照：清洗 HTML、截断体积，控制库体积；
 * 5. 编号/tags：去重排序，保证同一内容多次归一化结果完全一致（便于 diff 与测试）；
 * 6. importance 固定为 0：它由 pipeline/enrich.ts 结合设置（关注关键词）计算，
 *    采集层没有足够上下文，不能提前给出。
 *
 * @param raw 适配器输出的原始条目
 * @param source 数据源描述（用于 uid 前缀、来源冗余字段与分类兜底）
 * @param now 采集基准时间，测试时注入固定值以保证结果可断言
 */
export function normalizeRawItem(raw: RawItem, source: SourceDescriptor, now: Date): NormalizedItem {
  const fetchedAt = now.toISOString();
  // 标题是必填字段；上游偶发空标题时给出占位符，保证 items.title NOT NULL 约束不炸
  const rawTitle = typeof raw.title === 'string' ? stripHtml(raw.title) : '';
  const title = rawTitle.slice(0, 500) || '（无标题）';
  const summary = cleanSummary(raw.summary);

  const externalId =
    typeof raw.externalId === 'string' && raw.externalId.trim().length > 0
      ? raw.externalId.trim()
      : undefined;

  const parsedPublished = parseIsoDate(raw.publishedAt);
  // 允许 1 天时钟偏差（部分上游用本地时区渲染，或与我们的时钟有偏差）
  const futureToleranceMs = 24 * 60 * 60 * 1000;
  const publishedAt =
    parsedPublished && new Date(parsedPublished).getTime() <= now.getTime() + futureToleranceMs
      ? parsedPublished
      : fetchedAt;

  const idsFromText = extractIds(title + ' ' + (summary ?? ''));
  const cveIds = mergeIds([raw.cveIds, idsFromText.cveIds]);
  const ghsaIds = mergeIds([raw.ghsaIds, idsFromText.ghsaIds]);

  const url = typeof raw.url === 'string' && /^https?:\/\//i.test(raw.url.trim()) ? raw.url.trim() : null;
  const author =
    typeof raw.author === 'string' && raw.author.trim().length > 0 ? raw.author.trim().slice(0, 200) : null;
  const vendor =
    typeof raw.vendor === 'string' && raw.vendor.trim().length > 0 ? raw.vendor.trim().slice(0, 120) : null;

  const normalized: NormalizedItem = {
    uid: computeUid(source.key, externalId, title),
    sourceKey: source.key,
    sourceName: source.name,
    title,
    summary,
    url,
    author,
    publishedAt,
    fetchedAt,
    category: resolveCategory(raw, source),
    tags: normalizeTags(raw.tags),
    severity: resolveSeverity(raw),
    cveIds,
    ghsaIds,
    cvssScore: resolveCvssScore(raw),
    isKev: raw.isKev === true,
    vendor,
    lang:
      raw.lang === 'zh' || raw.lang === 'en' || raw.lang === 'other'
        ? raw.lang
        : detectLanguage(title, summary),
    importance: 0,
    raw: serializeRawSnapshot(raw.raw),
  };

  return normalized;
}

/**
 * 便捷方法：一次性归一化整批原始条目。
 *
 * 为什么提供：编排器几乎总是需要「整批 RawItem → 整批 NormalizedItem」，
 * 集中实现可以保证单条失败不影响整批（单条异常跳过并记录），
 * 而不是让每个调用方各自写 try/catch。
 *
 * @param raws 适配器产出的原始条目
 * @param source 数据源描述
 * @param now 采集基准时间
 * @param onError 单条归一化失败的回调（用于写运行日志），默认忽略
 * @returns 归一化结果与失败计数
 */
export function normalizeRawItems(
  raws: RawItem[],
  source: SourceDescriptor,
  now: Date,
  onError?: (error: unknown, raw: RawItem) => void,
): { items: NormalizedItem[]; failed: number } {
  const items: NormalizedItem[] = [];
  let failed = 0;

  for (const raw of raws) {
    try {
      items.push(normalizeRawItem(raw, source, now));
    } catch (error) {
      failed += 1;
      onError?.(error, raw);
    }
  }

  return { items, failed };
}

/**
 * 组装空采集结果的便捷方法。
 *
 * 适配器在「上游暂无新内容」时返回它而不是抛错，避免把正常的空窗口当成故障。
 *
 * @param warnings 需要写进运行日志的非致命告警
 */
export function emptyCollectorResult(warnings: string[] = []): CollectorResult {
  return { items: [], warnings };
}
