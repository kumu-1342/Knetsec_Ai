/**
 * 审计日志查询（契约 §6 /audit-logs，仅 admin）。
 *
 * 写操作留痕由 AuditService 在各自模块内完成；这里只提供分页读取。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createGuards } from '../core/auth-guard.js';
import type { AppContext } from '../core/context.js';
import { replyOk } from '../core/envelope.js';
import { parsePage } from '../core/pagination.js';

/** 审计查询参数。 */
const auditQuerySchema = z.object({
  username: z.string().trim().max(64).optional(),
  action: z.string().trim().max(64).optional(),
});

/** 注册审计路由。 */
export function registerAuditRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guards = createGuards(ctx);

  app.get('/audit-logs', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const query = auditQuerySchema.parse(request.query ?? {});
    const page = parsePage(request.query as { page?: unknown; pageSize?: unknown });
    const result = ctx.audit.list({ page, username: query.username, action: query.action });
    return replyOk(request, reply, result);
  });
}
