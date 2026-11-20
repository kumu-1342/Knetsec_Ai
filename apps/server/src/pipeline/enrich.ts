/**
 * 富化阶段：把归一化后的条目升级为「可排序、可打标、可入报告」的最终形态。
 *
 * 为什么独立于 normalize：
 * - normalize 由采集器团队维护，只做「结构归一」；
 * - enrich 依赖运营配置（关注词、AI 词典、LLM Key），属于业务策略层，改动频繁；
 * - 拆开后 enrich 是纯函数（LLM 之外），便于单测覆盖分级/评分规则（契约 §8.2）。
 */
import {
  AI_SECURITY_TAXONOMY,
  CVSS_SEVERITY_THRESHOLDS,
  SEVERITY_WEIGHT,
  type AppSettings,
  type CollectorLogger,
  type NormalizedItem,
  type Severity,
} from '@knetsec/shared';

/** summary 落库上限（契约 §5.2：纯文本摘要 ≤ 600 字）。 */
export const MAX_SUMMARY_LENGTH = 600;
/** raw 快照上限（契约 §5.2：≤ 16KB），仅用于排障。 */
export const MAX_RAW_BYTES = 16 * 1024;

/** PoC / 在野利用表述（命中加分，用于 importance 排序）。 */
const POC_PATTERN =
  /(proof[ -]?of[ -]?concept|\bpoc\b|\bexploit(?:ed|s|ing)?\b|利用代码|复现|在野利用|weaponized)/i;

/** 富化选项。 */
export interface EnrichOptions {
  /** 基准时间（测试注入固定值，保证 importance 的「24h 内」判断可复现）。 */
  now?: Date;
}

/** 富化 + 可选 LLM 增强的选项。 */
export interface EnrichLlmOptions extends EnrichOptions {
  logger?: CollectorLogger;
  /** 测试注入：替换真实 fetch。 */
  fetchImpl?: typeof fetch;
  /** LLM 超时（默认 20s，契约要求失败即跳过、不阻塞流水线）。 */
  timeoutMs?: number;
}

/** 截断字符串到指定字符数（超长只保留前 N 个字符，末尾不加省略号以稳定去重/展示）。 */
function clip(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

/** 把 CVSS 分值映射为严重度；0 分视为 info，无分值返回 undefined。 */
function severityFromCvss(score: number | null | undefined): Severity | undefined {
  if (score === null || score === undefined || !Number.isFinite(score)) return undefined;
  if (score <= 0) return 'info';
  for (const threshold of CVSS_SEVERITY_THRESHOLDS) {
    if (score >= threshold.min) return threshold.severity;
  }
  return 'low';
}

/** 取两个 severity 中更严重的一个（用于 KEV 强制抬升）。 */
function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_WEIGHT[a] >= SEVERITY_WEIGHT[b] ? a : b;
}

/** 判断关键词是否为纯 ASCII（英文/符号）。 */
function isAsciiKeyword(keyword: string): boolean {
  return /^[\x20-\x7E]+$/.test(keyword);
}

/**
 * 关键词命中判断。
 *
 * 为什么不能一律 includes：'rag' 会命中 "storage"、'agent' 会命中 "management"，
 * 导致无关漏洞被误标 AI 安全。纯 ASCII 且首尾为字母数字的关键词按词边界匹配；
 * 中文没有词边界概念，仍用 includes；以符号结尾的关键词（如 'gpt-'）退化为 includes。
 */
function keywordMatches(haystack: string, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return false;
  if (!isAsciiKeyword(needle) || !/^[a-z0-9].*[a-z0-9]$/i.test(needle)) {
    return haystack.includes(needle);
  }
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(haystack);
}

/** 计算 AI 安全标签：先沿用条目已有标签，再按词典命中追加。 */
function applyAiTags(item: NormalizedItem, settings: AppSettings): { tags: string[]; hit: boolean } {
  const haystack = `${item.title} ${item.summary ?? ''}`.toLowerCase();
  const tags = new Set(item.tags);
  const allowedCustom = new Set(settings.aiSecurityKeywords.map((word) => word.toLowerCase()));
  const taxonomyWords = new Set(
    AI_SECURITY_TAXONOMY.flatMap((entry) => entry.keywords.map((word) => word.toLowerCase())),
  );

  let hit = false;
  for (const entry of AI_SECURITY_TAXONOMY) {
    // 管理员可以在设置里裁剪 AI 词典：只保留仍在白名单中的词典关键词参与匹配
    const words = entry.keywords.filter(
      (word) => allowedCustom.size === 0 || allowedCustom.has(word.toLowerCase()),
    );
    if (words.some((word) => keywordMatches(haystack, word))) {
      tags.add(entry.tag);
      hit = true;
    }
  }

  // 管理员自定义的扩展词（不在内置词典中）命中时打通用标签，避免「配了但不生效」的困惑
  for (const word of allowedCustom) {
    if (word.length >= 2 && !taxonomyWords.has(word) && keywordMatches(haystack, word)) {
      tags.add('ai-security');
      hit = true;
    }
  }

  return { tags: [...tags], hit };
}

/**
 * 按契约 §8.2 计算 importance（0-100）：
 * severity 权重 40 + KEV 20 + 关注关键词 15 + 24h 内 10 + 有 CVE/GHSA 10 + PoC 表述 5。
 * 上限 100，避免叠加溢出。
 */
function computeImportance(
  item: NormalizedItem,
  settings: AppSettings,
  severity: Severity,
  now: Date,
): number {
  let score = Math.round((SEVERITY_WEIGHT[severity] / 5) * 40);
  if (item.isKev) score += 20;

  const haystack = `${item.title} ${item.summary ?? ''}`.toLowerCase();
  // 关注词同样按词边界匹配：'cve' 不应命中 'cvescan'，'rag' 不应命中 'storage'
  const watchHit = settings.watchKeywords.some((keyword) => keywordMatches(haystack, keyword));
  if (watchHit) score += 15;

  const publishedMs = Date.parse(item.publishedAt);
  // 发布时间在 24 小时内（允许未来时间，部分订阅源时钟不准）加时效分
  if (Number.isFinite(publishedMs) && now.getTime() - publishedMs <= 24 * 60 * 60 * 1000) {
    score += 10;
  }

  // GHSA 与 CVE 都是漏洞编号，对运营而言价值等价
  if (item.cveIds.length > 0 || item.ghsaIds.length > 0) score += 10;
  if (POC_PATTERN.test(item.title) || POC_PATTERN.test(item.summary ?? '')) score += 5;

  return Math.max(0, Math.min(100, score));
}

/** raw 快照按字节截断，防止异常上游把几 MB JSON 写进库。 */
function clipRaw(raw: string | null): string | null {
  if (!raw) return null;
  const bytes = Buffer.from(raw, 'utf8');
  if (bytes.length <= MAX_RAW_BYTES) return raw;
  return `${bytes.subarray(0, MAX_RAW_BYTES).toString('utf8')}\n...[raw truncated]`;
}

/**
 * 富化单条情报（同步、纯规则，契约 §7.3 签名）。
 *
 * 规则顺序：
 * 1. 严重度：CVSS 阈值 > 适配器建议 > unknown；KEV 强制至少 high；
 * 2. AI 安全标签与分类提升（原分类为 vuln 时保持不变，漏洞仍进「漏洞与补丁」章节）；
 * 3. importance 打分；
 * 4. summary / raw 体积裁剪。
 */
export function enrichItem(
  item: NormalizedItem,
  settings: AppSettings,
  options: EnrichOptions = {},
): NormalizedItem {
  const now = options.now ?? new Date();
  const cvssSeverity = severityFromCvss(item.cvssScore);
  let severity: Severity = cvssSeverity ?? item.severity ?? 'unknown';
  if (item.isKev) severity = maxSeverity(severity, 'high');

  const { tags, hit: aiHit } = applyAiTags(item, settings);
  const category = aiHit && item.category !== 'vuln' ? 'ai-security' : item.category;
  const summary = item.summary ? clip(item.summary, MAX_SUMMARY_LENGTH) : null;

  const enriched: NormalizedItem = {
    ...item,
    tags,
    severity,
    category,
    summary,
    raw: clipRaw(item.raw),
    importance: 0,
  };
  enriched.importance = computeImportance(enriched, settings, severity, now);
  return enriched;
}

/** 从 OpenAI 兼容响应中尽力取出正文（结构异常时返回 null，不影响主流程）。 */
function extractLlmText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown } | undefined)?.message;
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' && content.trim().length > 0 ? content.trim() : null;
}

/**
 * 富化 + 可选 LLM 增强（契约 §8.2.5）。
 *
 * LLM 是「锦上添花」：只有 settings.llmEnabled、Key 非空、且条目为 critical/high 时才调用；
 * 20 秒超时或任何异常只记 warn 并返回规则富化结果，绝不让外部服务阻塞采集。
 */
export async function enrichItemWithLlm(
  item: NormalizedItem,
  settings: AppSettings,
  options: EnrichLlmOptions = {},
): Promise<NormalizedItem> {
  const enriched = enrichItem(item, settings, options);
  if (!settings.llmEnabled || !settings.llmApiKey) return enriched;
  if (enriched.severity !== 'critical' && enriched.severity !== 'high') return enriched;

  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = settings.llmBaseUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);

  try {
    const response = await doFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.llmApiKey}`,
      },
      body: JSON.stringify({
        model: settings.llmModel,
        temperature: 0.2,
        max_tokens: 300,
        messages: [
          {
            role: 'system',
            content:
              '你是网络安全情报编辑。请用简体中文写不超过 80 字的摘要，并给出一句影响面判断，不要寒暄，不要 Markdown。',
          },
          {
            role: 'user',
            content: `标题：${item.title}\n摘要：${item.summary ?? '（无）'}\n编号：${[...item.cveIds, ...item.ghsaIds].join(', ') || '无'}\n严重度：${enriched.severity}\n是否在野利用：${item.isKev ? '是' : '否'}`,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as unknown;
    const text = extractLlmText(payload);
    if (text) enriched.summary = clip(text, MAX_SUMMARY_LENGTH);
  } catch (error) {
    options.logger?.warn({ err: String(error), title: item.title }, 'LLM 摘要增强失败，已跳过（不影响采集）');
  } finally {
    clearTimeout(timer);
  }

  return enriched;
}