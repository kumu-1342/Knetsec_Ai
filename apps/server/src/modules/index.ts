/**
 * 业务路由聚合入口。
 *
 * app.ts 只负责插件、错误处理、静态托管与生命周期；具体业务路由在这里集中注册，
 * 便于一眼看清 API 面与模块边界（新增模块时只改这一个文件）。
 */
import type { FastifyInstance } from 'fastify';
import { registerAuditRoutes } from './audit/index.js';
import { registerAuthRoutes } from './auth/index.js';
import type { AppContext } from './core/context.js';
import { registerItemRoutes } from './items/index.js';
import { registerReportRoutes } from './reports/index.js';
import { registerSettingsRoutes } from './settings/index.js';
import { registerSourceRoutes } from './sources/index.js';
import { registerStatsRoutes } from './stats/index.js';
import { registerSystemRoutes } from './system/index.js';
import { registerTaskRoutes } from './tasks/index.js';

/** 注册全部 /api/v1 业务路由（由 app.ts 以 API_PREFIX 为前缀挂载）。 */
export function registerApiRoutes(app: FastifyInstance, ctx: AppContext): void {
  registerAuthRoutes(app, ctx);
  registerStatsRoutes(app, ctx);
  registerItemRoutes(app, ctx);
  registerSourceRoutes(app, ctx);
  registerTaskRoutes(app, ctx);
  registerReportRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerAuditRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
}
