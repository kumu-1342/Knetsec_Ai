/**
 * Fastify 应用装配（buildApp）。
 *
 * 为什么把「装配」与「进程启动」分离（app.ts vs index.ts）：
 * 测试可以用 app.inject() 直接打接口，不需要监听端口；生产入口只负责监听与优雅关闭。
 *
 * 装配顺序有讲究：
 * 1. logger/db/迁移/种子/依赖（Context）→ 2. 错误处理器 → 3. 通用插件（cors/jwt/限流/swagger）
 * → 4. 静态资源与 API 路由 → 5. SPA fallback → 6. 调度器 → 7. 关闭钩子。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { API_PREFIX, APP_NAME, APP_TAGLINE, APP_VERSION } from '@knetsec/shared';
import { createCollector } from './collectors/index.js';
import { config, ensureRuntimeDirs } from './config.js';
import { openDatabase, type Db } from './infra/db.js';
import { AppError } from './infra/errors.js';
import { createLogger, type AppLogger } from './infra/logger.js';
import { migrate } from './infra/migrations.js';
import { AuditService } from './modules/core/audit.js';
import type { AppContext, CollectorFactory, PipelineRunner } from './modules/core/context.js';
import { buildFailure } from './modules/core/envelope.js';
import { SettingsStore } from './modules/core/settings-store.js';
import { registerApiRoutes } from './modules/index.js';
import { ReportService } from './modules/reports/service.js';
import { registerRootHealthRoute } from './modules/system/index.js';
import { markStaleRuns } from './modules/tasks/runner.js';
import { Scheduler } from './modules/tasks/scheduler.js';
import { CollectPipeline } from './pipeline/orchestrator.js';
import { ensureSeedData } from './seed/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** 应用上下文（测试与 index.ts 通过它访问 db / scheduler 等）。 */
    knetsec: AppContext;
  }
}

/** buildApp 可注入项：生产全部用默认值，测试替换 db/pipeline/collectorFactory/目录。 */
export interface BuildAppOptions {
  /** 复用外部数据库连接（测试传 :memory:）。 */
  db?: Db;
  /** 自定义日志器（测试传 silent）。 */
  logger?: AppLogger;
  /** 是否启动调度器；默认取 config.schedulerEnabled。 */
  scheduler?: boolean;
  /** 采集流水线实现（测试注入假件）。 */
  pipeline?: PipelineRunner;
  /** 采集器工厂（测试注入假件，避免外网）。 */
  collectorFactory?: CollectorFactory;
  /** 报告落盘目录（测试用临时目录）。 */
  reportsDir?: string;
  /** 前端构建产物目录（默认 apps/web/dist）。 */
  webDistDir?: string;
  /** JWT 密钥覆盖（测试用固定密钥）。 */
  jwtSecret?: string;
  /** 是否执行种子数据；测试可关掉后自行插入用户。 */
  seed?: boolean;
  /** 数据库文件路径（仅在未传 db 时生效）。 */
  dbPath?: string;
}

/**
 * 构建 Fastify 应用实例（不监听端口）。
 *
 * @returns 已注册全部插件与路由、可直接 listen 或 inject 的实例
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const logger = options.logger ?? createLogger('knetsec.server');
  const ownsDb = options.db === undefined;
  if (ownsDb) ensureRuntimeDirs();

  const dbPath = options.dbPath ?? config.dbPath;
  const db = options.db ?? openDatabase(dbPath);
  migrate(db, logger);
  if (options.seed !== false) {
    const seedResult = await ensureSeedData(db, logger);
    logger.info(seedResult, '种子数据已就绪');
  }

  // 设置/审计/报告/流水线：全部依赖注入到 Context，禁止模块内直接 import 单例
  const settings = new SettingsStore(db, logger);
  settings.ensureDefaults();
  const audit = new AuditService(db, logger);
  const reports = new ReportService({
    db,
    logger,
    settings,
    reportsDir: options.reportsDir ?? config.reportsDir,
  });
  const collectorFactory: CollectorFactory = options.collectorFactory ?? createCollector;
  const pipeline: PipelineRunner =
    options.pipeline ??
    new CollectPipeline({
      db,
      logger,
      config,
      getSettings: () => settings.get(),
      collectorFactory,
    });

  const ctx: AppContext = {
    db,
    logger,
    config,
    settings,
    audit,
    pipeline,
    collectorFactory,
    reports,
    startedAt: new Date(),
  };

  const app = Fastify({
    // Fastify 泛型默认以 FastifyBaseLogger 为日志类型；ctx.logger 才是带 app/version 的 AppLogger。
    // 这里显式收窄到 FastifyBaseLogger，避免每个路由注册函数都被迫带 logger 泛型参数。
    loggerInstance: logger as unknown as FastifyBaseLogger,
    genReqId: () => randomUUID(),
    bodyLimit: 2 * 1024 * 1024,
  });
  app.decorate('knetsec', ctx);

  // -------------------------------------------------------------------------
  // 统一错误处理：所有异常都转换成契约信封，500 不泄露堆栈
  // -------------------------------------------------------------------------
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      return reply
        .code(error.statusCode)
        .send(buildFailure(request, error.code, error.message, error.details));
    }
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      return reply.code(400).send(buildFailure(request, 'VALIDATION_ERROR', '请求参数校验失败', details));
    }

    const rawCode = (error as { code?: unknown }).code;
    const rawStatus = (error as { statusCode?: unknown }).statusCode;
    const statusCode = typeof rawStatus === 'number' ? rawStatus : 500;

    // JWT 插件错误（签名错误/过期/缺 header）统一 401，不暴露具体原因
    if (typeof rawCode === 'string' && (rawCode.startsWith('FST_JWT') || rawCode.startsWith('FAST_JWT'))) {
      return reply.code(401).send(buildFailure(request, 'UNAUTHORIZED', '登录状态已失效，请重新登录'));
    }
    // @fastify/rate-limit 抛出的 429 对象
    if (statusCode === 429) {
      return reply.code(429).send(buildFailure(request, 'RATE_LIMITED', '请求过于频繁，请稍后再试'));
    }
    if (statusCode >= 400 && statusCode < 500) {
      // Fastify 内置校验错误等：保留 message 便于调试，但不泄露内部结构
      return reply
        .code(statusCode)
        .send(buildFailure(request, 'VALIDATION_ERROR', error.message || '请求参数不合法'));
    }

    logger.error(
      { reqId: request.id, method: request.method, url: request.url, err: error },
      '未处理的服务端错误',
    );
    return reply
      .code(500)
      .send(buildFailure(request, 'INTERNAL_ERROR', '服务器内部错误，请稍后重试或联系管理员'));
  });

  // -------------------------------------------------------------------------
  // 通用插件
  // -------------------------------------------------------------------------
  await app.register(cors, {
    // 同源请求无 Origin 头；开发期允许本机任意端口（Vite 端口可能变动），生产走白名单
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (config.corsOrigins.length === 0 || config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: false,
  });

  await app.register(jwt, { secret: options.jwtSecret ?? config.jwt.secret });
  // global:false：只有显式声明 rateLimit 的路由（登录）才限流，避免误伤批量查询
  await app.register(rateLimit, { global: false });

  await app.register(swagger, {
    openapi: {
      info: { title: `${APP_NAME} API`, description: APP_TAGLINE, version: APP_VERSION },
      servers: [{ url: `http://${config.host}:${config.port}` }],
      tags: [
        { name: 'auth', description: '认证' },
        { name: 'items', description: '情报' },
        { name: 'sources', description: '数据源' },
        { name: 'tasks', description: '采集任务' },
        { name: 'reports', description: '报告' },
        { name: 'settings', description: '系统设置' },
      ],
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });
  // 契约要求 /openapi.json 直接可取（面板/文档工具常用）
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  // -------------------------------------------------------------------------
  // 静态托管：apps/web/dist 存在时由服务端直接提供管理面板
  // -------------------------------------------------------------------------
  const webDistDir = options.webDistDir ?? config.webDistDir;
  const hasWebDist = fs.existsSync(path.join(webDistDir, 'index.html'));
  if (hasWebDist) {
    await app.register(fastifyStatic, { root: webDistDir, prefix: '/' });
    logger.info({ webDistDir }, '已启用前端静态托管');
  }

  // -------------------------------------------------------------------------
  // 路由
  // -------------------------------------------------------------------------
  await app.register(
    async (api) => {
      registerApiRoutes(api, ctx);
    },
    { prefix: API_PREFIX },
  );
  registerRootHealthRoute(app, ctx);

  // SPA fallback：非 /api、/docs、/openapi.json 的 GET 请求回退 index.html（history 路由支持）
  app.setNotFoundHandler((request, reply) => {
    const url = request.raw.url ?? '/';
    const pathname = url.split('?')[0] ?? '/';
    const isReserved =
      pathname.startsWith('/api') || pathname.startsWith('/docs') || pathname === '/openapi.json';
    const isReadable = request.method === 'GET' || request.method === 'HEAD';

    if (isReserved || !isReadable) {
      return reply
        .code(404)
        .send(buildFailure(request, 'NOT_FOUND', isReserved ? '接口不存在' : '资源不存在'));
    }
    if (hasWebDist && path.extname(pathname) === '') {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send(buildFailure(request, 'NOT_FOUND', '资源不存在'));
  });

  // 上次进程异常退出可能留下 running 记录，启动时清理，否则新任务会被 409 拦住
  markStaleRuns({ db, logger });

  // -------------------------------------------------------------------------
  // 调度器（测试/手工命令可关）
  // -------------------------------------------------------------------------
  const schedulerEnabled = options.scheduler ?? config.schedulerEnabled;
  if (schedulerEnabled) {
    const scheduler = new Scheduler(ctx);
    ctx.scheduler = scheduler;
    scheduler.start();
  }

  app.addHook('onClose', async () => {
    ctx.scheduler?.stop();
    if (ownsDb) db.close();
  });

  logger.info(
    { env: config.env, dbPath, seed: options.seed !== false, scheduler: schedulerEnabled },
    'Fastify 应用装配完成',
  );
  return app;
}
