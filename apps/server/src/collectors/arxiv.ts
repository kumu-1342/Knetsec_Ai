/**
 * arXiv 预印本适配器。
 *
 * 数据价值：arXiv cs.CR / cs.AI 是 AI 安全研究的最前沿来源（提示注入、越狱、
 * 模型窃取等论文往往先出现在这里），是报告「安全研究」章节的主要素材。
 *
 * 接口：GET https://export.arxiv.org/api/query（Atom XML）
 * 注意：arXiv 对调用频率非常敏感（官方要求 3 秒/次），超限时返回 HTTP 200
 * 但正文是纯文本 "Rate exceeded."，因此必须识别这种「假成功」并重试。
 */
import { z } from 'zod';
import type { CollectorAdapter, CollectorContext, CollectorResult, RawItem } from '@knetsec/shared';
import { upstreamError } from '../infra/errors.js';
import {
  asString,
  isRecord,
  parseXml,
  plainText,
  sleep,
  textOf,
  toArray,
  toIsoOrUndefined,
} from './helpers.js';

const ARXIV_API_URL = 'https://export.arxiv.org/api/query';

/** arXiv 官方建议的请求间隔。 */
const ARXIV_INTERVAL_MS = 3_000;

/** 被限流时的重试次数（含首次共 2 次），避免一次限流就让整轮采集失败。 */
const ARXIV_MAX_ATTEMPTS = 2;

/** 适配器配置。 */
const ConfigSchema = z.object({
  /** arXiv 分类，如 ['cs.CR'] 或 ['cs.CR','cs.AI'] */
  categories: z
    .array(z.string())
    .catch(['cs.CR'])
    .transform((list) => list.slice(0, 4)),
  /** 关键词（与分类是 AND 关系），为空表示只要分类 */
  keywords: z
    .array(z.string())
    .catch([])
    .transform((list) => list.slice(0, 6)),
  /** 单次最多返回条数 */
  maxResults: z.number().int().min(1).max(200).catch(30),
});

type ArxivConfig = z.infer<typeof ConfigSchema>;

function parseConfig(config: Record<string, unknown>): ArxivConfig {
  const parsed = ConfigSchema.safeParse(config ?? {});
  const result = parsed.success ? parsed.data : ConfigSchema.parse({});
  const categories = result.categories.map((c) => c.trim()).filter((c) => c.length > 0);
  return categories.length > 0 ? { ...result, categories } : { ...result, categories: ['cs.CR'] };
}

/**
 * 构造 arXiv 的 search_query 表达式。
 *
 * 为什么手写而不是用 URLSearchParams：arXiv 语法里 OR / AND 与 cat: 之间用
 * 加号分隔（cat:cs.CR+OR+cat:cs.AI），URLSearchParams 会把加号编码成 %2B，
 * 导致查询语义被破坏。这里对每个词元单独 encodeURIComponent，保留结构性加号。
 */
export function buildArxivQuery(config: ArxivConfig): string {
  const catPart = config.categories.map((category) => 'cat:' + encodeURIComponent(category)).join('+OR+');

  if (config.keywords.length === 0) return catPart;

  const keywordPart = config.keywords
    .map((keyword) => 'all:' + encodeURIComponent('"' + keyword + '"'))
    .join('+OR+');
  return '(' + catPart + ')+AND+(' + keywordPart + ')';
}

/**
 * arXiv 适配器。
 *
 * 只发 1 次请求（单页），返回按提交时间倒序的最新论文。
 */
export class ArxivCollector implements CollectorAdapter {
  readonly id = 'arxiv' as const;

  async fetch(ctx: CollectorContext): Promise<CollectorResult> {
    const config = parseConfig(ctx.source.config);
    const warnings: string[] = [];
    const query = buildArxivQuery(config);
    const url =
      ARXIV_API_URL +
      '?search_query=' +
      query +
      '&sortBy=submittedDate&sortOrder=descending&max_results=' +
      String(config.maxResults);

    let xml = '';
    let lastError: unknown;
    for (let attempt = 0; attempt < ARXIV_MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(ARXIV_INTERVAL_MS);
      try {
        xml = await ctx.http.getText(url, { headers: { accept: 'application/atom+xml' }, timeoutMs: 45_000 });
        // 被限流时 arXiv 返回 200 + "Rate exceeded."，必须当作失败重试
        if (isRateLimited(xml)) {
          lastError = new Error('arXiv 限流: ' + xml.trim().slice(0, 120));
          continue;
        }
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!xml || isRateLimited(xml)) {
      throw upstreamError('arXiv 请求失败（可能被限流，请降低频率）: ' + describeError(lastError), { url });
    }

    let items: RawItem[] = [];
    try {
      items = this.parseFeed(xml, warnings);
    } catch (error) {
      throw upstreamError('arXiv XML 解析失败: ' + describeError(error), { url });
    }

    ctx.logger.info({ sourceKey: ctx.source.key, count: items.length }, 'arXiv 采集完成');
    return { items, warnings };
  }

  /** 解析 Atom feed；单条失败只记 warning。 */
  private parseFeed(xml: string, warnings: string[]): RawItem[] {
    const parsed = parseXml(xml);
    if (!isRecord(parsed)) throw new Error('XML 根节点解析为空');
    const feed = parsed.feed;
    if (!isRecord(feed)) throw new Error('缺少 feed 节点');

    const entries = toArray(feed.entry);
    const items: RawItem[] = [];

    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      try {
        const raw = this.mapEntry(entry);
        if (raw) items.push(raw);
      } catch (error) {
        warnings.push('arXiv 条目解析失败: ' + describeError(error));
      }
    }
    return items;
  }

  /** 单条 Atom entry → RawItem。 */
  private mapEntry(entry: Record<string, unknown>): RawItem | undefined {
    const rawId = asString(entry.id) ?? textOf(entry.id);
    const title = textOf(entry.title);
    if (!title) return undefined;

    // arXiv id 形如 http://arxiv.org/abs/2410.12345v2；去掉版本号保证同一论文多次更新不重复入库
    const externalId = rawId
      ? rawId.replace(/^https?:\/\/arxiv\.org\/abs\//, '').replace(/v\d+$/, '')
      : undefined;
    const url = pickAlternateLink(entry) ?? rawId;

    const authors: string[] = [];
    for (const author of toArray(entry.author)) {
      if (!isRecord(author)) continue;
      const name = textOf(author.name);
      if (name) authors.push(name.trim());
    }

    const categories: string[] = [];
    for (const category of toArray(entry.category)) {
      if (!isRecord(category)) continue;
      const term = asString(category['@_term']);
      if (term) categories.push(term);
    }

    return {
      externalId,
      title: title.trim(),
      summary: plainText(entry.summary, 600),
      url,
      author: authors.length > 0 ? authors.slice(0, 3).join(', ') : undefined,
      publishedAt: toIsoOrUndefined(textOf(entry.published) ?? textOf(entry.updated)),
      category: 'research',
      tags: categories.slice(0, 6),
      raw: entry,
    };
  }
}

/** 从 Atom link 数组里挑 rel=alternate（人类可读页面）的地址。 */
function pickAlternateLink(entry: Record<string, unknown>): string | undefined {
  for (const link of toArray(entry.link)) {
    if (!isRecord(link)) continue;
    const rel = asString(link['@_rel']) ?? 'alternate';
    const href = asString(link['@_href']);
    if (href && rel === 'alternate') return href;
  }
  return undefined;
}

/** 判断响应是否被限流（arXiv 用 200 + 纯文本表示）。 */
function isRateLimited(body: string): boolean {
  const head = body.trim().slice(0, 200).toLowerCase();
  return head.startsWith('rate exceeded') || !head.includes('<');
}

/** 把未知异常转成可读短语。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
