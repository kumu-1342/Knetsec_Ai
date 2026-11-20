/**
 * NVD（NIST 国家漏洞库）CVE 适配器。
 *
 * 数据价值：NVD 是 CVSS 分值与漏洞元数据的权威来源，报告里的 CVSS 分值、
 * 「漏洞与补丁」表格主要依赖它。
 *
 * 接口：GET https://services.nvd.nist.gov/rest/json/cves/2.0
 * 关键约束（docs/00 §13）：
 * - 时间窗最多 120 天，本适配器按配置收紧到 1-120 天，默认 7 天；
 * - 未认证限流 5 次/30 秒 → 请求间隔 6 秒；带 NVD_API_KEY 时 50 次/30 秒 → 间隔 0.6 秒；
 * - 关键词搜索每个关键词一次请求，因此关键词数量限制在 5 个以内，
 *   避免一个源吃掉整轮采集的时间预算。
 */
import { z } from 'zod';
import type { CollectorAdapter, CollectorContext, CollectorResult, RawItem, Severity } from '@knetsec/shared';
import { upstreamError } from '../infra/errors.js';
import {
  asNumber,
  asString,
  isRecord,
  nvdHeaders,
  NVD_INTERVAL_MS,
  NVD_KEYED_INTERVAL_MS,
  plainText,
  sleep,
  suggestAiCategory,
  toArray,
  toIsoOrUndefined,
} from './helpers.js';

const NVD_URL = 'https://services.nvd.nist.gov/rest/json/cves/2.0';

/** NVD 接口硬上限：时间窗不得超过 120 天。 */
const NVD_MAX_WINDOW_DAYS = 120;

/** NVD 的 baseSeverity → 领域严重度。 */
const NVD_SEVERITY_MAP: Record<string, Severity> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  none: 'info',
};

/** 适配器配置。 */
const ConfigSchema = z.object({
  /** 关键词列表（每个关键词一次请求，最多 5 个） */
  keywords: z
    .array(z.string())
    .catch([])
    .transform((list) => list.slice(0, 5)),
  /** 回看天数，1-120 */
  days: z.number().int().min(1).max(120).catch(7),
  /** 只保留 CVSS ≥ minCvss 的条目（默认 0 表示不过滤） */
  minCvss: z.number().min(0).max(10).catch(0),
  /** 单次请求条数（NVD 上限 2000） */
  resultsPerPage: z.number().int().min(1).max(2000).catch(100),
});

type NvdConfig = z.infer<typeof ConfigSchema>;

function parseConfig(config: Record<string, unknown>): NvdConfig {
  const parsed = ConfigSchema.safeParse(config ?? {});
  return parsed.success ? parsed.data : ConfigSchema.parse({});
}

/** 提取英文描述（NVD 多语言描述里 en 最完整；没有 en 时退回第一条）。 */
function pickDescription(cve: Record<string, unknown>): string {
  const descriptions = toArray(cve.descriptions);
  let fallback = '';
  for (const entry of descriptions) {
    if (!isRecord(entry)) continue;
    const value = asString(entry.value) ?? '';
    if (!fallback) fallback = value;
    if ((asString(entry.lang) ?? '').toLowerCase() === 'en' && value) return value;
  }
  return fallback;
}

/**
 * 按 CVSS v4 / v3.1 / v3.0 / v2 的优先级取分值。
 *
 * 为什么是这个顺序：v4 最新最准；老 CVE 可能只有 v2。优先取 Primary 来源
 * （NVD 自己算的分），其次取任意来源，保证「有分就用」。
 */
function pickCvss(metrics: unknown): { score?: number; severity?: Severity } {
  if (!isRecord(metrics)) return {};
  const keys = ['cvssMetricV40', 'cvssMetricV31', 'cvssMetricV30', 'cvssMetricV2'];
  for (const key of keys) {
    const list = toArray(metrics[key]);
    if (list.length === 0) continue;
    // 优先 Primary，其次 Secondary
    const ordered = [...list].sort((a, b) => {
      const typeA = isRecord(a) ? (asString(a.type) ?? '') : '';
      const typeB = isRecord(b) ? (asString(b.type) ?? '') : '';
      return (typeA === 'Primary' ? 0 : 1) - (typeB === 'Primary' ? 0 : 1);
    });
    for (const entry of ordered) {
      if (!isRecord(entry)) continue;
      const cvssData = entry.cvssData;
      if (!isRecord(cvssData)) continue;
      const score = asNumber(cvssData.baseScore);
      const severityText = (
        asString(cvssData.baseSeverity) ??
        asString(entry.baseSeverity) ??
        ''
      ).toLowerCase();
      const severity = NVD_SEVERITY_MAP[severityText];
      if (score !== undefined || severity) return { score, severity };
    }
  }
  return {};
}

/**
 * NVD CVE 适配器。
 *
 * 请求策略：无关键词 → 1 次请求拉时间窗内全部；有关键词 → 每关键词 1 次，
 * 每次之间按是否配置 API Key 决定 sleep 时长，绝不并发（NVD 对并发非常敏感）。
 */
export class NvdCveCollector implements CollectorAdapter {
  readonly id = 'nvd_cve' as const;

  async fetch(ctx: CollectorContext): Promise<CollectorResult> {
    const config = parseConfig(ctx.source.config);
    const warnings: string[] = [];
    const keywords = config.keywords.map((k) => k.trim()).filter((k) => k.length > 0);

    const days = Math.min(Math.max(config.days, 1), NVD_MAX_WINDOW_DAYS);
    const end = ctx.now;
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);

    const keyed = Boolean(ctx.secrets.nvdApiKey?.trim());
    const intervalMs = keyed ? NVD_KEYED_INTERVAL_MS : NVD_INTERVAL_MS;

    const requests = keywords.length > 0 ? keywords.map((k) => k) : [''];
    const items: RawItem[] = [];
    const seen = new Set<string>();

    for (let index = 0; index < requests.length; index += 1) {
      if (index > 0) await sleep(intervalMs);

      const keyword = requests[index];
      const url =
        NVD_URL +
        '?pubStartDate=' +
        encodeURIComponent(formatNvdDate(start)) +
        '&pubEndDate=' +
        encodeURIComponent(formatNvdDate(end)) +
        '&resultsPerPage=' +
        String(config.resultsPerPage) +
        (keyword ? '&keywordSearch=' + encodeURIComponent(keyword) : '');

      let payload: unknown;
      try {
        payload = await ctx.http.getJson<unknown>(url, { headers: nvdHeaders(ctx), timeoutMs: 45_000 });
      } catch (error) {
        // 单个关键词失败不致命：记录 warning 继续下一个，全部失败才由上层判定为源失败
        warnings.push('NVD 请求失败（' + (keyword || '全量') + '）: ' + describeError(error));
        continue;
      }

      if (!isRecord(payload)) {
        warnings.push('NVD 响应格式异常（' + (keyword || '全量') + '）');
        continue;
      }

      const vulnerabilities = toArray(payload.vulnerabilities);
      if (vulnerabilities.length === 0) {
        warnings.push('NVD 时间窗内无结果（' + (keyword || '全量') + '）');
      }

      for (const wrapper of vulnerabilities) {
        if (!isRecord(wrapper)) continue;
        const cve = wrapper.cve;
        if (!isRecord(cve)) continue;
        try {
          const raw = this.mapCve(cve, config.minCvss);
          if (!raw) continue;
          const key = raw.externalId ?? raw.title;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push(raw);
        } catch (error) {
          warnings.push('CVE 解析失败: ' + describeError(error));
        }
      }
    }

    if (items.length === 0 && warnings.length > 0 && warnings.length >= requests.length) {
      throw upstreamError('NVD 全部请求失败', { warnings });
    }

    ctx.logger.info(
      { sourceKey: ctx.source.key, count: items.length, days, keywords: keywords.length, keyed },
      'NVD CVE 采集完成',
    );
    return { items, warnings };
  }

  /** 单条 CVE → RawItem；低于 minCvss 或无编号时返回 undefined。 */
  private mapCve(cve: Record<string, unknown>, minCvss: number): RawItem | undefined {
    const cveId = asString(cve.id)?.trim().toUpperCase();
    if (!cveId) return undefined;

    const description = pickDescription(cve);
    const cvss = pickCvss(cve.metrics);
    if (minCvss > 0 && (cvss.score === undefined || cvss.score < minCvss)) return undefined;

    // 标题用「编号 + 描述首句」，比纯编号更适合列表展示与相似度去重
    const firstSentence = description.split(/\.\s/)[0] ?? description;
    const title = (cveId + ' ' + firstSentence).slice(0, 300).trim();
    const category = suggestAiCategory(title + ' ' + description, 'vuln');

    return {
      externalId: cveId,
      title,
      summary: plainText(description, 600),
      url: 'https://nvd.nist.gov/vuln/detail/' + cveId,
      publishedAt: toIsoOrUndefined(cve.published),
      category,
      severity: cvss.severity ?? 'unknown',
      cveIds: [cveId],
      cvssScore: cvss.score,
      tags: category === 'ai-security' ? ['ai-security'] : [],
      raw: cve,
    };
  }
}

/** NVD 时间格式：不带时区的 ISO 8601（带 Z 会被部分网关拒绝）。 */
function formatNvdDate(date: Date): string {
  return date.toISOString().slice(0, 23);
}

/** 把未知异常转成可读短语。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
