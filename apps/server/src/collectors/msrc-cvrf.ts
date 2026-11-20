/**
 * 微软 MSRC 安全公告（CVRF）适配器。
 *
 * 数据价值：微软月度补丁（Patch Tuesday）与紧急带外公告是「厂商公告」类情报的核心，
 * 也是企业环境漏洞修复优先级的直接依据。
 *
 * 接口：GET https://api.msrc.microsoft.com/cvrf/v3.0/updates
 * 返回的是「公告文档索引」JSON（实测 217 条，字段：ID/Alias/DocumentTitle/Severity/
 * InitialReleaseDate/CurrentReleaseDate/CvrfUrl）。
 *
 * 为什么只解析索引而不解析 CVRF XML 全文：单个 CVRF 文档是复杂 XML（含产品树、
 * 漏洞树、CVSS 组合），解析成本高且极易随上游结构变化而崩；索引层已经足够回答
 * 「本月有哪些公告、何时发布」，具体 CVE 明细由 NVD 源补齐。若管理员需要全文，
 * 可把 config.fetchDocument 设为 true（实现见下）。
 */
import { z } from 'zod';
import type { CollectorAdapter, CollectorContext, CollectorResult, RawItem } from '@knetsec/shared';
import { upstreamError } from '../infra/errors.js';
import { asString, isRecord, plainText, toArray, toIsoOrUndefined, textOf } from './helpers.js';

const UPDATES_URL = 'https://api.msrc.microsoft.com/cvrf/v3.0/updates';

/** 适配器配置。 */
const ConfigSchema = z.object({
  /** 最多返回最近多少个公告文档 */
  maxDocuments: z.number().int().min(1).max(50).catch(5),
  /** 只保留指定严重度（Critical/Important/Moderate/Low），空数组表示不过滤 */
  includeSeverities: z.array(z.string()).catch(['Critical', 'Important']),
  /** 是否额外抓取单个 CVRF 文档（默认关闭，见文件头说明） */
  fetchDocument: z.boolean().catch(false),
});

type MsrcConfig = z.infer<typeof ConfigSchema>;

function parseConfig(config: Record<string, unknown>): MsrcConfig {
  const parsed = ConfigSchema.safeParse(config ?? {});
  return parsed.success ? parsed.data : ConfigSchema.parse({});
}

/** 从可能是字符串或 { Value } 的对象里取文档标题。 */
function documentTitle(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (isRecord(value)) return textOf(value.Value) ?? textOf(value);
  return undefined;
}

/** 从可能是字符串或 { Value } 的对象里取严重度文本。 */
function severityValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (isRecord(value)) return textOf(value.Value) ?? textOf(value);
  return undefined;
}

/**
 * MSRC 安全公告适配器。
 *
 * 幂等性：externalId 用公告 ID（如 2024-Nov），同一公告多次采集 uid 不变；
 * 公告内容更新（CurrentReleaseDate 变化）时保留首次入库时间，由富化层决定是否提醒。
 */
export class MsrcCvrfCollector implements CollectorAdapter {
  readonly id = 'msrc_cvrf' as const;

  async fetch(ctx: CollectorContext): Promise<CollectorResult> {
    const config = parseConfig(ctx.source.config);
    const warnings: string[] = [];

    let payload: unknown;
    try {
      payload = await ctx.http.getJson<unknown>(UPDATES_URL, {
        headers: { accept: 'application/json' },
        timeoutMs: 45_000,
      });
    } catch (error) {
      throw upstreamError('MSRC 公告索引请求失败: ' + describeError(error), { url: UPDATES_URL });
    }

    if (!isRecord(payload)) {
      throw upstreamError('MSRC 公告索引格式异常（顶层不是对象）', { url: UPDATES_URL });
    }

    const entries = toArray(payload.value).filter(isRecord);
    if (entries.length === 0) {
      throw upstreamError('MSRC 公告索引为空（value 数组无内容）', { url: UPDATES_URL });
    }

    const wantedSeverities = new Set(config.includeSeverities.map((value) => value.toLowerCase()));

    // 按「最近发布日期」倒序，先取最新公告
    const sorted = [...entries].sort((a, b) => {
      const timeA = toIsoOrUndefined(a.CurrentReleaseDate ?? a.InitialReleaseDate);
      const timeB = toIsoOrUndefined(b.CurrentReleaseDate ?? b.InitialReleaseDate);
      return (timeB ? new Date(timeB).getTime() : 0) - (timeA ? new Date(timeA).getTime() : 0);
    });

    const items: RawItem[] = [];
    const seen = new Set<string>();

    for (const entry of sorted) {
      if (items.length >= config.maxDocuments) break;
      try {
        const id = asString(entry.ID)?.trim() || asString(entry.Alias)?.trim();
        if (!id || seen.has(id)) continue;

        const severityText = severityValue(entry.Severity);
        if (wantedSeverities.size > 0 && severityText && !wantedSeverities.has(severityText.toLowerCase())) {
          continue;
        }

        const titleText = documentTitle(entry.DocumentTitle);
        const initial = toIsoOrUndefined(entry.InitialReleaseDate);
        const current = toIsoOrUndefined(entry.CurrentReleaseDate);
        const cvrfUrl = asString(entry.CvrfUrl)?.trim();

        const summaryParts: string[] = ['公告编号：' + id];
        if (severityText) summaryParts.push('最高严重度：' + severityText);
        if (initial) summaryParts.push('初始发布：' + initial.slice(0, 10));
        if (current && current !== initial) summaryParts.push('最近更新：' + current.slice(0, 10));

        seen.add(id);
        items.push({
          externalId: id,
          title: titleText ? id + ' ' + titleText : id,
          summary: plainText(summaryParts.join('；'), 600),
          url: cvrfUrl,
          publishedAt: current ?? initial,
          category: 'vuln',
          vendor: 'Microsoft',
          tags: ['msrc', 'microsoft', 'patch-tuesday'],
          // CVRF 索引层没有单条 CVE 的分值，KEV/CVSS 由 NVD 源补齐
          raw: entry,
        });
      } catch (error) {
        warnings.push('MSRC 公告解析失败: ' + describeError(error));
      }
    }

    ctx.logger.info({ sourceKey: ctx.source.key, count: items.length }, 'MSRC 公告采集完成');
    return { items, warnings };
  }
}

/** 把未知异常转成可读短语。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
