/**
 * 采集编排器：一次采集任务的完整生命周期（契约 §4 / §7.3）。
 *
 * 职责：
 * 1. 按 sourceKeys（或全部启用的源）逐个执行适配器，单源失败只记录、不中断整轮；
 * 2. 归一化 → 批内去重 → 跨源去重 → 富化（含可选 LLM）→ 事务批量入库；
 * 3. 回写 sources 的 last_run_at / 状态 / 计数，回写 fetch_runs 统计与结构化日志；
 * 4. 新增条目含 critical 或 KEV 且通知开启时，推送 Webhook。
 *
 * 并发约定：同一时刻只允许一个 run（由 modules/tasks/runner.ts 加锁并检查 fetch_runs.status），
 * 因此这里不需要额外锁；但每个 run 内部严格串行执行源，避免触发上游限流。
 */
import type {
  AppSettings,
  CollectorAdapter,
  CollectorContext,
  CollectorHttpClient,
  CollectorLogger,
  NormalizedItem,
  RunStatus,
  SourceDescriptor,
} from '@knetsec/shared';
import type { AppConfig } from '../config.js';
import { createCollector } from '../collectors/index.js';
import type { Db } from '../infra/db.js';
import { HttpClient } from '../infra/http.js';
import type { AppLogger } from '../infra/logger.js';
import { dedupeWithinBatch, findCrossSourceDuplicate, normalizeRawItem } from './index.js';
import { enrichItemWithLlm } from './enrich.js';
import { notifyCriticalItems } from './notification.js';

/** 单源整体超时上限（契约要求 90s），防止某个适配器无限挂起拖死整轮。 */
export const DEFAULT_SOURCE_TIMEOUT_MS = 90_000;
/** fetch_runs.logs 最多保留的日志行数（契约 §5.3）。 */
const MAX_LOG_LINES = 1000;
/** 单行日志最大长度，避免异常堆栈撑爆 SQLite 行。 */
const MAX_LOG_LINE_LENGTH = 1000;

/** 一次采集任务的汇总结果（供 /tasks 接口与调度日志使用）。 */
export interface RunSummary {
  runId: number;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sourcesTotal: number;
  sourcesOk: number;
  sourcesFailed: number;
  itemsNew: number;
  itemsDuplicate: number;
  /** 每个失败源的简短错误，便于面板直接展示。 */
  errors: string[];
}

/** 采集器工厂（与 modules/core/context.ts 的 CollectorFactory 结构一致）。 */
export type OrchestratorCollectorFactory = (source: SourceDescriptor) => CollectorAdapter;

/** 编排器依赖：全部可注入，测试时替换 collectorFactory / httpFactory / fetchImpl 即可离线跑。 */
export interface PipelineDeps {
  db: Db;
  logger: AppLogger;
  /** 仅需代理与凭据两项，避免编排器依赖整个配置对象。 */
  config: Pick<AppConfig, 'httpProxy' | 'secrets'>;
  /** 同步读取当前系统设置（SettingsStore.get 有缓存）。 */
  getSettings: () => AppSettings;
  /** 采集器工厂，默认使用 collectors/index.ts 的 createCollector。 */
  collectorFactory?: OrchestratorCollectorFactory;
  /** HTTP 客户端工厂，测试可注入假实现避免外网。 */
  httpFactory?: (logger: CollectorLogger) => CollectorHttpClient;
  /** 时钟，测试注入固定时间。 */
  now?: () => Date;
  /** 单源超时毫秒数，默认 90s。 */
  sourceTimeoutMs?: number;
  /** 通知 fetch，测试注入假实现。 */
  notificationFetch?: typeof fetch;
  /** LLM fetch，测试注入假实现。 */
  llmFetch?: typeof fetch;
}

/** sources 表原始行（只取适配器需要的列）。 */
interface SourceRow {
  id: number;
  key: string;
  name: string;
  category: string;
  adapter: string;
  url: string | null;
  config: string;
  enabled: number;
  interval_minutes: number;
  priority: number;
}

/** items 批量插入语句：ON CONFLICT 依赖 uid 唯一索引，天然幂等（契约 §8.1.2）。 */
const INSERT_ITEM_SQL = `INSERT INTO items (
  uid, source_key, source_name, title, summary, url, author, published_at, fetched_at,
  category, tags, severity, cve_ids, ghsa_ids, cvss_score, is_kev, vendor, lang,
  importance, raw, is_read, is_starred, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
ON CONFLICT(uid) DO NOTHING`;

/** fetch_runs 可更新字段（白名单，避免动态 SQL 注入面）。 */
interface RunPatch {
  status?: RunStatus;
  startedAt?: string;
  finishedAt?: string | null;
  sourcesTotal?: number;
  sourcesOk?: number;
  sourcesFailed?: number;
  itemsNew?: number;
  itemsDuplicate?: number;
  error?: string | null;
}

/** 把 Promise 包上超时：超时仅放弃等待（底层 HTTP 有自己的超时），确保整轮不会永久挂起。 */
function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    // unref 防止定时器阻止进程退出（优雅关闭时很重要）
    timer.unref?.();
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** 解析 sources.config JSON，脏数据回退空对象。 */
function parseSourceConfig(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 配置损坏时按空配置执行，适配器内部会用默认值兜底
  }
  return {};
}

/** 采集编排器。 */
export class CollectPipeline {
  constructor(private readonly deps: PipelineDeps) {}

  /**
   * 执行一次采集任务。
   *
   * @param runId 已由调用方写入 fetch_runs（status=running）的行 id
   * @param sourceKeys 指定数据源 key；缺省表示全部启用源
   * @returns 运行汇总；本方法不抛错（所有异常都会折算成 failed 状态与日志）
   */
  async run(runId: number, sourceKeys?: string[]): Promise<RunSummary> {
    const startedAt = this.deps.now?.() ?? new Date();
    try {
      return await this.execute(runId, sourceKeys, startedAt);
    } catch (error) {
      // 兜底：即使编排器自身出现意外错误，也要把运行记录标记为 failed，避免永远停在 running
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.error({ runId, err: message }, '采集任务异常终止');
      const finishedAt = new Date();
      this.patchRun(runId, {
        status: 'failed',
        finishedAt: finishedAt.toISOString(),
        error: `编排器异常：${message}`.slice(0, 2000),
      });
      return {
        runId,
        status: 'failed',
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        sourcesTotal: 0,
        sourcesOk: 0,
        sourcesFailed: 0,
        itemsNew: 0,
        itemsDuplicate: 0,
        errors: [message],
      };
    }
  }

  /** 实际执行流程（拆出来便于 run() 统一兜底）。 */
  private async execute(runId: number, sourceKeys: string[] | undefined, startedAt: Date): Promise<RunSummary> {
    const { db, logger } = this.deps;
    const now = this.deps.now?.() ?? startedAt;
    const settings = this.deps.getSettings();
    const logs: string[] = [];
    const errors: string[] = [];

    const log = (message: string): void => {
      const line = `${new Date().toISOString()} ${message}`.slice(0, MAX_LOG_LINE_LENGTH);
      logs.push(line);
      if (logs.length > MAX_LOG_LINES) logs.shift();
      logger.info({ runId }, message);
    };
    const flushRun = (patch: RunPatch): void => {
      this.patchRun(runId, { ...patch, logs });
    };

    const sources = this.loadSources(sourceKeys);
    flushRun({ status: 'running', startedAt: startedAt.toISOString(), sourcesTotal: sources.length });
    log(`开始采集，共 ${sources.length} 个数据源${sourceKeys?.length ? `（指定：${sourceKeys.join(', ')}）` : '（全部启用源）'}`);

    let sourcesOk = 0;
    let sourcesFailed = 0;
    let itemsNew = 0;
    let itemsDuplicate = 0;
    const criticalItems: NormalizedItem[] = [];

    for (const source of sources) {
      const sourceLogger = logger.child({ runId, sourceKey: source.key });
      const collectorLogger = sourceLogger as unknown as CollectorLogger;
      const sourceStartedAt = Date.now();

      try {
        const adapter = (this.deps.collectorFactory ?? createCollector)(source);
        const http = this.deps.httpFactory?.(collectorLogger) ?? new HttpClient({
          proxyUrl: this.deps.config.httpProxy,
          logger: collectorLogger,
        });

        const ctx: CollectorContext = {
          source,
          now,
          logger: collectorLogger,
          http,
          settings,
          secrets: this.deps.config.secrets,
        };

        const result = await withTimeout(
          adapter.fetch(ctx),
          this.deps.sourceTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS,
          `数据源 ${source.key} 采集超时`,
        );

        if (result.warnings && result.warnings.length > 0) {
          log(`[${source.key}] 适配器告警 ${result.warnings.length} 条：${result.warnings.slice(0, 3).join('；')}`);
        }

        // 逐条归一化：单条结构异常只跳过该条（容错要求）
        const normalized: NormalizedItem[] = [];
        for (const raw of result.items) {
          try {
            normalized.push(normalizeRawItem(raw, source, now));
          } catch (error) {
            log(`[${source.key}] 条目归一化失败已跳过：${String(error)}`);
          }
        }

        const { unique, duplicateCount } = dedupeWithinBatch(normalized);
        itemsDuplicate += duplicateCount;

        const pending: NormalizedItem[] = [];
        for (const item of unique) {
          // 跨源/库内去重：同一事件不同来源只保留优先级更高（priority 数值更小）的源
          const cross = findCrossSourceDuplicate(db, item);
          if (cross.duplicate) {
            itemsDuplicate += 1;
            continue;
          }
          const enriched = await enrichItemWithLlm(item, settings, {
            now,
            logger: collectorLogger,
            fetchImpl: this.deps.llmFetch,
          });
          pending.push(enriched);
          if ((enriched.severity === 'critical' || enriched.isKev) && settings.notificationEnabled) {
            criticalItems.push(enriched);
          }
        }

        // 单事务批量写入：减少 WAL 提交次数，冲突（库内已存在）计入重复
        const inserted = db.transaction(() => {
          let count = 0;
          for (const item of pending) {
            const result = db.run(INSERT_ITEM_SQL, [
              item.uid,
              item.sourceKey,
              item.sourceName,
              item.title,
              item.summary,
              item.url,
              item.author,
              item.publishedAt,
              item.fetchedAt,
              item.category,
              JSON.stringify(item.tags),
              item.severity,
              JSON.stringify(item.cveIds),
              JSON.stringify(item.ghsaIds),
              item.cvssScore,
              item.isKev ? 1 : 0,
              item.vendor,
              item.lang,
              item.importance,
              item.raw,
              new Date().toISOString(),
            ]);
            if (result.changes > 0) count += 1;
          }
          return count;
        });

        itemsNew += inserted;
        itemsDuplicate += pending.length - inserted;
        sourcesOk += 1;

        const durationMs = Date.now() - sourceStartedAt;
        db.run(
          `UPDATE sources SET last_run_at = ?, last_status = 'success', last_error = NULL,
             success_count = success_count + 1, updated_at = ? WHERE id = ?`,
          [new Date().toISOString(), new Date().toISOString(), source.id],
        );
        log(
          `[${source.key}] 采集成功：抓取 ${result.items.length} 条，归一化 ${normalized.length} 条，入库 ${inserted} 条，本批去重 ${duplicateCount} 条，耗时 ${durationMs}ms`,
        );
      } catch (error) {
        sourcesFailed += 1;
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        errors.push(`${source.key}: ${message}`);
        const nowIso = new Date().toISOString();
        try {
          db.run(
            `UPDATE sources SET last_run_at = ?, last_status = 'failed', last_error = ?,
               failure_count = failure_count + 1, updated_at = ? WHERE id = ?`,
            [nowIso, message, nowIso, source.id],
          );
        } catch (updateError) {
          logger.warn({ sourceKey: source.key, err: String(updateError) }, '更新数据源失败状态时出错');
        }
        log(`[${source.key}] 采集失败：${message}`);
        logger.warn({ runId, sourceKey: source.key, err: message }, '数据源采集失败，继续下一源');
      } finally {
        // 每源结束都落一次运行进度，面板可近实时看到进展
        flushRun({
          sourcesOk,
          sourcesFailed,
          itemsNew,
          itemsDuplicate,
          error: errors.length > 0 ? errors.join('；').slice(0, 2000) : null,
        });
      }
    }

    // 通知：仅当本轮确实新增了 critical / KEV 条目且开关打开
    if (criticalItems.length > 0) {
      const result = await notifyCriticalItems(criticalItems, settings, logger, {
        fetchImpl: this.deps.notificationFetch,
        runId,
      });
      log(
        result.sent
          ? `已推送 ${result.itemCount} 条高优先级情报到 ${result.channel} 渠道`
          : `高优先级情报推送未完成：${result.error ?? '通知未启用'}`,
      );
    }

    const finishedAt = new Date();
    const status: RunStatus =
      sources.length === 0 || sourcesOk === 0 && sourcesFailed === 0
        ? 'success'
        : sourcesOk === 0
          ? 'failed'
          : sourcesFailed > 0
            ? 'partial'
            : 'success';

    flushRun({
      status,
      finishedAt: finishedAt.toISOString(),
      sourcesOk,
      sourcesFailed,
      itemsNew,
      itemsDuplicate,
      error: errors.length > 0 ? errors.join('；').slice(0, 2000) : null,
    });
    log(`采集结束：成功 ${sourcesOk} 源、失败 ${sourcesFailed} 源、新增 ${itemsNew} 条、去重 ${itemsDuplicate} 条，状态 ${status}`);

    return {
      runId,
      status,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      sourcesTotal: sources.length,
      sourcesOk,
      sourcesFailed,
      itemsNew,
      itemsDuplicate,
      errors,
    };
  }

  /** 加载待采集源：指定 key 时按 key 精确取（允许手动采停用源），否则取全部启用源。 */
  private loadSources(sourceKeys?: string[]): SourceDescriptor[] {
    const baseSql =
      'SELECT id, key, name, category, adapter, url, config, enabled, interval_minutes, priority FROM sources';
    let rows: SourceRow[];
    if (sourceKeys && sourceKeys.length > 0) {
      const placeholders = sourceKeys.map(() => '?').join(', ');
      rows = this.deps.db.all<SourceRow>(
        `${baseSql} WHERE key IN (${placeholders}) ORDER BY priority ASC, id ASC`,
        sourceKeys,
      );
    } else {
      rows = this.deps.db.all<SourceRow>(`${baseSql} WHERE enabled = 1 ORDER BY priority ASC, id ASC`);
    }
    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      category: row.category as SourceDescriptor['category'],
      adapter: row.adapter as SourceDescriptor['adapter'],
      url: row.url,
      config: parseSourceConfig(row.config),
      enabled: row.enabled === 1,
      intervalMinutes: row.interval_minutes,
      priority: row.priority,
    }));
  }

  /** 更新 fetch_runs 行（列名来自代码白名单，值全部参数化）。 */
  private patchRun(runId: number, patch: RunPatch & { logs?: string[] }): void {
    const assignments: string[] = [];
    const params: Array<string | number | null> = [];
    const mapping: Array<[keyof RunPatch, string]> = [
      ['status', 'status'],
      ['startedAt', 'started_at'],
      ['finishedAt', 'finished_at'],
      ['sourcesTotal', 'sources_total'],
      ['sourcesOk', 'sources_ok'],
      ['sourcesFailed', 'sources_failed'],
      ['itemsNew', 'items_new'],
      ['itemsDuplicate', 'items_duplicate'],
      ['error', 'error'],
    ];
    for (const [key, column] of mapping) {
      const value = patch[key];
      if (value === undefined) continue;
      assignments.push(`${column} = ?`);
      params.push(value);
    }
    if (patch.logs) {
      assignments.push('logs = ?');
      params.push(JSON.stringify(patch.logs));
    }
    if (assignments.length === 0) return;
    params.push(runId);
    this.deps.db.run(`UPDATE fetch_runs SET ${assignments.join(', ')} WHERE id = ?`, params);
  }
}
