/**
 * GitHub 仓库搜索适配器。
 *
 * 数据价值：跟踪 AI 安全生态里「突然活跃」的开源项目（新工具、新框架），
 * 是报告「工具与项目」章节的素材来源。
 *
 * 接口：GET https://api.github.com/search/repositories
 * 限流：未认证 10 次/分钟（比普通接口严格得多），因此本适配器单次只发 1 个请求，
 * 并把 externalId 设计为「仓库名 + 更新时间」，这样仓库有新提交时会作为新条目出现，
 * 而不会被去重吞掉。配置了 GITHUB_TOKEN 时限额大幅提高。
 */
import { z } from 'zod';
import type { CollectorAdapter, CollectorContext, CollectorResult, RawItem } from '@knetsec/shared';
import { upstreamError } from '../infra/errors.js';
import {
  asNumber,
  asString,
  githubHeaders,
  isRecord,
  plainText,
  toArray,
  toIsoOrUndefined,
} from './helpers.js';

const SEARCH_URL = 'https://api.github.com/search/repositories';

/** 适配器配置。 */
const ConfigSchema = z.object({
  /** GitHub 搜索语法，例如 "topic:ai-security stars:>50" */
  query: z.string().catch('topic:llm-security stars:>20'),
  sort: z.string().catch('updated'),
  perPage: z.number().int().min(1).max(50).catch(20),
});

type SearchConfig = z.infer<typeof ConfigSchema>;

function parseConfig(config: Record<string, unknown>): SearchConfig {
  const parsed = ConfigSchema.safeParse(config ?? {});
  const data = parsed.success ? parsed.data : ConfigSchema.parse({});
  return { ...data, query: data.query.trim() || 'topic:llm-security stars:>20' };
}

/**
 * GitHub 仓库搜索适配器。
 *
 * 单请求：一次调用即返回一个页面的结果，不做翻页（翻页会迅速耗尽未认证额度）。
 */
export class GithubSearchCollector implements CollectorAdapter {
  readonly id = 'github_search' as const;

  async fetch(ctx: CollectorContext): Promise<CollectorResult> {
    const config = parseConfig(ctx.source.config);
    const warnings: string[] = [];

    const url =
      SEARCH_URL +
      '?q=' +
      encodeURIComponent(config.query) +
      '&sort=' +
      encodeURIComponent(config.sort) +
      '&order=desc&per_page=' +
      String(config.perPage);

    let payload: unknown;
    try {
      payload = await ctx.http.getJson<unknown>(url, { headers: githubHeaders(ctx), timeoutMs: 30_000 });
    } catch (error) {
      throw upstreamError('GitHub 仓库搜索失败: ' + describeError(error), { url, query: config.query });
    }

    if (!isRecord(payload)) {
      throw upstreamError('GitHub 仓库搜索响应格式异常', { url });
    }
    if (typeof payload.message === 'string') {
      throw upstreamError('GitHub 仓库搜索接口返回错误: ' + payload.message, { url });
    }

    const items: RawItem[] = [];
    for (const repo of toArray(payload.items)) {
      if (!isRecord(repo)) continue;
      try {
        const raw = this.mapRepo(repo);
        if (raw) items.push(raw);
      } catch (error) {
        warnings.push('仓库解析失败: ' + describeError(error));
      }
    }

    ctx.logger.info(
      { sourceKey: ctx.source.key, count: items.length, query: config.query },
      'GitHub 仓库搜索完成',
    );
    if (items.length === 0) warnings.push('搜索无结果，请检查 query 语法或降低 stars 门槛');
    return { items, warnings };
  }

  /** 单个仓库 → RawItem。 */
  private mapRepo(repo: Record<string, unknown>): RawItem | undefined {
    const fullName = asString(repo.full_name)?.trim();
    const htmlUrl = asString(repo.html_url)?.trim();
    if (!fullName || !htmlUrl) return undefined;

    const description = asString(repo.description) ?? '';
    const updatedAt = toIsoOrUndefined(repo.updated_at) ?? toIsoOrUndefined(repo.pushed_at);
    const stars = asNumber(repo.stargazers_count) ?? 0;
    const language = asString(repo.language)?.trim();
    const topics: string[] = [];
    for (const topic of toArray(repo.topics)) {
      const text = asString(topic)?.trim();
      if (text && topics.length < 8) topics.push(text);
    }

    const tags = ['repo', ...topics];
    if (language) tags.push(language.toLowerCase());

    return {
      // externalId 带上更新时间：仓库有新动态时作为新条目出现（配置的 query 以 updated 排序）
      externalId: updatedAt ? fullName + '@' + updatedAt : fullName,
      title: fullName,
      summary: plainText(
        description + (stars > 0 ? '（⭐ ' + String(stars) + (language ? ' · ' + language : '') + '）' : ''),
        600,
      ),
      url: htmlUrl,
      publishedAt: updatedAt,
      category: 'tool',
      tags: tags.slice(0, 10),
      raw: repo,
    };
  }
}

/** 把未知异常转成可读短语。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
