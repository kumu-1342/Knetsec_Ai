/**
 * 数据源管理（契约 §6 /sources）：CRUD、启停、试采。
 *
 * 关键规则：
 * - key 是稳定标识（报告、前端、审计都引用），adapter 决定解析逻辑，两者创建后不可修改；
 * - 删除数据源保留历史 items（契约明确「不删」），否则报告与历史检索会出现空洞；
 * - 试采只调用适配器、不写库，返回前 5 条标题用于确认配置是否正确。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ADAPTER_IDS,
  SOURCE_CATEGORIES,
  type AdapterId,
  type CollectorLogger,
  type CreateSourceInput,
  type SourceCategory,
  type SourceDTO,
  type SourceTestResult,
  type UpdateSourceInput,
} from '@knetsec/shared';
import { config } from '../../config.js';
import { badRequest, conflict, notFound } from '../../infra/errors.js';
import { HttpClient } from '../../infra/http.js';
import { createGuards } from '../core/auth-guard.js';
import type { AppContext } from '../core/context.js';
import { replyOk } from '../core/envelope.js';

/** 试采超时（比正采的 90s 略短，避免管理员在面板上等待过久）。 */
const SOURCE_TEST_TIMEOUT_MS = 60_000;

/** sources 表原始行。 */
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
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  success_count: number;
  failure_count: number;
  created_at: string;
  updated_at: string;
}

/** 查询数据源使用的列清单（显式列名）。 */
const SOURCE_COLUMNS =
  'id, key, name, category, adapter, url, config, enabled, interval_minutes, priority, last_run_at, last_status, last_error, success_count, failure_count, created_at, updated_at';

/** URL 校验：允许留空（有些适配器 URL 只是展示入口），非空时必须是 http(s)。 */
const urlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => value === '' || /^https?:\/\//i.test(value), 'URL 必须以 http:// 或 https:// 开头');

/** 新建数据源参数。 */
const createSourceSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'key 只能包含小写字母、数字、连字符，长度 2-64'),
  name: z.string().trim().min(1, '请输入数据源名称').max(100),
  category: z.enum(SOURCE_CATEGORIES),
  adapter: z.enum(ADAPTER_IDS),
  url: urlSchema.optional(),
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().min(5).max(10_080).optional(),
  priority: z.number().int().min(1).max(9999).optional(),
});

/** 修改数据源参数（key/adapter 传相同值允许，传不同值报 400）。 */
const updateSourceSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'key 格式不正确')
    .optional(),
  name: z.string().trim().min(1).max(100).optional(),
  category: z.enum(SOURCE_CATEGORIES).optional(),
  adapter: z.enum(ADAPTER_IDS).optional(),
  url: urlSchema.optional(),
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
  intervalMinutes: z.number().int().min(5).max(10_080).optional(),
  priority: z.number().int().min(1).max(9999).optional(),
});

/** 解析 config JSON，脏数据回退空对象。 */
function parseConfig(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 配置损坏按空配置展示，管理员可在面板中直接修正
  }
  return {};
}

/** 行 → DTO。 */
function mapSourceRow(row: SourceRow): SourceDTO {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    category: row.category as SourceCategory,
    adapter: row.adapter as AdapterId,
    url: row.url,
    config: parseConfig(row.config),
    enabled: row.enabled === 1,
    intervalMinutes: row.interval_minutes,
    priority: row.priority,
    lastRunAt: row.last_run_at,
    lastStatus: (row.last_status as SourceDTO['lastStatus']) ?? null,
    lastError: row.last_error,
    successCount: row.success_count,
    failureCount: row.failure_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 按 id 查询数据源。 */
function findSource(ctx: AppContext, id: number): SourceRow | undefined {
  return ctx.db.get<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM sources WHERE id = ?`, [id]);
}

/** 带超时的 Promise 包装（试采使用，超时后底层 HTTP 由自身超时兜底）。 */
function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
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

/** 注册数据源路由。 */
export function registerSourceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guards = createGuards(ctx);

  app.get('/sources', { preHandler: guards.requireAuth }, async (request, reply) => {
    const rows = ctx.db.all<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM sources ORDER BY priority ASC, id ASC`);
    return replyOk(request, reply, rows.map(mapSourceRow));
  });

  app.post('/sources', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = createSourceSchema.parse(request.body ?? {}) as CreateSourceInput;
    const existing = ctx.db.get<{ id: number }>('SELECT id FROM sources WHERE key = ?', [body.key]);
    if (existing) throw conflict(`数据源 key 已存在：${body.key}`);

    const nowIso = new Date().toISOString();
    const intervalMinutes = body.intervalMinutes ?? ctx.settings.get().fetchIntervalMinutes;
    const result = ctx.db.run(
      `INSERT INTO sources (key, name, category, adapter, url, config, enabled, interval_minutes, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.key,
        body.name,
        body.category,
        body.adapter,
        body.url ? body.url : null,
        JSON.stringify(body.config ?? {}),
        body.enabled === false ? 0 : 1,
        intervalMinutes,
        body.priority ?? 100,
        nowIso,
        nowIso,
      ],
    );

    ctx.audit.record({
      username: request.authUser?.username ?? 'unknown',
      action: 'source.create',
      target: `source:${body.key}`,
      detail: { adapter: body.adapter, category: body.category },
      ip: request.ip,
    });
    const created = findSource(ctx, result.lastInsertRowid);
    return replyOk(request, reply, created ? mapSourceRow(created) : null, 201);
  });

  app.patch('/sources/:id', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id?: string }).id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('数据源 id 不合法');
    const existing = findSource(ctx, id);
    if (!existing) throw notFound('数据源不存在');

    const body = updateSourceSchema.parse(request.body ?? {}) as UpdateSourceInput;
    if (body.key !== undefined && body.key !== existing.key) {
      throw badRequest('数据源 key 创建后不可修改');
    }
    if (body.adapter !== undefined && body.adapter !== existing.adapter) {
      throw badRequest('数据源 adapter 创建后不可修改');
    }

    const assignments: string[] = [];
    const params: Array<string | number | null> = [];
    const push = (column: string, value: string | number | null): void => {
      assignments.push(`${column} = ?`);
      params.push(value);
    };
    if (body.name !== undefined) push('name', body.name);
    if (body.category !== undefined) push('category', body.category);
    if (body.url !== undefined) push('url', body.url ? body.url : null);
    if (body.config !== undefined) push('config', JSON.stringify(body.config));
    if (body.enabled !== undefined) push('enabled', body.enabled ? 1 : 0);
    if (body.intervalMinutes !== undefined) push('interval_minutes', body.intervalMinutes);
    if (body.priority !== undefined) push('priority', body.priority);

    if (assignments.length > 0) {
      push('updated_at', new Date().toISOString());
      params.push(id);
      ctx.db.run(`UPDATE sources SET ${assignments.join(', ')} WHERE id = ?`, params);
    }

    ctx.audit.record({
      username: request.authUser?.username ?? 'unknown',
      action: 'source.update',
      target: `source:${existing.key}`,
      detail: { keys: Object.keys(body) },
      ip: request.ip,
    });
    const updated = findSource(ctx, id);
    return replyOk(request, reply, updated ? mapSourceRow(updated) : null);
  });

  app.delete('/sources/:id', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id?: string }).id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('数据源 id 不合法');
    const existing = findSource(ctx, id);
    if (!existing) throw notFound('数据源不存在');

    // 只删源、不删 items：历史情报与已生成报告仍需可查（契约 §6 备注）
    ctx.db.run('DELETE FROM sources WHERE id = ?', [id]);
    ctx.audit.record({
      username: request.authUser?.username ?? 'unknown',
      action: 'source.delete',
      target: `source:${existing.key}`,
      detail: { key: existing.key },
      ip: request.ip,
    });
    return replyOk(request, reply, { deleted: true, id });
  });

  app.post('/sources/:id/toggle', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id?: string }).id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('数据源 id 不合法');
    const existing = findSource(ctx, id);
    if (!existing) throw notFound('数据源不存在');

    const nextEnabled = existing.enabled === 1 ? 0 : 1;
    ctx.db.run('UPDATE sources SET enabled = ?, updated_at = ? WHERE id = ?', [
      nextEnabled,
      new Date().toISOString(),
      id,
    ]);
    ctx.audit.record({
      username: request.authUser?.username ?? 'unknown',
      action: nextEnabled === 1 ? 'source.enable' : 'source.disable',
      target: `source:${existing.key}`,
      ip: request.ip,
    });
    const updated = findSource(ctx, id);
    return replyOk(request, reply, updated ? mapSourceRow(updated) : null);
  });

  app.post('/sources/:id/test', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id?: string }).id);
    if (!Number.isInteger(id) || id <= 0) throw badRequest('数据源 id 不合法');
    const existing = findSource(ctx, id);
    if (!existing) throw notFound('数据源不存在');

    const source = {
      id: existing.id,
      key: existing.key,
      name: existing.name,
      category: existing.category as SourceCategory,
      adapter: existing.adapter as AdapterId,
      url: existing.url,
      config: parseConfig(existing.config),
      enabled: existing.enabled === 1,
      intervalMinutes: existing.interval_minutes,
      priority: existing.priority,
    };

    const startedAt = Date.now();
    let result: SourceTestResult;
    try {
      const collector = ctx.collectorFactory(source);
      const collectorLogger = ctx.logger.child({ sourceKey: existing.key, test: true });
      const http = new HttpClient({
        proxyUrl: config.httpProxy,
        // pino 子日志器与 CollectorLogger 结构兼容（debug/info/warn/error），这里显式收窄类型
        logger: collectorLogger as unknown as CollectorLogger,
      });
      const collected = await withTimeout(
        collector.fetch({
          source,
          now: new Date(),
          logger: collectorLogger,
          http,
          settings: ctx.settings.get(),
          secrets: config.secrets,
        }),
        SOURCE_TEST_TIMEOUT_MS,
        `试采超时（${SOURCE_TEST_TIMEOUT_MS / 1000}s）`,
      );
      result = {
        ok: true,
        adapter: source.adapter,
        fetched: collected.items.length,
        durationMs: Date.now() - startedAt,
        sample: collected.items
          .slice(0, 5)
          .map((item) => item.title)
          .filter((title) => title.length > 0),
        error: null,
      };
    } catch (error) {
      result = {
        ok: false,
        adapter: source.adapter,
        fetched: 0,
        durationMs: Date.now() - startedAt,
        sample: [],
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      };
      ctx.logger.warn({ sourceKey: existing.key, err: result.error }, '数据源试采失败');
    }

    ctx.audit.record({
      username: request.authUser?.username ?? 'unknown',
      action: 'source.test',
      target: `source:${existing.key}`,
      detail: { ok: result.ok, fetched: result.fetched },
      ip: request.ip,
    });
    return replyOk(request, reply, result);
  });
}
