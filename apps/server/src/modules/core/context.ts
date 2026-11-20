/**
 * 应用运行期上下文（依赖注入容器）。
 *
 * 为什么单独抽出 Context：路由模块、流水线、调度器都需要 db / logger / 配置 / 设置 / 审计，
 * 若每个模块各自 import 单例，测试时无法替换成内存库与假实现。buildApp 统一构造 AppContext
 * 并传给各模块注册函数，生产只装配一次，测试可注入 fake pipeline / fake collectorFactory。
 */
import type { AppConfig } from '../../config.js';
import type { AdapterId, CollectorAdapter, SourceDescriptor } from '@knetsec/shared';
import type { Db } from '../../infra/db.js';
import type { AppLogger } from '../../infra/logger.js';
import type { RunSummary } from '../../pipeline/orchestrator.js';
import type { ReportService } from '../reports/service.js';
import type { AuditService } from './audit.js';
import type { SettingsStore } from './settings-store.js';

/** 采集流水线可替换接口：生产为 CollectPipeline，测试注入假件（不触发外部 HTTP）。 */
export interface PipelineRunner {
  run(runId: number, sourceKeys?: string[]): Promise<RunSummary>;
}

/**
 * 采集器工厂：契约 §7.3 规定 createCollector(source) 返回适配器实例。
 * 抽出成函数类型是为了让「试采」与「编排器」都能被测试替换，避免集成测试访问外网。
 */
export type CollectorFactory = (source: SourceDescriptor) => CollectorAdapter;

/** 调度任务状态（供 /tasks/status 与 /system/info 展示）。 */
export interface SchedulerJobStatus {
  /** 任务名称（中文），如「到期数据源扫描」。 */
  name: string;
  /** cron 表达式，便于排障。 */
  cron: string;
  /** 下一次触发时间（ISO 8601），任务未启动时为 null。 */
  nextRunAt: string | null;
}

/** 到期数据源信息（调度器每 tick 的候选集合，面板展示用）。 */
export interface DueSourceInfo {
  key: string;
  name: string;
  lastRunAt: string | null;
  /** 依据 last_run_at + interval_minutes 计算出的「应采集时间」。 */
  dueAt: string;
  intervalMinutes: number;
}

/** 调度器状态快照。 */
export interface SchedulerStatus {
  enabled: boolean;
  jobs: SchedulerJobStatus[];
  /** 当前正在执行的采集任务 id（无则为 null）。 */
  runningRunId: number | null;
  /** 前 10 个到期数据源。 */
  dueSources: DueSourceInfo[];
}

/** 调度器控制器：由 tasks 模块实现，app.ts 负责 start/stop。 */
export interface SchedulerController {
  start(): void;
  stop(): void;
  /** 查看调度器状态（同步读取 SQLite，开销可忽略）。 */
  getStatus(): SchedulerStatus;
}

/**
 * AppContext 是各模块唯一的依赖入口。
 * 注意：scheduler 由 app.ts 在路由注册后创建并回填，避免调度器与路由模块相互依赖。
 */
export interface AppContext {
  db: Db;
  logger: AppLogger;
  config: AppConfig;
  /** 系统设置读写（带内存缓存，get() 同步返回）。 */
  settings: SettingsStore;
  /** 审计日志写入/查询。 */
  audit: AuditService;
  /** 采集编排器（真实或测试假件）。 */
  pipeline: PipelineRunner;
  /** 采集器工厂（真实或测试假件）。 */
  collectorFactory: CollectorFactory;
  /** 报告服务（生成/查询/落盘）。 */
  reports: ReportService;
  /** 进程启动时间，用于 /system/info 计算运行时长。 */
  startedAt: Date;
  /** 调度器实例，仅当 scheduler=true 时存在。 */
  scheduler?: SchedulerController;
}

/** 便捷类型别名，供各模块签名使用。 */
export type Ctx = AppContext;
export type { AdapterId };
