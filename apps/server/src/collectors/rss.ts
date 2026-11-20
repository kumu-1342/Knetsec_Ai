/**
 * 通用 RSS 2.0 / Atom 适配器。
 *
 * 为什么做成「通用」：安全媒体、厂商博客、研究机构加起来有十几家，如果每家写一个
 * 适配器，维护成本极高；它们的共同点就是都提供 RSS/Atom，差异只在标题/链接/日期
 * 的字段名。因此本适配器统一解析三种常见格式：
 * 1. RSS 2.0（<rss><channel><item>）—— 最常见的订阅格式；
 * 2. Atom（<feed><entry>）—— GitHub/Cloudflare 等新式博客；
 * 3. RSS 1.0 / RDF（<rdf:RDF><item>）—— 少数老站（如部分 WordPress 插件输出）。
 *
 * 兼容性处理：
 * - CDATA：fast-xml-parser 默认把 CDATA 合并进文本，无需特殊处理；
 * - 带属性节点：<guid isPermaLink="false"> 会被解析成对象，统一用 textOf 取文本；
 * - HTML 摘要：清洗为纯文本并截断 600 字（与 items.summary 约定一致）；
 * - 相对链接：解析为绝对地址，避免面板里点不开。
 */
import { z } from 'zod';
import type { CollectorAdapter, CollectorContext, CollectorResult, RawItem } from '@knetsec/shared';
import { upstreamError } from '../infra/errors.js';
import {
  asItemCategory,
  asString,
  isRecord,
  isWithinDays,
  parseXml,
  plainText,
  textOf,
  toArray,
  toIsoOrUndefined,
  toAbsoluteUrl,
} from './helpers.js';

/** 配置：url 缺省时回退到数据源登记的 url（便于面板里改源地址）。 */
const ConfigSchema = z.object({
  url: z.string().catch(''),
  maxItems: z.number().int().min(1).max(200).catch(30),
  keepDays: z.number().int().min(1).max(365).catch(30),
  /** 期望的分类；不填则由数据源类别推导（归一化层兜底） */
  category: z.string().catch(''),
});

type RssConfig = z.infer<typeof ConfigSchema>;

function parseConfig(config: Record<string, unknown>): RssConfig {
  const parsed = ConfigSchema.safeParse(config ?? {});
  return parsed.success ? parsed.data : ConfigSchema.parse({});
}

/** 单体 feed 的形态，决定字段读取方式。 */
type FeedKind = 'rss' | 'atom';

/** 解析结果：条目节点列表 + 形态。 */
interface FeedDocument {
  kind: FeedKind;
  nodes: Record<string, unknown>[];
}

/**
 * 从解析后的 XML 中定位<item>/<entry>列表。
 *
 * 三种格式的根路径不同，这里逐一探测；都不匹配则抛出可读错误，
 * 由适配器转成 UPSTREAM_ERROR（运维在面板能看到具体原因）。
 */
export function locateFeed(parsed: unknown): FeedDocument {
  if (!isRecord(parsed)) throw new Error('XML 根节点不是对象');

  // RSS 2.0
  const rss = parsed.rss;
  if (isRecord(rss)) {
    const channel = rss.channel;
    if (isRecord(channel)) {
      return { kind: 'rss', nodes: toArray(channel.item).filter(isRecord) };
    }
  }

  // Atom
  const feed = parsed.feed;
  if (isRecord(feed)) {
    return { kind: 'atom', nodes: toArray(feed.entry).filter(isRecord) };
  }

  // RSS 1.0 / RDF
  const rdf = parsed['rdf:RDF'];
  if (isRecord(rdf)) {
    return { kind: 'rss', nodes: toArray(rdf.item).filter(isRecord) };
  }

  throw new Error('不支持的 feed 格式（既不是 RSS 2.0、RDF 也不是 Atom）');
}

/** 取出 Atom 的 rel=alternate 链接（或第一个带 href 的 link）。 */
function pickAtomLink(node: Record<string, unknown>): string | undefined {
  let fallback: string | undefined;
  for (const link of toArray(node.link)) {
    if (!isRecord(link)) continue;
    const href = asString(link['@_href']);
    if (!href) continue;
    const rel = asString(link['@_rel']) ?? 'alternate';
    if (rel === 'alternate') return href;
    if (!fallback) fallback = href;
  }
  return fallback;
}

/**
 * 通用 RSS / Atom 适配器。
 *
 * @example 配置
 * { "url": "https://github.blog/category/security/feed/", "maxItems": 20, "keepDays": 30 }
 */
export class RssCollector implements CollectorAdapter {
  readonly id = 'rss' as const;

  async fetch(ctx: CollectorContext): Promise<CollectorResult> {
    const config = parseConfig(ctx.source.config);
    const warnings: string[] = [];

    const url = (config.url || ctx.source.url || '').trim();
    if (!url) {
      throw upstreamError('RSS 数据源未配置 url（config.url 与 source.url 均为空）');
    }

    let xml: string;
    try {
      xml = await ctx.http.getText(url, {
        headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
        // 部分厂商站点（如 Unit 42）首字节就要 20 秒以上，30 秒容易被误判为超时
        timeoutMs: 45_000,
      });
    } catch (error) {
      throw upstreamError('RSS 请求失败: ' + describeError(error), { url });
    }

    let document: FeedDocument;
    try {
      document = locateFeed(parseXml(xml));
    } catch (error) {
      throw upstreamError('RSS 解析失败（上游可能返回 HTML 反爬页）: ' + describeError(error), { url });
    }

    const suggestedCategory = asItemCategory(config.category);
    const items: RawItem[] = [];
    let skippedOld = 0;

    for (const node of document.nodes) {
      try {
        const raw = this.mapNode(node, document.kind, url, suggestedCategory);
        if (!raw) continue;
        if (!isWithinDays(raw.publishedAt, ctx.now, config.keepDays)) {
          skippedOld += 1;
          continue;
        }
        items.push(raw);
      } catch (error) {
        warnings.push('RSS 条目解析失败: ' + describeError(error));
      }
    }

    // 多数 feed 已按时间倒序，slice 前先按发布时间降序，保证「最新 N 条」语义正确
    items.sort((a, b) => {
      const timeA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const timeB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return timeB - timeA;
    });

    const limited = items.slice(0, config.maxItems);
    ctx.logger.info(
      { sourceKey: ctx.source.key, count: limited.length, kind: document.kind, skippedOld },
      'RSS 采集完成',
    );
    if (limited.length === 0) {
      warnings.push('RSS 在最近 ' + String(config.keepDays) + ' 天内无新条目');
    }
    return { items: limited, warnings };
  }

  /** 单条 <item>/<entry> → RawItem。 */
  private mapNode(
    node: Record<string, unknown>,
    kind: FeedKind,
    feedUrl: string,
    suggestedCategory: RawItem['category'],
  ): RawItem | undefined {
    const title = textOf(node.title)?.trim();
    if (!title) return undefined;

    let link: string | undefined;
    let externalId: string | undefined;
    let publishedRaw: unknown;
    let summaryRaw: unknown;
    let author: string | undefined;

    if (kind === 'atom') {
      link = toAbsoluteUrl(feedUrl, pickAtomLink(node));
      externalId = textOf(node.id)?.trim();
      publishedRaw = node.published ?? node.updated;
      summaryRaw = node.summary ?? node.content;
      const authorNode = node.author;
      if (isRecord(authorNode)) author = textOf(authorNode.name)?.trim();
      else author = textOf(authorNode)?.trim();
    } else {
      const linkText = textOf(node.link);
      const linkHref = isRecord(node.link) ? asString(node.link['@_href']) : undefined;
      link = toAbsoluteUrl(feedUrl, linkText ?? linkHref);
      externalId = textOf(node.guid)?.trim() || textOf(node.id)?.trim() || link;
      publishedRaw = node.pubDate ?? node['dc:date'] ?? node.updated ?? node.published;
      summaryRaw = node.description ?? node['content:encoded'] ?? node.summary ?? node.content;
      author = textOf(node.author)?.trim() || textOf(node['dc:creator'])?.trim();
    }

    const item: RawItem = {
      externalId: externalId && externalId.length > 0 ? externalId : undefined,
      title,
      summary: plainText(summaryRaw, 600),
      url: link,
      author,
      publishedAt: toIsoOrUndefined(publishedRaw),
      category: suggestedCategory,
      tags: toArray(node.category)
        .map((entry) => textOf(entry)?.trim())
        .filter((entry): entry is string => Boolean(entry))
        .slice(0, 6),
      raw: node,
    };
    return item;
  }
}

/** 把未知异常转成可读短语。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
