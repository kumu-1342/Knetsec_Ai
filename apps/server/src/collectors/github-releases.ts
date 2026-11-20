/**
 * GitHub 仓库发布（Release）适配器。
 *
 * 数据价值：vllm / langchain / ollama / promptfoo 这类 AI 基础设施的发布说明里
 * 常包含安全修复（CVE 编号、权限校验加固），是「重点 AI 项目供应链风险」的早期信号。
 *
 * 接口：GET https://api.github.com/repos/{owner}/{repo}/releases?per_page={n}
 * 请求量：每个仓库 1 次请求，仓库之间 sleep 300ms（未认证限流 60 次/小时）。
 */
import { z } from 'zod';
import type { CollectorAdapter, CollectorContext, CollectorResult, RawItem } from '@knetsec/shared';
import {
  asString,
  DEFAULT_REQUEST_INTERVAL_MS,
  githubHeaders,
  isRecord,
  plainText,
  sleep,
  toIsoOrUndefined,
} from './helpers.js';

/** owner/repo 格式校验：避免配置里写成完整 URL 或带空格的脏值。 */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** 默认监控的 AI 基础设施项目（可在数据源配置里覆盖）。 */
export const DEFAULT_RELEASE_REPOS: readonly string[] = [
  'vllm-project/vllm',
  'langchain-ai/langchain',
  'ollama/ollama',
  'promptfoo/promptfoo',
  'BerriAI/litellm',
];

const ConfigSchema = z.object({
  repos: z.array(z.string()).catch([...DEFAULT_RELEASE_REPOS]),
  /** 每个仓库取多少条最新发布 */
  perRepo: z.number().int().min(1).max(10).catch(5),
});

type ReleasesConfig = z.infer<typeof ConfigSchema>;

function parseConfig(config: Record<string, unknown>): ReleasesConfig {
  const parsed = ConfigSchema.safeParse(config ?? {});
  const data = parsed.success ? parsed.data : ConfigSchema.parse({});
  const repos = data.repos.map((repo) => repo.trim()).filter((repo) => REPO_PATTERN.test(repo));
  return { ...data, repos: repos.length > 0 ? repos.slice(0, 20) : [...DEFAULT_RELEASE_REPOS] };
}

/**
 * GitHub Release 适配器。
 *
 * 幂等性：externalId 用「仓库@tag」，同一个 tag 重复采集 uid 不变；
 * 草稿（draft）跳过，预发布（prerelease）保留并打标签。
 */
export class GithubReleasesCollector implements CollectorAdapter {
  readonly id = 'github_releases' as const;

  async fetch(ctx: CollectorContext): Promise<CollectorResult> {
    const config = parseConfig(ctx.source.config);
    const warnings: string[] = [];
    const items: RawItem[] = [];

    for (let index = 0; index < config.repos.length; index += 1) {
      if (index > 0) await sleep(DEFAULT_REQUEST_INTERVAL_MS);
      const repo = config.repos[index];
      const url = 'https://api.github.com/repos/' + repo + '/releases?per_page=' + String(config.perRepo);

      let payload: unknown;
      try {
        payload = await ctx.http.getJson<unknown>(url, { headers: githubHeaders(ctx), timeoutMs: 30_000 });
      } catch (error) {
        // 单个仓库失败不影响其他仓库（例如仓库改名/私有/被限流）
        warnings.push('仓库发布拉取失败 ' + repo + ': ' + describeError(error));
        continue;
      }

      if (!Array.isArray(payload)) {
        warnings.push('仓库发布响应不是数组 ' + repo);
        continue;
      }

      for (const release of payload) {
        if (!isRecord(release)) continue;
        try {
          const raw = this.mapRelease(repo, release);
          if (raw) items.push(raw);
        } catch (error) {
          warnings.push('发布解析失败 ' + repo + ': ' + describeError(error));
        }
      }
    }

    ctx.logger.info(
      { sourceKey: ctx.source.key, count: items.length, repos: config.repos.length },
      'GitHub Release 采集完成',
    );
    return { items, warnings };
  }

  /** 单条 release → RawItem。 */
  private mapRelease(repo: string, release: Record<string, unknown>): RawItem | undefined {
    if (release.draft === true) return undefined;

    const tag = asString(release.tag_name)?.trim() || asString(release.name)?.trim();
    if (!tag) return undefined;

    const body = asString(release.body) ?? '';
    const htmlUrl = asString(release.html_url)?.trim();
    const authorNode = release.author;
    const author = isRecord(authorNode) ? asString(authorNode.login) : undefined;
    const prerelease = release.prerelease === true;

    const tags = ['release', repo.split('/')[1] ?? repo];
    if (prerelease) tags.push('prerelease');

    return {
      externalId: repo + '@' + tag,
      // 标题保持「repo vX.Y.Z」形态，报告里一眼能看出是哪个项目哪个版本
      title: repo + ' ' + tag,
      summary: plainText(body, 600),
      url: htmlUrl,
      author,
      publishedAt: toIsoOrUndefined(release.published_at) ?? toIsoOrUndefined(release.created_at),
      category: 'tool',
      tags,
      raw: {
        id: release.id,
        tag_name: tag,
        name: release.name,
        prerelease,
        body: body.slice(0, 2000),
      },
    };
  }
}

/** 把未知异常转成可读短语。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
