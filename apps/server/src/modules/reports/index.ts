/**
 * 报告中心接口（契约 §6 /reports）：列表、生成、详情、下载、删除。
 *
 * 下载接口返回原始文件（Content-Disposition: attachment），不套 JSON 信封，
 * 这样浏览器/curl 可以直接保存为 .md / .html。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { REPORT_TYPES } from '@knetsec/shared';
import type { ReportType } from '@knetsec/shared';
import { badRequest, notFound } from '../../infra/errors.js';
import { createGuards } from '../core/auth-guard.js';
import type { AppContext } from '../core/context.js';
import { replyOk } from '../core/envelope.js';
import { parseId, parsePage } from '../core/pagination.js';

/** 生成报告请求体。 */
const generateSchema = z.object({
  type: z.enum(REPORT_TYPES).optional(),
  periodStart: z.string().trim().max(64).optional(),
  periodEnd: z.string().trim().max(64).optional(),
  title: z.string().trim().max(200).optional(),
  itemIds: z.array(z.number().int().positive()).max(500).optional(),
});

/** 报告列表筛选。 */
const listQuerySchema = z.object({
  type: z.enum(REPORT_TYPES).optional(),
});

/** 注册报告路由。 */
export function registerReportRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guards = createGuards(ctx);

  app.get('/reports', { preHandler: guards.requireAuth }, async (request, reply) => {
    const query = listQuerySchema.parse(request.query ?? {});
    const page = parsePage(request.query as { page?: unknown; pageSize?: unknown });
    const result = ctx.reports.list({ page, type: query.type });
    return replyOk(request, reply, result);
  });

  app.post('/reports/generate', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = generateSchema.parse(request.body ?? {});
    const report = ctx.reports.generate({
      type: body.type as ReportType | undefined,
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      title: body.title,
      itemIds: body.itemIds,
      createdBy: request.authUser?.username ?? 'unknown',
    });
    ctx.audit.record({
      username: request.authUser?.username ?? 'unknown',
      action: 'report.generate',
      target: `report:${report.id}`,
      detail: { type: report.type, itemCount: report.itemCount },
      ip: request.ip,
    });
    ctx.logger.info({ reportId: report.id, type: report.type }, '报告已生成');
    return replyOk(request, reply, report);
  });

  app.get('/reports/:id', { preHandler: guards.requireAuth }, async (request, reply) => {
    const id = parseId((request.params as { id?: string }).id, '报告 id');
    const report = ctx.reports.getById(id);
    if (!report) throw notFound('报告不存在');
    return replyOk(request, reply, report);
  });

  app.get('/reports/:id/download', { preHandler: guards.requireAuth }, async (request, reply) => {
    const id = parseId((request.params as { id?: string }).id, '报告 id');
    const format = z
      .enum(['md', 'html'])
      .catch('md')
      .parse((request.query as { format?: unknown })?.format);
    const report = ctx.reports.getById(id);
    if (!report) throw notFound('报告不存在');
    if (format === 'html' && report.html.length === 0) throw badRequest('该报告没有 HTML 内容');

    const stamp = report.createdAt.slice(0, 10).replace(/-/g, '');
    const filename = `knetsec-report-${report.id}-${report.type}-${stamp}.${format}`;
    const body = format === 'html' ? report.html : report.markdown;
    const contentType = format === 'html' ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8';
    return reply
      .header('content-type', contentType)
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(body);
  });

  app.delete('/reports/:id', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const id = parseId((request.params as { id?: string }).id, '报告 id');
    const removed = ctx.reports.remove(id);
    if (!removed) throw notFound('报告不存在');
    ctx.audit.record({
      username: request.authUser?.username ?? 'unknown',
      action: 'report.delete',
      target: `report:${id}`,
      ip: request.ip,
    });
    return replyOk(request, reply, { deleted: true, id });
  });
}
