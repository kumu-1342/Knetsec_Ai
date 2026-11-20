/**
 * 调度器（croner）：契约 §4 / §9。
 *
 * 三类定时任务：
 * 1. 每 5 分钟扫描到期数据源（enabled=1 且 last_run_at + interval_minutes <= now）并自动采集；
 * 2. 每周一 08:00 自动生成周报；
 * 3. 每天 03:00 清理超过 settings.retentionDays 的情报。
 *
 * 时区固定为 Asia/Shanghai（运营方在国内）；服务器时钟用 UTC 存储，croner 负责本地时区换算。
 * 所有任务都用 try/catch 包住：定时任务抛错会终止 cron 循环，必须自行兜底。
 */
import { Cron } from 'croner';
import type { DueSourceInfo, AppContext, SchedulerController, SchedulerStatus } from '../core/context.js';
import { getActiveRunId, startFetchRun } from './runner.js';

/** 到期扫描周期（分钟）。 */
const TICK_CRON = '*/5 * * * *';
/** 周报生成：每周一 08:00。 */
const WEEKLY_REPORT_CRON = '0 8 * * 1';
/** 保留策略清理：每天 03:00。 */
const RETENTION_CRON = '0 3 * * *';
/** 调度器时区。 */
const TIMEZONE = 'Asia/Shanghai';

/** 内部任务注册项。 */
interface ScheduledJob {
  name: string;
  cron: string;
  job: Cron;
}

/** 调度器实现。 */
export class Scheduler implements SchedulerController {
  private readonly jobs: ScheduledJob[] = [];
  private started = false;

  constructor(private readonly ctx: AppContext) {}

  /** 启动全部定时任务（幂等，重复调用无副作用）。 */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.jobs.push(
      {
        name: '到期数据源扫描',
        cron: TICK_CRON,
        job: this.wrap('到期数据源扫描', TICK_CRON, () => this.tick()),
      },
      {
        name: '每周自动周报',
        cron: WEEKLY_REPORT_CRON,
        job: this.wrap('每周自动周报', WEEKLY_REPORT_CRON, () => this.generateWeeklyReport()),
      },
      {
        name: '保留策略清理',
        cron: RETENTION_CRON,
        job: this.wrap('保留策略清理', RETENTION_CRON, () => this.cleanupExpiredItems()),
      },
    );
    this.ctx.logger.info(
      { jobs: this.jobs.map((entry) => ({ name: entry.name, cron: entry.cron })) },
      '调度器已启动',
    );
  }

  /** 停止全部定时任务（优雅关闭时调用）。 */
  stop(): void {
    for (const entry of this.jobs) {
      try {
        entry.job.stop();
      } catch (error) {
        this.ctx.logger.warn({ job: entry.name, err: String(error) }, '停止调度任务失败');
      }
    }
    this.jobs.length = 0;
    this.started = false;
    this.ctx.logger.info({}, '调度器已停止');
  }

  /** 状态快照（/tasks/status 与 /system/info 使用）。 */
  getStatus(): SchedulerStatus {
    return {
      enabled: this.started,
      jobs: this.jobs.map((entry) => ({
        name: entry.name,
        cron: entry.cron,
        nextRunAt: entry.job.nextRun()?.toISOString() ?? null,
      })),
      runningRunId: getActiveRunId(),
      dueSources: this.getDueSources(10),
    };
  }

  /** 包装定时任务：异常只记日志，绝不让 cron 回调抛出。 */
  private wrap(name: string, cron: string, handler: () => void | Promise<void>): Cron {
    return new Cron(cron, { timezone: TIMEZONE, name }, () => {
      void Promise.resolve()
        .then(handler)
        .catch((error: unknown) => {
          this.ctx.logger.error({ job: name, err: String(error) }, '定时任务执行失败');
        });
    });
  }

  /** 计算到期数据源：last_run_at 为空视为立即到期。 */
  private getDueSources(limit: number): DueSourceInfo[] {
    const now = new Date();
    const rows = this.ctx.db.all<{
      key: string;
      name: string;
      last_run_at: string | null;
      interval_minutes: number;
    }>(
      `SELECT key, name, last_run_at, interval_minutes FROM sources
        WHERE enabled = 1
          AND (last_run_at IS NULL OR datetime(last_run_at, '+' || interval_minutes || ' minutes') <= datetime('now'))
        ORDER BY priority ASC, last_run_at ASC LIMIT ?`,
      [limit],
    );
    return rows.map((row) => {
      const lastRunAt = row.last_run_at;
      const dueAt = lastRunAt
        ? new Date(Date.parse(lastRunAt) + row.interval_minutes * 60_000).toISOString()
        : now.toISOString();
      return {
        key: row.key,
        name: row.name,
        lastRunAt,
        dueAt,
        intervalMinutes: row.interval_minutes,
      };
    });
  }

  /** 每 5 分钟：到期源自动采集（与手动任务共享互斥锁）。 */
  private tick(): void {
    if (getActiveRunId() !== null) {
      this.ctx.logger.debug({}, '已有采集任务运行中，跳过本轮调度');
      return;
    }
    const due = this.getDueSources(50);
    if (due.length === 0) return;

    try {
      const result = startFetchRun(
        { db: this.ctx.db, logger: this.ctx.logger, pipeline: this.ctx.pipeline },
        { sourceKeys: due.map((source) => source.key), trigger: 'schedule', username: 'scheduler' },
      );
      this.ctx.logger.info({ runId: result.runId, sourceCount: due.length }, '调度器已触发采集任务');
    } catch (error) {
      // 常见于手动任务抢先启动（409），属于预期竞争，降级为 debug
      this.ctx.logger.debug({ err: String(error) }, '调度器触发采集被互斥锁拒绝');
    }
  }

  /** 每周一 08:00：生成周报（区间取 settings.reportRangeDays，默认 7 天）。 */
  private async generateWeeklyReport(): Promise<void> {
    const report = await this.ctx.reports.generate({ type: 'weekly', createdBy: 'scheduler' });
    this.ctx.logger.info(
      { reportId: report.id, itemCount: report.itemCount, title: report.title },
      '自动周报已生成',
    );
  }

  /** 每天 03:00：按保留天数清理过期情报，控制 SQLite 体积。 */
  private cleanupExpiredItems(): void {
    const retentionDays = this.ctx.settings.get().retentionDays;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.ctx.db.run('DELETE FROM items WHERE COALESCE(published_at, fetched_at) < ?', [
      cutoff,
    ]);
    this.ctx.logger.info({ deleted: result.changes, retentionDays }, '过期情报已清理');
    // 清理后回收空闲页，避免数据库文件长期膨胀（WAL 下磁盘空间不会自动归还）
    try {
      this.ctx.db.exec('PRAGMA incremental_vacuum;');
    } catch (error) {
      this.ctx.logger.warn({ err: String(error) }, 'incremental_vacuum 执行失败（忽略）');
    }
  }
}
