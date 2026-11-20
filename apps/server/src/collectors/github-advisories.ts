/**
 * GitHub 安全公告库（Global Security Advisories / GHSA）适配器。
 *
 * 数据价值：GitHub Advisory 是开源生态（npm/pip/go/maven...）漏洞披露的第一站，
 * 往往比 NVD 早数天到数周，且直接给出受影响的包名与版本区间，最适合做「供应链风险」预警。
 *
 * 接口：GET https://api.github.com/advisories
 * 关键约束（实测 2026-11）：
 * - severity 参数只接受**单个**值（low|medium|high|critical），传 "critical,high" 会返回 422，
 *   因此本适配器对每个 severity 发一次请求，并在本地按 ghsa_id 去重；
 * - 未认证限流 60 次/小时，默认只查 critical+high 两级，单源单次最多 2 次请求；
 * - 配置了 GITHUB_TOKEN 时自动带 Authorization，限流提升到 5000 次/小时。
 */
import { z } from 'zod';
import type { CollectorAdapter, CollectorContext, CollectorResult, RawItem, Severity } from '@knetsec/shared';
import { upstreamError } from '../infra/errors.js';
import {
  clampInt,
  DEFAULT_REQUEST_INTERVAL_MS,
  githubHeaders,
  isRecord,
  plainText,
  sleep,
  stringList,
  suggestAiCategory,
  toArray,
  toIsoOrUndefined,
  asString,
  asNumber,
  daysAgo,
} from './helpers.js';

const ADVISORIES_URL = 'https://api.github.com/advisories';

/** GitHub 公告只有这 5 级；"moderate" 是 GHSA 页面用词，接口返回 medium。 */
const GHSA_SEVERITY_MAP: Record<string, Severity> = {
  low: 'low',
  moderate: 'medium',
  medium: 'medium',
  high: 'high',
  critical: 'critical',
};

/** 允许查询的 severity（接口只接受这 4 个值）。 */
const QUERYABLE_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

/**
 * 适配器配置。
 *
 * 全部字段带 .catch 兜底：配置来自数据库、管理员可手改，任何脏值都不应让采集崩掉，
 * 只会回退到安全默认值并在 warnings 中提示。
 */
const ConfigSchema = z.object({
  /** 单次请求条数（GitHub 上限 100） */
  perPage: z.number().int().min(1).max(100).catch(50),
  /** 要查询的严重度列表，最多 3 个（每个占一次请求额度） */
  severities: z
    .array(z.string())
    .catch(['critical', 'high'])
    .transform((list) => list.slice(0, 3)),
  /** 只取最近 N 天发布的公告 */
  days: z.number().int().min(1).max(365).catch(30),
  /** 生态过滤（pip/npm/maven...），为空表示不过滤 */
  ecosystems: z.array(z.string()).catch([]),
});

/** 解析后的配置类型。 */
type AdvisoriesConfig = z.infer<typeof ConfigSchema>;

/** 从原始 config 中解析配置，失败回退全默认值。 */
function parseConfig(config: Record<string, unknown>): AdvisoriesConfig {
  const parsed = ConfigSchema.safeParse(config ?? {});
  if (parsed.success) return parsed.data;
  return ConfigSchema.parse({});
}

/** 从 advisories[].vulnerabilities 中提取受影响包名与生态，用于 AI 关键词判定与标签。 */
function collectPackages(advisory: Record<string, unknown>): { names: string[]; ecosystems: string[] } {
  const names: string[] = [];
  const ecosystems: string[] = [];
  for (const vulnerability of toArray(advisory.vulnerabilities)) {
    if (!isRecord(vulnerability)) continue;
    const pkg = vulnerability.package;
    if (!isRecord(pkg)) continue;
    const name = asString(pkg.name)?.trim();
    const ecosystem = asString(pkg.ecosystem)?.trim().toLowerCase();
    if (name && names.length < 8) names.push(name);
    if (ecosystem && ecosystems.length < 8) ecosystems.push(ecosystem);
  }
  return { names, ecosystems };
}

/** 从 cvss / cvss_severities 中尽力取出分值（不同公告版本字段位置不同）。 */
function extractCvssScore(advisory: Record<string, unknown>): number | undefined {
  const direct = advisory.cvss;
  if (isRecord(direct)) {
    const score = asNumber(direct.score);
    if (score !== undefined) return score;
  }
  // 少数公告把分值放在 cvss_severities.cvss_v3.score
  const severities = advisory.cvss_severities;
  if (isRecord(severities)) {
    for (const key of ['cvss_v4', 'cvss_v3']) {
      const entry = severities[key];
      if (isRecord(entry)) {
        const score = asNumber(entry.score);
        if (score !== undefined) return score;
      }
    }
  }
  return undefined;
}

/**
 * GitHub 安全公告适配器。
 *
 * 只返回 RawItem：不写库、不做最终分类（AI 生态判定只是「建议」，流水线会二次校正）。
 */
export class GithubAdvisoriesCollector implements CollectorAdapter {
  readonly id = 'github_advisories' as const;

  async fetch(ctx: CollectorContext): Promise<CollectorResult> {
    const config = parseConfig(ctx.source.config);
    const warnings: string[] = [];

    const severities = [...new Set(config.severities.map((s) => s.toLowerCase()))].filter(
      (s): s is 'critical' | 'high' | 'medium' | 'low' =>
        (QUERYABLE_SEVERITIES as readonly string[]).includes(s),
    );

    if (severities.length === 0) {
      warnings.push('配置 severities 无合法值（critical/high/medium/low），本次跳过请求');
      return { items: [], warnings };
    }

    // 实测：published 传带毫秒的完整 ISO（2026-10-18T15:39:00.000Z）会被 GitHub 判为
    // "The date input ... is invalid" 并返回 422；只接受 date-only（2026-10-18）。
    const publishedAfter = daysAgo(ctx.now, config.days).toISOString().slice(0, 10);
    const ecosystems = [...new Set(config.ecosystems.map((e) => e.toLowerCase()))].filter((e) =>
      /^[a-z0-9-]+$/.test(e),
    );
    const items: RawItem[] = [];
    const seen = new Set<string>();

    // 两种请求模式（实测差异导致，必须二选一）：
    //
    // A. 配置了 ecosystems：按 ecosystem 逐个请求。原因：
    //    1) 只有 ecosystem 参数能拿回 vulnerabilities[].package 数据（AI 生态判定依赖包名）；
    //    2) 实测 ecosystem 与 published 同时出现时上游返回 0 条（过滤语义不一致），
    //       因此本模式不带 published，改为在本地按 published_at 过滤 days；
    //    3) ecosystem 参数与 severity 可同时使用，但为了少发请求，severity 也在本地过滤。
    //
    // B. 未配置 ecosystems：按 severity 逐个请求（接口只接受单值 severity），带 published 窗口。
    const useEcosystemMode = ecosystems.length > 0;
    const requests: Array<{ label: string; url: string }> = [];

    if (useEcosystemMode) {
      for (const ecosystem of ecosystems.slice(0, 3)) {
        requests.push({
          label: 'ecosystem=' + ecosystem,
          url:
            ADVISORIES_URL +
            '?per_page=' +
            String(config.perPage) +
            '&ecosystem=' +
            encodeURIComponent(ecosystem),
        });
      }
    } else {
      for (const severity of severities) {
        requests.push({
          label: 'severity=' + severity,
          url:
            ADVISORIES_URL +
            '?per_page=' +
            String(config.perPage) +
            '&severity=' +
            severity +
            '&published=' +
            encodeURIComponent(publishedAfter) +
            '&sort=published&direction=desc',
        });
      }
    }

    const sinceMs = ctx.now.getTime() - config.days * 24 * 60 * 60 * 1000;
    const severityFilter = useEcosystemMode ? new Set<string>(severities) : undefined;

    for (let index = 0; index < requests.length; index += 1) {
      // 串行 + sleep：GitHub 对连续请求敏感，未认证额度有限（60 次/小时）
      if (index > 0) await sleep(DEFAULT_REQUEST_INTERVAL_MS);
      const request = requests[index];

      let payload: unknown;
      try {
        payload = await ctx.http.getJson<unknown>(request.url, { headers: githubHeaders(ctx) });
      } catch (error) {
        throw upstreamError('GitHub 安全公告请求失败（' + request.label + '）: ' + describeError(error), {
          url: request.url,
          label: request.label,
        });
      }

      if (isRecord(payload) && typeof payload.message === 'string') {
        throw upstreamError('GitHub 安全公告接口返回错误: ' + payload.message, { url: request.url });
      }
      if (!Array.isArray(payload)) {
        warnings.push('GitHub 安全公告响应不是数组（' + request.label + '），已跳过');
        continue;
      }

      for (const advisory of payload) {
        if (!isRecord(advisory)) continue;
        try {
          const raw = this.mapAdvisory(advisory, { severityFilter, sinceMs });
          if (!raw) continue;
          const dedupeKey = raw.externalId ?? raw.title;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          items.push(raw);
        } catch (error) {
          const id = asString(advisory.ghsa_id) ?? 'unknown';
          warnings.push('公告解析失败 ' + id + ': ' + describeError(error));
        }
      }
    }

    ctx.logger.info(
      { sourceKey: ctx.source.key, count: items.length, mode: useEcosystemMode ? 'ecosystem' : 'severity' },
      'GitHub 安全公告采集完成',
    );
    return { items, warnings };
  }

  /**
   * 单条公告字段映射；不满足过滤条件或标题为空时返回 undefined（由上层跳过）。
   *
   * @param options.severityFilter 非空时只保留该集合内的严重度（ecosystem 模式下本地过滤）
   * @param options.sinceMs 非空时丢弃发布时间早于该时间戳的公告（ecosystem 模式没有 published 参数）
   */
  private mapAdvisory(
    advisory: Record<string, unknown>,
    options: { severityFilter?: Set<string>; sinceMs?: number },
  ): RawItem | undefined {
    const ghsaId = asString(advisory.ghsa_id)?.trim();
    const title = asString(advisory.summary)?.trim();
    if (!ghsaId || !title) return undefined;

    const description = asString(advisory.description);
    const packages = collectPackages(advisory);
    const severityText = asString(advisory.severity)?.toLowerCase() ?? '';

    if (options.severityFilter && !options.severityFilter.has(severityText)) return undefined;

    if (options.sinceMs !== undefined) {
      const published = toIsoOrUndefined(advisory.published_at);
      // 无法解析时间时保留（宁可多采一条，也不要因为脏时间丢掉新公告）
      if (published && new Date(published).getTime() < options.sinceMs) return undefined;
    }
    const cveId = asString(advisory.cve_id)?.trim();
    const htmlUrl = asString(advisory.html_url)?.trim();
    const text = [title, description ?? '', ...packages.names].join(' ');
    const category = suggestAiCategory(text, 'vuln');

    const item: RawItem = {
      externalId: ghsaId,
      title,
      summary: plainText(description ?? title, 600),
      url: htmlUrl,
      publishedAt: toIsoOrUndefined(advisory.published_at),
      category,
      severity: GHSA_SEVERITY_MAP[severityText] ?? 'unknown',
      ghsaIds: [ghsaId],
      cveIds: cveId ? [cveId] : [],
      tags: [...new Set([...(category === 'ai-security' ? ['ai-security'] : []), ...packages.ecosystems])],
      cvssScore: extractCvssScore(advisory),
      raw: advisory,
    };
    return item;
  }
}

/** 把未知异常转成可读短语，避免把整个对象塞进日志/运行记录。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
