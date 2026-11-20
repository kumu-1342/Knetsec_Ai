/**
 * 采集任务启动器：并发互斥 + fetch_runs 记录 + 异步执行。
 *
 * 为什么单独抽模块：POST /tasks/fetch 与调度器都需要「加锁 → 建运行记录 → 异步跑编排器」，
 * 逻辑集中一份可避免两处竞态（例如调度器与手动触发同时启动两个 run）。
 *
 * 互斥两层：
 * 1. 进程内内存标记 activeRunId（最快，防同一进程竞态）；
 * 2. 数据库 fetch_runs.status='running' 检查（防进程重启后遗留的僵尸 run 与新 run 并发）。
 */
import type { RunTrigger, StartFetchResult } from '@knetsec/shared';
import { badRequest, conflict } from '../../infra/errors.js';
import type { Db } from '../../infra/db.js';
import type { AppLogger } from '../../infra/logger.js';
import type { PipelineRunner } from '../core/context.js';

/** 当前进程内正在运行的采集任务 id。 */
let activeRunId: number | null = null;

/** 读取内存中的运行中任务 id（调度器与 /tasks/status 使用）。 */
export function getActiveRunId(): number | null {
  return activeRunId;
}

/** 启动器依赖。 */
export interface StartRunDeps {
  db: Db;
  logger: AppLogger;
  pipeline: PipelineRunner;
}

/** 启动参数。 */
export interface StartRunOptions {
  /** 指定数据源 key；缺省为全部启用源。 */
  sourceKeys?: string[];
  trigger: RunTrigger;
  /** 操作者用户名（审计与日志）。 */
  username: string;
}

/**
 * 把进程重启前遗留的 running 记录标记为 failed。
 * 否则 /tasks/fetch 会永远返回 409，面板上也一直显示「运行中」。
 */
export function markStaleRuns(deps: Pick<StartRunDeps, 'db' | 'logger'>): number {
  const result = deps.db.run(
    "UPDATE fetch_runs SET status = 'failed', finished_at = ?, error = ? WHERE status = 'running'",
    [new Date().toISOString(), '服务重启导致任务中断（已自动标记为失败）'],
  );
  if (result.changes > 0) {
    deps.logger.warn({ count: result.changes }, '已清理上次进程遗留的运行中任务');
  }
  return result.changes;
}

/**
 * 创建一次采集任务并异步执行。
 *
 * @throws AppError(CONFLICT) 已有任务运行中
 * @throws AppError(VALIDATION_ERROR) 数据源不存在或没有可用数据源
 */
export function startFetchRun(deps: StartRunDeps, options: StartRunOptions): StartFetchResult {
  const { db, logger, pipeline } = deps;

  if (activeRunId !== null) {
    throw conflict(`已有采集任务正在运行（#${activeRunId}），请稍后再试`);
  }
  const running = db.get<{ id: number }>("SELECT id FROM fetch_runs WHERE status = 'running' LIMIT 1");
  if (running) {
    throw conflict(`已有采集任务正在运行（#${running.id}），请稍后再试`);
  }

  let sourceKeys: string[] | undefined;
  if (options.sourceKeys && options.sourceKeys.length > 0) {
    const unique = [...new Set(options.sourceKeys.filter((key) => key.length > 0))];
    const placeholders = unique.map(() => '?').join(', ');
    const found = db.all<{ key: string }>(`SELECT key FROM sources WHERE key IN (${placeholders})`, unique);
    const foundKeys = new Set(found.map((row) => row.key));
    const missing = unique.filter((key) => !foundKeys.has(key));
    if (missing.length > 0) throw badRequest(`数据源不存在：${missing.join(', ')}`);
    sourceKeys = unique;
  }

  const enabledCount = db.scalar<number>('SELECT COUNT(1) FROM sources WHERE enabled = 1') ?? 0;
  if (!sourceKeys && enabledCount === 0) {
    throw badRequest('没有启用的数据源，请先在「数据源管理」中启用或新增');
  }

  const startedAt = new Date().toISOString();
  const sourcesTotal = sourceKeys?.length ?? enabledCount;
  const runId = db.run(
    'INSERT INTO fetch_runs (trigger, status, started_at, sources_total) VALUES (?, ?, ?, ?)',
    [options.trigger, 'running', startedAt, sourcesTotal],
  ).lastInsertRowid;

  activeRunId = runId;
  logger.info(
    { runId, trigger: options.trigger, sourcesTotal, username: options.username },
    '采集任务已启动（异步执行）',
  );

  // 异步执行，不阻塞 HTTP 响应；编排器内部已兜底所有异常并回写 fetch_runs
  void Promise.resolve()
    .then(() => pipeline.run(runId, sourceKeys))
    .then((summary) => {
      logger.info(
        { runId, status: summary.status, itemsNew: summary.itemsNew, errors: summary.errors.length },
        '采集任务执行结束',
      );
    })
    .catch((error: unknown) => {
      logger.error({ runId, err: String(error) }, '采集任务执行异常');
      try {
        db.run(
          "UPDATE fetch_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND status = 'running'",
          [new Date().toISOString(), String(error).slice(0, 2000), runId],
        );
      } catch (updateError) {
        logger.error({ runId, err: String(updateError) }, '回写采集任务失败状态时出错');
      }
    })
    .finally(() => {
      if (activeRunId === runId) activeRunId = null;
    });

  return { runId, status: 'running' };
}
