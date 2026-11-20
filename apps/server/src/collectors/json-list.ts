/**
 * 通用 JSON 列表适配器。
 *
 * 适用场景：没有 RSS 但提供 JSON 接口的数据源（自建漏洞平台、企业公告 API、
 * 安全厂商的 vulnerability JSON 等）。通过「条目路径 + 字段映射」配置即可接入，
 * 无需为每个源写代码——这是「新增数据源不改代码」的关键能力之一。
 *
 * @example 配置
 * {
 *   "url": "https://example.com/api/advisories",
 *   "itemsPath": "data.items",
 *   "fieldMap": { "title": "name", "url": "link", "publishedAt": "published", "externalId": "id" },
 *   "headers": { "accept": "application/json" },
 *   "keepDays": 30
 * }
 */
import { z } from 'zod';
import type { CollectorAdapter, CollectorContext, CollectorResult, RawItem } from '@knetsec/shared';
import { upstreamError } from '../infra/errors.js';
import {
  asItemCategory,
  asString,
  getByPath,
  isRecord,
  isWithinDays,
  plainText,
  textOf,
  toAbsoluteUrl,
  toArray,
  toIsoOrUndefined,
} from './helpers.js';

/** 字段映射：值都是「相对单条 item 的点路径」。 */
const FieldMapSchema = z.object({
  title: z.string().catch('title'),
  url: z.string().catch('url'),
  publishedAt: z.string().catch('publishedAt'),
  summary: z.string().catch('summary'),
  author: z.string().catch('author'),
  externalId: z.string().catch('id'),
});

const ConfigSchema = z.object({
  url: z.string().catch(''),
  /** 条目数组在响应里的点路径；空字符串表示响应本身就是数组 */
  itemsPath: z.string().catch('items'),
  fieldMap: FieldMapSchema.catch({
    title: 'title',
    url: 'url',
    publishedAt: 'publishedAt',
    summary: 'summary',
    author: 'author',
    externalId: 'id',
  }),
  headers: z.record(z.string()).catch({}),
  maxItems: z.number().int().min(1).max(500).catch(50),
  keepDays: z.number().int().min(1).max(365).catch(30),
  category: z.string().catch(''),
});

type JsonListConfig = z.infer<typeof ConfigSchema>;

function parseConfig(config: Record<string, unknown>): JsonListConfig {
  const parsed = ConfigSchema.safeParse(config ?? {});
  return parsed.success ? parsed.data : ConfigSchema.parse({});
}

/**
 * 通用 JSON 列表适配器。
 *
 * 容错策略：单条字段缺失只跳过该条并写 warning；整体响应不可解析才抛错，
 * 保证「上游加了个字段」不会让整个数据源失效。
 */
export class JsonListCollector implements CollectorAdapter {
  readonly id = 'json_list' as const;

  async fetch(ctx: CollectorContext): Promise<CollectorResult> {
    const config = parseConfig(ctx.source.config);
    const warnings: string[] = [];

    const url = (config.url || ctx.source.url || '').trim();
    if (!url) throw upstreamError('JSON 列表数据源未配置 url（config.url 与 source.url 均为空）');

    let payload: unknown;
    try {
      payload = await ctx.http.getJson<unknown>(url, {
        headers: { accept: 'application/json', ...config.headers },
        timeoutMs: 30_000,
      });
    } catch (error) {
      throw upstreamError('JSON 列表请求失败: ' + describeError(error), { url });
    }

    const container = config.itemsPath ? getByPath(payload, config.itemsPath) : payload;
    const nodes = toArray(container);
    if (nodes.length === 0) {
      // 路径配错是最常见的接入问题，这里给出可操作的提示而不是空结果
      warnings.push('itemsPath 未取到条目数组（' + config.itemsPath + '），请检查配置');
      return { items: [], warnings };
    }

    const suggestedCategory = asItemCategory(config.category);
    const items: RawItem[] = [];

    for (const node of nodes) {
      if (items.length >= config.maxItems) break;
      if (!isRecord(node)) continue;
      try {
        const raw = this.mapNode(node, config, url, suggestedCategory);
        if (!raw) continue;
        if (!isWithinDays(raw.publishedAt, ctx.now, config.keepDays)) continue;
        items.push(raw);
      } catch (error) {
        warnings.push('JSON 条目解析失败: ' + describeError(error));
      }
    }

    ctx.logger.info({ sourceKey: ctx.source.key, count: items.length }, 'JSON 列表采集完成');
    return { items, warnings };
  }

  /** 按 fieldMap 把一条 JSON 记录映射为 RawItem。 */
  private mapNode(
    node: Record<string, unknown>,
    config: JsonListConfig,
    baseUrl: string,
    suggestedCategory: RawItem['category'],
  ): RawItem | undefined {
    const map = config.fieldMap;
    const title = textOf(getByPath(node, map.title))?.trim();
    if (!title) return undefined;

    const externalId = textOf(getByPath(node, map.externalId))?.trim();
    const link = textOf(getByPath(node, map.url))?.trim();
    const summary = plainText(getByPath(node, map.summary), 600);
    const author = asString(getByPath(node, map.author))?.trim();

    return {
      externalId: externalId || undefined,
      title,
      summary,
      url: link ? toAbsoluteUrl(baseUrl, link) : undefined,
      author: author || undefined,
      publishedAt: toIsoOrUndefined(getByPath(node, map.publishedAt)),
      category: suggestedCategory,
      raw: node,
    };
  }
}

/** 把未知异常转成可读短语。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
