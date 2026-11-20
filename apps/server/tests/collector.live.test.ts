/**
 * LIVE 真实采集测试（无网络/离线环境默认跳过）。
 *
 * 为什么单独一个文件 + 环境变量门控：单元测试必须秒级、可重复、不依赖外网；
 * 真实抓取会被上游限流、网络波动、代理策略影响，只能作为「联调/验收」手段。
 * 运行方式（PowerShell）：
 *   $env:LIVE='1'; npx vitest run tests/collector.live.test.ts
 *
 * 断言目标（docs/00 §12 验收口径）：
 * 1. 每个源都能返回 items.length > 0（证明解析链路可用）；
 * 2. 每条条目的必填字段合法（title 非空、url 是 http(s)、publishedAt 可被 Date 解析）。
 *
 * 失败分两类（原因见 docs/04 §5.3）：
 * - 环境类（网络不可达 / 未认证配额耗尽 / 站点反爬 403）：记为 NETWORK 并打印警告，
 *   不判测试失败——换机器或配 GITHUB_TOKEN/NVD_API_KEY/代理即可，与代码无关；
 * - 代码类（解析异常、字段缺失、结构变更、空结果且无环境类告警）：判测试失败。
 *
 * 实测注意：GitHub 未认证配额 60 次/小时，一轮 LIVE（GHSA×2 + releases×5 + search×2）
 * 约消耗 11 次，连续跑几轮就会触发 403 rate limit，此时 GitHub 相关源会显示 NETWORK。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type CollectorContext, type SourceDescriptor } from '@knetsec/shared';
import { createCollector } from '../src/collectors/index.js';
import { DEFAULT_SOURCES, findDefaultSource } from '../src/seed/sources.seed.js';
import { HttpClient } from '../src/infra/http.js';

/** 是否处于 LIVE 模式（默认关闭，避免 CI/离线环境误跑）。 */
const LIVE = process.env.LIVE === '1' || process.env.LIVE === 'true';

/** 尽力读取仓库根的 .env（有 GITHUB_TOKEN/NVD_API_KEY 时能显著降低限流失败率）。 */
function loadDotEnvIfPresent(): void {
  try {
    process.loadEnvFile('../../.env');
  } catch {
    // .env 不存在或 Node 版本不支持时忽略：LIVE 测试不强制要求 Token
  }
}
loadDotEnvIfPresent();

/** 单源实测结果，afterAll 打印成表格便于贴进 docs/04 与验收报告。 */
interface LiveResult {
  sourceKey: string;
  count: number;
  durationMs: number;
  warnings: number;
  status: 'OK' | 'NETWORK' | 'FAIL';
  error: string;
}

const results: LiveResult[] = [];

/** 待实测的源（覆盖 8 类适配器）。 */
interface LiveCase {
  key: string;
}

const LIVE_CASES: LiveCase[] = [
  { key: 'cisa-kev' },
  { key: 'github-ghsa' },
  { key: 'github-ghsa-ai' },
  { key: 'github-releases' },
  { key: 'github-ai-security-projects' },
  { key: 'nvd-recent' },
  { key: 'msrc' },
  { key: 'arxiv-cr' },
  { key: 'github-blog' },
  // Unit 42 首字节常需 20s+，且实测出现过 fetch failed（站点侧限速）
  { key: 'unit42' },
  { key: 'exploit-db' },
  { key: 'freebuf' },
  { key: 'openai' },
];

/**
 * 判断错误是否属于「环境类失败」——上游网络不可达，或未认证配额/限流。
 *
 * 为什么要区分：这两类失败与适配器代码无关（换台机器、配个 Token 就能过），
 * 如果一律判测试失败，LIVE 测试会变成"网络抽奖"，反而让人不再相信它的红灯。
 * 真正的回归信号是：解析异常、字段缺失、结构变更（这些仍然会让测试失败）。
 *
 * 403 在此被视为环境类：GitHub 未认证额度用尽时返回 403 + "rate limit exceeded"，
 * 而站点反爬 403 同样属"环境/合规"问题，不应让采集器单测变红（由 docs/04 §5 记录）。
 */
function isEnvironmentalError(message: string): boolean {
  return /fetch failed|ECONNRESET|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|aborted|timeout|socket|ENOTFOUND|EAI_AGAIN|rate limit|HTTP 403|HTTP 429|HTTP 5\d\d|quota/i.test(
    message,
  );
}

/** 构造真实执行上下文（真实 HttpClient，无 mock）。 */
function buildContext(source: SourceDescriptor): CollectorContext {
  return {
    source,
    now: new Date(),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    http: new HttpClient({ timeoutMs: 60_000, retries: 2 }),
    settings: DEFAULT_SETTINGS,
    secrets: {
      githubToken: process.env.GITHUB_TOKEN ?? '',
      nvdApiKey: process.env.NVD_API_KEY ?? '',
    },
  };
}

/** 把种子条目转成运行期 SourceDescriptor（id 用序号占位，适配器不使用 id）。 */
function toDescriptor(key: string): SourceDescriptor {
  const seed = findDefaultSource(key);
  if (!seed) throw new Error('未知的数据源 key: ' + key);
  const index = DEFAULT_SOURCES.findIndex((source) => source.key === key);
  return {
    id: index + 1,
    key: seed.key,
    name: seed.name,
    category: seed.category,
    adapter: seed.adapter,
    url: seed.url ?? null,
    config: seed.config,
    enabled: seed.enabled,
    intervalMinutes: seed.intervalMinutes,
    priority: seed.priority,
  };
}

describe.skipIf(!LIVE)('LIVE 真实采集', () => {
  it.each(LIVE_CASES.map((entry) => [entry.key] as const))(
    '%s 能抓到条目且字段合法',
    async (key) => {
      const descriptor = toDescriptor(key);
      const ctx = buildContext(descriptor);
      const adapter = createCollector(descriptor);
      const startedAt = Date.now();

      let result;
      try {
        result = await adapter.fetch(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          sourceKey: key,
          count: 0,
          durationMs: Date.now() - startedAt,
          warnings: 0,
          status: isEnvironmentalError(message) ? 'NETWORK' : 'FAIL',
          error: message.slice(0, 200),
        });
        if (isEnvironmentalError(message)) {
          // 环境类失败：不判测试失败，但必须在输出里显式暴露，避免被忽略
          console.warn('[LIVE][ENV] ' + key + ' 环境类失败（网络/配额）: ' + message.slice(0, 140));
          return;
        }
        throw error;
      }

      const durationMs = Date.now() - startedAt;

      // 0) 多请求源（releases/GHSA）单请求失败时不会抛错，只会返回空条目 + warnings；
      //    若 warnings 全部是环境类，则同样按 NETWORK 处理，避免把配额问题误判为回归
      const warnings = result.warnings ?? [];
      if (
        result.items.length === 0 &&
        warnings.length > 0 &&
        warnings.every((warning) => isEnvironmentalError(warning))
      ) {
        results.push({
          sourceKey: key,
          count: 0,
          durationMs,
          warnings: warnings.length,
          status: 'NETWORK',
          error: warnings[0]?.slice(0, 200) ?? '',
        });
        console.warn('[LIVE][ENV] ' + key + ' 全部子请求环境类失败: ' + (warnings[0] ?? '').slice(0, 140));
        return;
      }

      // 1) 必须能解析出条目（空结果且无环境类告警 = 该源失效，需要排查）
      expect(result.items.length).toBeGreaterThan(0);

      // 2) 字段合法性：标题必填；有 url 必须是 http(s)；有发布时间必须可解析
      for (const item of result.items) {
        expect(typeof item.title).toBe('string');
        expect(item.title.trim().length).toBeGreaterThan(0);
        if (item.url !== undefined) {
          expect(item.url).toMatch(/^https?:\/\//);
        }
        if (item.publishedAt !== undefined) {
          expect(Number.isNaN(new Date(item.publishedAt).getTime())).toBe(false);
        }
      }

      results.push({
        sourceKey: key,
        count: result.items.length,
        durationMs,
        warnings: result.warnings?.length ?? 0,
        status: 'OK',
        error: '',
      });
      console.log(
        '[LIVE] ' +
          key +
          ' → ' +
          String(result.items.length) +
          ' 条 / ' +
          String(durationMs) +
          'ms / 首条: ' +
          result.items[0]?.title.slice(0, 80),
      );
    },
    300_000,
  );

  afterAll(() => {
    console.log('\n=== LIVE 实测结果（源 / 条数 / 耗时 / warnings / 状态）===');
    for (const row of results) {
      console.log(
        [
          row.sourceKey.padEnd(30),
          String(row.count).padStart(4),
          String(row.durationMs + 'ms').padStart(8),
          'warn=' + String(row.warnings),
          row.status === 'OK' ? 'OK' : row.status + ': ' + row.error,
        ].join('  '),
      );
    }
    const ok = results.filter((row) => row.status === 'OK').length;
    const network = results.filter((row) => row.status === 'NETWORK').length;
    console.log(
      '成功源: ' + String(ok) + ' / ' + String(results.length) + '（网络不可达: ' + String(network) + '）',
    );
  });
});
