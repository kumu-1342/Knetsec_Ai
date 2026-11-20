/**
 * 系统模块：健康检查与运行信息（契约 §6 /health、/system/info）。
 *
 * /health 必须公开：容器探活、启动脚本、冒烟脚本不需要登录即可判断进程与数据库是否正常。
 */
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { APP_NAME, APP_VERSION } from '@knetsec/shared';
import { config } from '../../config.js';
import { internalError } from '../../infra/errors.js';
import { createGuards } from '../core/auth-guard.js';
import type { AppContext, SchedulerStatus } from '../core/context.js';
import { replyOk } from '../core/envelope.js';

/** /system/info 响应结构（shared 未定义，面板与文档以此为口径）。 */
export interface SystemInfoDTO {
  appName: string;
  version: string;
  env: string;
  nodeVersion: string;
  startedAt: string;
  uptimeSeconds: number;
  dataDir: string;
  dbPath: string;
  /** SQLite 主库文件大小（字节）；内存库或文件不存在时为 0。 */
  dbSizeBytes: number;
  counts: {
    items: number;
    sources: number;
    sourcesEnabled: number;
    reports: number;
    runs: number;
  };
  scheduler: SchedulerStatus;
}

/** 健康检查响应。 */
export interface HealthDTO {
  status: 'ok';
  app: string;
  version: string;
  db: 'ok';
  uptimeSeconds: number;
  now: string;
}

/** 执行数据库连通性探测（SELECT 1），异常直接抛出由错误处理器转 500。 */
function pingDatabase(ctx: AppContext): boolean {
  const value = ctx.db.scalar<number>('SELECT 1');
  return value === 1;
}

/** 健康检查处理器（根路径与 /api/v1/health 共用）。 */
function healthHandler(ctx: AppContext) {
  return async (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
    const dbOk = pingDatabase(ctx);
    // 探活失败必须返回 5xx，容器/运维脚本据此重启实例，不能假装健康
    if (!dbOk) throw internalError('数据库连通性检查失败');
    const body: HealthDTO = {
      status: 'ok',
      app: APP_NAME,
      version: APP_VERSION,
      db: 'ok',
      uptimeSeconds: Math.round((Date.now() - ctx.startedAt.getTime()) / 1000),
      now: new Date().toISOString(),
    };
    return replyOk(request, reply, body);
  };
}

/** 注册根路径 /health（不带 /api/v1 前缀，便于运维与容器探活）。 */
export function registerRootHealthRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get('/health', healthHandler(ctx));
}

/** 注册系统路由（挂在 /api/v1 前缀内）。 */
export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guards = createGuards(ctx);

  app.get('/health', healthHandler(ctx));

  app.get('/system/info', { preHandler: guards.requireAuth }, async (request, reply) => {
    let dbSizeBytes = 0;
    try {
      if (config.dbPath !== ':memory:' && fs.existsSync(config.dbPath)) {
        dbSizeBytes = fs.statSync(config.dbPath).size;
      }
    } catch {
      // 文件大小统计失败不应影响接口可用性
      dbSizeBytes = 0;
    }

    const disabledScheduler: SchedulerStatus = {
      enabled: false,
      jobs: [],
      runningRunId: null,
      dueSources: [],
    };
    const info: SystemInfoDTO = {
      appName: APP_NAME,
      version: APP_VERSION,
      env: config.env,
      nodeVersion: process.version,
      startedAt: ctx.startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - ctx.startedAt.getTime()) / 1000),
      dataDir: config.dataDir,
      dbPath: config.dbPath,
      dbSizeBytes,
      counts: {
        items: ctx.db.scalar<number>('SELECT COUNT(1) FROM items') ?? 0,
        sources: ctx.db.scalar<number>('SELECT COUNT(1) FROM sources') ?? 0,
        sourcesEnabled: ctx.db.scalar<number>('SELECT COUNT(1) FROM sources WHERE enabled = 1') ?? 0,
        reports: ctx.db.scalar<number>('SELECT COUNT(1) FROM reports') ?? 0,
        runs: ctx.db.scalar<number>('SELECT COUNT(1) FROM fetch_runs') ?? 0,
      },
      scheduler: ctx.scheduler?.getStatus() ?? disabledScheduler,
    };
    return replyOk(request, reply, info);
  });
}
