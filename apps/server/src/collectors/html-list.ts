/**
 * 通用 HTML 列表页适配器。
 *
 * 适用场景：只提供网页列表、没有 RSS/JSON 的数据源（典型如 CNVD / CNNVD 公告列表、
 * 部分厂商公告页）。用 CSS 选择器配置抓取规则，新增同类源无需改代码。
 *
 * 合规边界（docs/00 §1.3）：只抓公开列表页的「标题 + 链接 + 日期」，
 * 不登录、不绕反爬，单次只请求一个页面（列表页），不抓正文详情。
 *
 * @example 配置
 * {
 *   "url": "https://www.cnvd.org.cn/flaw/list",
 *   "itemSelector": "table.tlist tr",
 *   "titleSelector": "td a",
 *   "linkSelector": "td a",
 *   "dateSelector": "td:last-child",
 *   "category": "vuln"
 * }
 */
import { load } from 'cheerio';
import { z } from 'zod';
import type { CollectorAdapter, CollectorContext, CollectorResult, RawItem } from '@knetsec/shared';
import { upstreamError } from '../infra/errors.js';
import {
  asItemCategory,
  asString,
  isWithinDays,
  plainText,
  toAbsoluteUrl,
  toIsoOrUndefined,
} from './helpers.js';

/** 配置：选择器全部来自管理员，允许空值表示「用条目自身」。 */
const ConfigSchema = z.object({
  url: z.string().catch(''),
  itemSelector: z.string().catch(''),
  titleSelector: z.string().catch(''),
  linkSelector: z.string().catch(''),
  dateSelector: z.string().catch(''),
  category: z.string().catch(''),
  maxItems: z.number().int().min(1).max(200).catch(30),
  keepDays: z.number().int().min(1).max(365).catch(30),
  /** 页面编码：部分国内站点用 GBK（Node 只支持 utf-8 解码，需配合 iconv 场景暂不支持） */
  parser: z.string().catch('html'),
});

type HtmlListConfig = z.infer<typeof ConfigSchema>;

function parseConfig(config: Record<string, unknown>): HtmlListConfig {
  const parsed = ConfigSchema.safeParse(config ?? {});
  return parsed.success ? parsed.data : ConfigSchema.parse({});
}

/** 从任意文本里兜底提取日期（选择器没配或页面结构变化时使用）。 */
function extractDateFromText(text: string): string | undefined {
  const match = text.match(/(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (!match) return undefined;
  const year = match[1];
  const month = (match[2] ?? '1').padStart(2, '0');
  const day = (match[3] ?? '1').padStart(2, '0');
  return toIsoOrUndefined(year + '-' + month + '-' + day);
}

/**
 * HTML 列表页适配器。
 *
 * 解析容错：单条解析失败跳过并记 warning；整个页面无法解析才抛错
 * （多为「站点返回了反爬验证页」，此时 last_error 会写明原因，便于运维切代理）。
 */
export class HtmlListCollector implements CollectorAdapter {
  readonly id = 'html_list' as const;

  async fetch(ctx: CollectorContext): Promise<CollectorResult> {
    const config = parseConfig(ctx.source.config);
    const warnings: string[] = [];

    const url = (config.url || ctx.source.url || '').trim();
    if (!url) throw upstreamError('HTML 列表数据源未配置 url（config.url 与 source.url 均为空）');
    if (!config.itemSelector) throw upstreamError('HTML 列表数据源未配置 itemSelector', { url });

    let html: string;
    try {
      html = await ctx.http.getText(url, {
        headers: { accept: 'text/html,application/xhtml+xml' },
        timeoutMs: 30_000,
      });
    } catch (error) {
      throw upstreamError('HTML 列表请求失败（可能需要代理）: ' + describeError(error), { url });
    }

    const $ = load(html);
    const nodes = $(config.itemSelector);
    if (nodes.length === 0) {
      throw upstreamError('itemSelector 未匹配到任何条目（站点结构可能变更或返回了验证页）', {
        url,
        itemSelector: config.itemSelector,
      });
    }

    const suggestedCategory = asItemCategory(config.category);
    const items: RawItem[] = [];
    const seen = new Set<string>();

    nodes.each((index, element) => {
      if (items.length >= config.maxItems) return;
      try {
        const node = $(element);
        const title = config.titleSelector
          ? node.find(config.titleSelector).first().text().trim() || node.text().trim()
          : node.text().trim();
        if (!title) return;

        const linkNode = config.linkSelector
          ? node.find(config.linkSelector).first()
          : node.find('a').first();
        const href = asString(linkNode.attr('href'));
        const absoluteUrl = href ? toAbsoluteUrl(url, href) : undefined;

        const dateText = config.dateSelector ? node.find(config.dateSelector).first().text().trim() : '';
        const publishedAt = toIsoOrUndefined(dateText) ?? extractDateFromText(node.text());
        if (!isWithinDays(publishedAt, ctx.now, config.keepDays)) return;

        const externalId = absoluteUrl ?? title;
        if (seen.has(externalId)) return;
        seen.add(externalId);

        items.push({
          externalId,
          title: title.slice(0, 300),
          summary: plainText(node.text(), 600),
          url: absoluteUrl,
          publishedAt,
          category: suggestedCategory,
          raw: { selector: config.itemSelector, title, href: href ?? null, dateText, index },
        });
      } catch (error) {
        warnings.push('HTML 条目解析失败（#' + String(index) + '）: ' + describeError(error));
      }
    });

    ctx.logger.info(
      { sourceKey: ctx.source.key, count: items.length, matched: nodes.length },
      'HTML 列表采集完成',
    );
    return { items, warnings };
  }
}

/** 把未知异常转成可读短语。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
