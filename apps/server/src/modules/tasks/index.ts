/**
 * 采集任务接口（契约 §6 /tasks）：触发采集、运行历史、运行详情、调度器状态。
 *
 * POST /tasks/fetch 采用「202 + runId」异步语义：真实采集可能持续数分钟（多源串行 + 上游限流），
 * 不能占用 HTTP 连接等待；面板拿到 runId 后轮询 /tasks/runs/:id 查看进度与日志。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RunDTO } from '@knetsec/shared';
import { notFound } from '../../infra/errors.js';
import { createGuards } from '../core/auth-guard.js';
import type { AppContext, SchedulerStatus } from '../core/context.js';
import { replyOk } from '../core/envelope.js';
import { parseId, parsePage, toPaginated } from '../core/pagination.js';
import { RUN_COLUMNS, mapRunRow, type RunRow } from '../core/run-mapper.js';
import { startFetchRun } from './runner.js';

/** 触发采集请求体。 */
const startFetchSchema = z.object({
  sourceKeys: z.array(z.string().trim().min(1)).max(50, '单次最多指定 50 个数据源').optional(),
});

/** 运行记录筛选。 */
const runListSchema = z.object({
  status: z.enum(['running', 'success', 'partial', 'failed']).optional(),
});

/** 注册任务路由。 */
export function registerTaskRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guards = createGuards(ctx);

  app.post('/tasks/fetch', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = startFetchSchema.parse(request.body ?? {});
    const result = startFetchRun(
      { db: ctx.db, logger: ctx.logger, pipeline: ctx.pipeline },
      { sourceKeys: body.sourceKeys, trigger: 'manual', username: request.authUser?.username ?? 'unknown' },
    );
    ctx.audit.record({
      username: request.authUser?.username ?? 'unknown',
      action: 'tasks.fetch',
      target: `run:${result.runId}`,
      detail: { sourceKeys: body.sourceKeys ?? 'all-enabled' },
      ip: request.ip,
    });
    // 202 Accepted：任务已入队，前端凭 runId 轮询详情
    return replyOk(request, reply, result, 202);
  });

  app.get('/tasks/runs', { preHandler: guards.requireAuth }, async (request, reply) => {
    const query = runListSchema.parse(request.query ?? {});
    const page = parsePage(request.query as { page?: unknown; pageSize?: unknown });
    const where = query.status ? ' WHERE status = ?' : '';
    const params: Array<string | number> = query.status ? [query.status] : [];
    const total = ctx.db.scalar<number>(`SELECT COUNT(1) FROM fetch_runs${where}`, params) ?? 0;
    const rows = ctx.db.all<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM fetch_runs${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, page.pageSize, page.offset],
    );
    // 列表不带日志，避免一次响应几十 MB；详情接口再返回 logs
    const result = toPaginated(
      rows.map((row) => mapRunRow(row, false)),
      total,
      page,
    );
    return replyOk(request, reply, result);
  });

  app.get('/tasks/runs/:id', { preHandler: guards.requireAuth }, async (request, reply) => {
    const id = parseId((request.params as { id?: string }).id, '运行 id');
    const row = ctx.db.get<RunRow>(`SELECT ${RUN_COLUMNS} FROM fetch_runs WHERE id = ?`, [id]);
    if (!row) throw notFound('运行记录不存在');
    const dto: RunDTO = mapRunRow(row, true);
    return replyOk(request, reply, dto);
  });

  app.get('/tasks/status', { preHandler: guards.requireAuth }, async (request, reply) => {
    const disabled: SchedulerStatus = { enabled: false, jobs: [], runningRunId: null, dueSources: [] };
    return replyOk(request, reply, ctx.scheduler?.getStatus() ?? disabled);
  });
}
