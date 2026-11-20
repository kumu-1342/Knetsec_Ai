/**
 * 采集编排器集成测试（无外网）：
 * - 归一化 → 批内去重 → 跨源去重 → 富化 → 入库；
 * - 单源失败不影响其他源，运行记录与 source 计数正确回写；
 * - 重复执行幂等（第二次 itemsNew=0）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type CollectorFactory } from '@knetsec/shared';
import { config } from '../src/config.js';
import { Db } from '../src/infra/db.js';
import { migrate } from '../src/infra/migrations.js';
import { CollectPipeline } from '../src/pipeline/orchestrator.js';
import { silentLogger } from './api-helpers.js';

/** 以测试启动时刻为基准：publishedAt 落在 24h 内，且保证 durationMs >= 0。 */
const NOW = new Date();

let db: Db | null = null;
afterEach(() => {
  if (db) {
    db.close();
    db = null;
  }
});

/** 插入数据源。 */
function insertSource(
  database: Db,
  input: { key: string; name: string; adapter?: string; priority?: number; enabled?: number },
): void {
  const nowIso = new Date().toISOString();
  database.run(
    `INSERT INTO sources (key, name, category, adapter, url, config, enabled, interval_minutes, priority, created_at, updated_at)
     VALUES (?, ?, 'vuln-db', ?, 'https://example.com', '{}', ?, 60, ?, ?, ?)`,
    [
      input.key,
      input.name,
      input.adapter ?? 'rss',
      input.enabled ?? 1,
      input.priority ?? 100,
      nowIso,
      nowIso,
    ],
  );
}

/** 创建一条 running 状态的运行记录并返回 id。 */
function createRun(database: Db, sourcesTotal: number): number {
  return database.run(
    "INSERT INTO fetch_runs (trigger, status, started_at, sources_total) VALUES ('manual', 'running', ?, ?)",
    [new Date().toISOString(), sourcesTotal],
  ).lastInsertRowid;
}

/** 假采集器工厂：不同 key 返回不同数据，src-bad 直接抛错。 */
const fakeFactory: CollectorFactory = (source) => ({
  id: source.adapter,
  async fetch() {
    if (source.key === 'src-bad') throw new Error('上游 500 Internal Server Error');
    if (source.key === 'src-a') {
      return {
        items: [
          {
            externalId: 'a1',
            title: 'Critical RCE in vLLM inference server',
            summary: 'remote code execution via crafted model file',
            url: 'https://example.com/a1',
            category: 'vuln' as const,
            severity: 'critical' as const,
            cvssScore: 9.8,
            isKev: true,
            cveIds: ['CVE-2025-5001'],
            publishedAt: NOW.toISOString(),
          },
          // 批内重复：externalId 相同 → uid 相同，应被 dedupeWithinBatch 去掉
          {
            externalId: 'a1',
            title: 'Critical RCE in vLLM inference server',
            category: 'vuln' as const,
            publishedAt: NOW.toISOString(),
          },
          {
            externalId: 'a2',
            title: 'Prompt injection flaw in LLM agent platform',
            summary: 'prompt injection can redirect tool calls',
            category: 'news' as const,
            publishedAt: NOW.toISOString(),
          },
        ],
      };
    }
    // src-b：与 src-a 的 a1 标题完全相同（跨源重复，应被 findCrossSourceDuplicate 拦截）
    return {
      items: [
        {
          externalId: 'b1',
          title: 'Critical RCE in vLLM inference server',
          category: 'vuln' as const,
          severity: 'critical' as const,
          publishedAt: NOW.toISOString(),
        },
      ],
    };
  },
});

/** 构造编排器（注入假采集器与假 HTTP，绝不访问外网）。 */
function createPipeline(database: Db): CollectPipeline {
  const logger = silentLogger();
  return new CollectPipeline({
    db: database,
    logger,
    config,
    getSettings: () => DEFAULT_SETTINGS,
    collectorFactory: fakeFactory,
    httpFactory: () => ({
      getText: async () => '<rss></rss>',
      getJson: async <T>() => ({}) as T,
    }),
    now: () => NOW,
  });
}

describe('采集编排器', () => {
  it('完整链路：单源失败不影响其他源，批内/跨源去重生效，计数与日志正确', async () => {
    db = new Db(':memory:');
    const logger = silentLogger();
    migrate(db, logger);
    insertSource(db, { key: 'src-a', name: '源 A', priority: 10 });
    insertSource(db, { key: 'src-b', name: '源 B', priority: 20 });
    insertSource(db, { key: 'src-bad', name: '故障源', priority: 30 });

    const runId = createRun(db, 3);
    const summary = await createPipeline(db).run(runId);

    expect(summary.status).toBe('partial');
    expect(summary.sourcesTotal).toBe(3);
    expect(summary.sourcesOk).toBe(2);
    expect(summary.sourcesFailed).toBe(1);
    // src-a 去重后 2 条（a1 批内重复、a2），src-b 的 b1 与 a1 跨源重复被拦截
    expect(summary.itemsNew).toBe(2);
    expect(summary.itemsDuplicate).toBeGreaterThanOrEqual(2);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain('src-bad');
    expect(summary.finishedAt).toBeTruthy();
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);

    const itemCount = db.scalar<number>('SELECT COUNT(1) FROM items');
    expect(itemCount).toBe(2);

    // 富化结果校验：RCE 条目应为 critical + KEV + CVE + AI 分类不冲突
    const rce = db.get<{
      severity: string;
      is_kev: number;
      importance: number;
      tags: string;
      category: string;
    }>("SELECT severity, is_kev, importance, tags, category FROM items WHERE title LIKE '%vLLM%'");
    expect(rce?.severity).toBe('critical');
    expect(rce?.is_kev).toBe(1);
    expect(rce?.importance).toBeGreaterThan(0);

    // source 状态回写
    const sourceA = db.get<{ last_status: string; success_count: number }>(
      "SELECT last_status, success_count FROM sources WHERE key = 'src-a'",
    );
    expect(sourceA?.last_status).toBe('success');
    expect(sourceA?.success_count).toBe(1);
    const sourceBad = db.get<{ last_status: string; failure_count: number; last_error: string }>(
      "SELECT last_status, failure_count, last_error FROM sources WHERE key = 'src-bad'",
    );
    expect(sourceBad?.last_status).toBe('failed');
    expect(sourceBad?.failure_count).toBe(1);
    expect(sourceBad?.last_error).toContain('上游 500');

    // 运行记录回写
    const run = db.get<{
      status: string;
      items_new: number;
      logs: string;
      error: string | null;
      finished_at: string | null;
    }>('SELECT status, items_new, logs, error, finished_at FROM fetch_runs WHERE id = ?', [runId]);
    expect(run?.status).toBe('partial');
    expect(run?.items_new).toBe(2);
    expect(run?.finished_at).toBeTruthy();
    expect(run?.error).toContain('src-bad');
    const logs = JSON.parse(run?.logs ?? '[]') as string[];
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((line) => line.includes('src-a'))).toBe(true);
  });

  it('重复执行幂等：第二次全部命中库内去重', async () => {
    db = new Db(':memory:');
    migrate(db, silentLogger());
    insertSource(db, { key: 'src-a', name: '源 A' });
    insertSource(db, { key: 'src-b', name: '源 B' });

    const pipeline = createPipeline(db);
    const first = await pipeline.run(createRun(db, 2));
    expect(first.itemsNew).toBe(2);

    const second = await pipeline.run(createRun(db, 2));
    expect(second.status).toBe('success');
    expect(second.itemsNew).toBe(0);
    expect(second.itemsDuplicate).toBeGreaterThanOrEqual(2);
    expect(db.scalar<number>('SELECT COUNT(1) FROM items')).toBe(2);
  });

  it('全部源失败时运行状态为 failed', async () => {
    db = new Db(':memory:');
    migrate(db, silentLogger());
    insertSource(db, { key: 'src-bad', name: '故障源' });

    const summary = await createPipeline(db).run(createRun(db, 1), ['src-bad']);
    expect(summary.status).toBe('failed');
    expect(summary.sourcesOk).toBe(0);
    expect(summary.sourcesFailed).toBe(1);
    expect(db.scalar<number>('SELECT COUNT(1) FROM items')).toBe(0);
  });

  it('指定 sourceKeys 只采集对应源', async () => {
    db = new Db(':memory:');
    migrate(db, silentLogger());
    insertSource(db, { key: 'src-a', name: '源 A' });
    insertSource(db, { key: 'src-b', name: '源 B' });

    const summary = await createPipeline(db).run(createRun(db, 1), ['src-a']);
    expect(summary.sourcesTotal).toBe(1);
    expect(summary.status).toBe('success');
    expect(summary.itemsNew).toBe(2);
  });
});
