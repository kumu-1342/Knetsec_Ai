/**
 * CISA KEV（Known Exploited Vulnerabilities）适配器。
 *
 * 数据价值：KEV 是「已在野被利用」的权威清单，是安全运营的最高优先级信号，
 * 报告中的「漏洞与补丁」章节按 KEV 优先排序，因此本源的条目会被强制提升严重度。
 *
 * 接口：GET https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json
 * 特点：整份清单约 1.8MB、上千条，单次全量下载后在本地按 dateAdded 过滤最近 N 天，
 * 因此只需 1 次请求，且不需要分页。
 */
import { z } from 'zod';
import type { CollectorAdapter, CollectorContext, CollectorResult, RawItem } from '@knetsec/shared';
import { upstreamError } from '../infra/errors.js';
import {
  asString,
  isRecord,
  plainText,
  sleep,
  suggestAiCategory,
  toArray,
  toIsoOrUndefined,
} from './helpers.js';

const KEV_FEED_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';

/** KEV 清单整体较大，给足超时时间（实测本机约 3-5 秒）。 */
const KEV_TIMEOUT_MS = 45_000;

/** 下载尝试次数：Akamai 边缘节点偶发连接超时，多试一次能显著降低单轮失败率。 */
const KEV_MAX_ATTEMPTS = 2;

/** 重试前的等待时间：给 DNS/边缘路由一点切换时间。 */
const KEV_RETRY_DELAY_MS = 2_000;

/** 配置：默认只看最近 30 天新增的 KEV 条目，避免首次接入把历史全量灌进库。 */
const ConfigSchema = z.object({
  days: z.number().int().min(1).max(730).catch(30),
  /** 最多返回条数，防止首次接入条目过多（引擎侧还有批内去重兜底） */
  maxItems: z.number().int().min(1).max(2000).catch(200),
  /** 是否只保留「已确认被勒索软件利用」的条目（最高优先级） */
  ransomwareOnly: z.boolean().catch(false),
});

type KevConfig = z.infer<typeof ConfigSchema>;

function parseConfig(config: Record<string, unknown>): KevConfig {
  const parsed = ConfigSchema.safeParse(config ?? {});
  return parsed.success ? parsed.data : ConfigSchema.parse({});
}

/**
 * CISA KEV 适配器。
 *
 * 严重度策略：KEV 本身不提供 CVSS，但「在野利用」意味着风险天然高危；
 * 若 knownRansomwareCampaignUse 为 Known，则进一步标为 critical。
 */
export class CisaKevCollector implements CollectorAdapter {
  readonly id = 'cisa_kev' as const;

  async fetch(ctx: CollectorContext): Promise<CollectorResult> {
    const config = parseConfig(ctx.source.config);
    const warnings: string[] = [];

    // 实测：www.cisa.gov 走 Akamai，边缘节点会偶发 TCP 连接超时（UND_ERR_CONNECT_TIMEOUT）。
    // HttpClient 内部已有 2 次退避重试，这里再加一次「换一次 DNS 解析」的机会：
    // 单次全量下载（约 1.8MB）成功即可覆盖全部条目，多试一次的成本可以接受。
    let payload: unknown;
    let lastError: unknown;
    for (let attempt = 0; attempt < KEV_MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(KEV_RETRY_DELAY_MS);
      try {
        payload = await ctx.http.getJson<unknown>(KEV_FEED_URL, { timeoutMs: KEV_TIMEOUT_MS });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (payload === undefined) {
      throw upstreamError(
        'CISA KEV 清单下载失败（上游边缘节点连接超时，可稍后重试或配置代理）: ' + describeError(lastError),
        { url: KEV_FEED_URL },
      );
    }

    if (!isRecord(payload)) {
      throw upstreamError('CISA KEV 清单格式异常（顶层不是对象）', { url: KEV_FEED_URL });
    }

    const catalogVersion = asString(payload.catalogVersion) ?? '';
    const cutoff = ctx.now.getTime() - config.days * 24 * 60 * 60 * 1000;
    const items: RawItem[] = [];

    for (const entry of toArray(payload.vulnerabilities)) {
      if (items.length >= config.maxItems) break;
      if (!isRecord(entry)) continue;

      try {
        const cveId = asString(entry.cveID)?.trim().toUpperCase();
        const name = asString(entry.vulnerabilityName)?.trim();
        if (!cveId || !name) continue;

        const dateAdded = toIsoOrUndefined(entry.dateAdded);
        // 时间窗过滤：dateAdded 无法解析时保留（宁可多一条，不要漏掉新在野利用）
        if (dateAdded && new Date(dateAdded).getTime() < cutoff) continue;

        const ransomware = (asString(entry.knownRansomwareCampaignUse) ?? '').toLowerCase() === 'known';
        if (config.ransomwareOnly && !ransomware) continue;

        const vendor = asString(entry.vendorProject)?.trim();
        const product = asString(entry.product)?.trim();
        const shortDescription = asString(entry.shortDescription) ?? '';
        const requiredAction = asString(entry.requiredAction) ?? '';
        const dueDate = asString(entry.dueDate) ?? '';

        const summaryParts: string[] = [];
        if (vendor || product)
          summaryParts.push('受影响组件：' + [vendor, product].filter(Boolean).join(' / '));
        if (shortDescription) summaryParts.push(shortDescription);
        if (requiredAction) summaryParts.push('处置建议：' + requiredAction);
        if (dueDate) summaryParts.push('修复期限：' + dueDate);

        const text = [name, shortDescription, vendor ?? '', product ?? ''].join(' ');
        const tags = ['kev', 'cisa', 'in-the-wild'];
        if (ransomware) tags.push('ransomware');

        const item: RawItem = {
          externalId: cveId,
          title: cveId + ' ' + name,
          summary: plainText(summaryParts.join('；'), 600),
          // KEV 条目本身没有详情页，统一指向 NVD 详情（信息更全且稳定）
          url: 'https://nvd.nist.gov/vuln/detail/' + cveId,
          publishedAt: dateAdded,
          category: suggestAiCategory(text, 'vuln'),
          severity: ransomware ? 'critical' : 'high',
          cveIds: [cveId],
          isKev: true,
          vendor,
          tags,
          raw: entry,
        };
        items.push(item);
      } catch (error) {
        warnings.push('KEV 条目解析失败: ' + describeError(error));
      }
    }

    ctx.logger.info({ sourceKey: ctx.source.key, count: items.length, catalogVersion }, 'CISA KEV 采集完成');
    if (items.length === 0) {
      warnings.push('最近 ' + String(config.days) + ' 天无 KEV 新增条目');
    }
    return { items, warnings };
  }
}

/** 把未知异常转成可读短语。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
