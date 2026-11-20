/**
 * 情报中心（契约 §6 /items）：分页检索、详情、标记、批量操作、导出。
 *
 * 设计要点：
 * - 筛选条件全部参数化，LIKE 通配符做转义，避免 `%` 被当成通配导致慢查询/意外匹配；
 * - 排序字段用白名单映射到 SQL 片段，禁止把用户输入拼进 ORDER BY；
 * - severity 排序用 CASE 权重（critical > high > ...），而不是字典序；
 * - watched 表示命中 settings.watchKeywords（「重点关注」）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ITEM_CATEGORIES,
  ITEM_CATEGORY_LABELS,
  ITEM_SORT_FIELDS,
  SEVERITIES,
  SEVERITY_LABELS,
  SEVERITY_WEIGHT,
} from '@knetsec/shared';
import type { AppSettings, ItemDTO, ItemSortField, Paginated } from '@knetsec/shared';
import { badRequest, notFound } from '../../infra/errors.js';
import { createGuards, currentUser } from '../core/auth-guard.js';
import type { AppContext } from '../core/context.js';
import { replyOk } from '../core/envelope.js';
import { ITEM_COLUMNS, mapItemRow, type ItemRow } from '../core/items-mapper.js';
import { parseId, parsePage, toPaginated } from '../core/pagination.js';

/** 导出单次最多条数（防止一次导出把内存打满）。 */
const EXPORT_LIMIT = 5000;

/** 布尔查询参数：接受 true/false 与 '1'/'0'。 */
const booleanQuery = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    if (typeof value === 'boolean') return value;
    return value === 'true' || value === '1';
  });

/** ISO 时间查询参数：接受 Date.parse 可解析的字符串。 */
const isoDateQuery = z
  .string()
  .trim()
  .max(64)
  .refine((value) => value === '' || !Number.isNaN(Date.parse(value)), '时间格式不正确')
  .optional()
  .transform((value) => (value === undefined || value === '' ? undefined : new Date(value).toISOString()));

/** 列表/导出共用的筛选参数（分页与排序单独处理）。 */
const itemFilterSchema = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.enum(ITEM_CATEGORIES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  sourceKey: z.string().trim().max(100).optional(),
  from: isoDateQuery,
  to: isoDateQuery,
  read: booleanQuery,
  starred: booleanQuery,
  watched: booleanQuery,
});

/** 带分页与排序的列表参数。 */
const itemListSchema = itemFilterSchema.extend({
  sort: z.enum(ITEM_SORT_FIELDS).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

type ItemFilterQuery = z.infer<typeof itemFilterSchema>;
type ItemListQuery = z.infer<typeof itemListSchema>;

/** 转义 LIKE 通配符，使用 ESCAPE '\' 语法。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** 根据筛选条件生成 WHERE 子句与参数（全部参数化）。 */
function buildFilters(
  query: ItemFilterQuery,
  settings: AppSettings,
): { where: string; params: Array<string | number> } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (query.q) {
    const pattern = `%${escapeLike(query.q)}%`;
    clauses.push("(title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }
  if (query.category) {
    clauses.push('category = ?');
    params.push(query.category);
  }
  if (query.severity) {
    clauses.push('severity = ?');
    params.push(query.severity);
  }
  if (query.sourceKey) {
    clauses.push('source_key = ?');
    params.push(query.sourceKey);
  }
  // 时间筛选统一用「发布时间优先、缺失回退抓取时间」，与报告区间口径一致
  if (query.from) {
    clauses.push('COALESCE(published_at, fetched_at) >= ?');
    params.push(query.from);
  }
  if (query.to) {
    clauses.push('COALESCE(published_at, fetched_at) <= ?');
    params.push(query.to);
  }
  if (query.read !== undefined) {
    clauses.push('is_read = ?');
    params.push(query.read ? 1 : 0);
  }
  if (query.starred !== undefined) {
    clauses.push('is_starred = ?');
    params.push(query.starred ? 1 : 0);
  }
  if (query.watched) {
    const keywords = settings.watchKeywords.filter((keyword) => keyword.length > 0);
    if (keywords.length === 0) {
      // 没有配置关注词时「重点关注」应为空集，而不是退化成全部
      clauses.push('0 = 1');
    } else {
      const ors: string[] = [];
      for (const keyword of keywords) {
        const pattern = `%${escapeLike(keyword)}%`;
        ors.push("title LIKE ? ESCAPE '\\'");
        params.push(pattern);
        ors.push("summary LIKE ? ESCAPE '\\'");
        params.push(pattern);
      }
      clauses.push(`(${ors.join(' OR ')})`);
    }
  }

  return {
    where: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

/** severity 排序的 CASE 表达式（按权重降序，避免字典序把 critical 排到最后）。 */
function severityOrderExpression(): string {
  const whens = [...SEVERITIES]
    .map((severity) => `WHEN '${severity}' THEN ${SEVERITY_WEIGHT[severity]}`)
    .join(' ');
  return `CASE severity ${whens} ELSE 0 END`;
}

/** 排序字段白名单 → SQL 表达式。 */
function sortExpression(field: ItemSortField): string {
  switch (field) {
    case 'severity':
      return severityOrderExpression();
    case 'fetched_at':
      return 'fetched_at';
    case 'importance':
      return 'importance';
    case 'published_at':
    default:
      return 'COALESCE(published_at, fetched_at)';
  }
}

/** 查询单个条目并映射为 DTO；不存在返回 undefined。 */
function findItem(ctx: AppContext, id: number): ItemDTO | undefined {
  const row = ctx.db.get<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM items WHERE id = ?`, [id]);
  return row ? mapItemRow(row) : undefined;
}

/** 读取分页后的列表（列表与导出复用同一套筛选）。 */
function queryItems(
  ctx: AppContext,
  query: ItemListQuery,
  settings: AppSettings,
  pagination?: { limit: number; offset: number },
): Paginated<ItemDTO> {
  const { where, params } = buildFilters(query, settings);
  const sortField = sortExpression(query.sort ?? 'importance');
  const order = query.order === 'asc' ? 'ASC' : 'DESC';
  const total = ctx.db.scalar<number>(`SELECT COUNT(1) FROM items${where}`, params) ?? 0;

  const limit = pagination?.limit ?? 20;
  const offset = pagination?.offset ?? 0;
  const rows = ctx.db.all<ItemRow>(
    `SELECT ${ITEM_COLUMNS} FROM items${where} ORDER BY ${sortField} ${order}, id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return toPaginated(
    rows.map(mapItemRow),
    total,
    pagination ? parsePage({ page: Math.floor(offset / limit) + 1, pageSize: limit }) : parsePage({}),
  );
}

/** CSV 单元格转义：包含逗号/引号/换行时用双引号包裹并转义内部引号。 */
function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** 导出为 CSV 文本。 */
function toCsv(items: ItemDTO[]): string {
  const header = ['标题', '来源', '分类', '严重度', 'CVE', 'GHSA', 'CVSS', 'KEV', '发布时间', '链接'];
  const lines = [header.join(',')];
  for (const item of items) {
    lines.push(
      [
        csvCell(item.title),
        csvCell(item.sourceName),
        csvCell(ITEM_CATEGORY_LABELS[item.category]),
        csvCell(SEVERITY_LABELS[item.severity]),
        csvCell(item.cveIds.join(' ')),
        csvCell(item.ghsaIds.join(' ')),
        csvCell(item.cvssScore ?? ''),
        csvCell(item.isKev ? '是' : '否'),
        csvCell(item.publishedAt ?? item.fetchedAt),
        csvCell(item.url ?? ''),
      ].join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

/** 导出为 Markdown 表格。 */
function toMarkdown(items: ItemDTO[]): string {
  const lines = ['| 标题 | 来源 | 严重度 | CVE/GHSA | 发布时间 |', '|---|---|---|---|---|'];
  for (const item of items) {
    const ids = [...item.cveIds, ...item.ghsaIds].join(', ') || '-';
    const title = item.url ? `[${item.title}](${item.url})` : item.title;
    const date = item.publishedAt ?? item.fetchedAt;
    lines.push(
      `| ${title.replace(/\|/g, '\\|')} | ${item.sourceName} | ${SEVERITY_LABELS[item.severity]} | ${ids} | ${date} |`,
    );
  }
  return lines.join('\n');
}

/** 设置下载响应头。 */
function sendDownload(
  reply: FastifyReply,
  filename: string,
  contentType: string,
  body: string,
): FastifyReply {
  return reply
    .header('content-type', contentType)
    .header('content-disposition', `attachment; filename="${filename}"`)
    .send(body);
}

/** 注册情报路由。 */
export function registerItemRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guards = createGuards(ctx);

  app.get('/items', { preHandler: guards.requireAuth }, async (request, reply) => {
    const query = itemListSchema.parse(request.query ?? {}) as ItemListQuery;
    const page = parsePage(request.query as { page?: unknown; pageSize?: unknown });
    const { where, params } = buildFilters(query, ctx.settings.get());
    const sortField = sortExpression(query.sort ?? 'importance');
    const order = query.order === 'asc' ? 'ASC' : 'DESC';
    const total = ctx.db.scalar<number>(`SELECT COUNT(1) FROM items${where}`, params) ?? 0;
    const rows = ctx.db.all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM items${where} ORDER BY ${sortField} ${order}, id DESC LIMIT ? OFFSET ?`,
      [...params, page.pageSize, page.offset],
    );
    const result: Paginated<ItemDTO> = toPaginated(rows.map(mapItemRow), total, page);
    return replyOk(request, reply, result);
  });

  app.get('/items/:id', { preHandler: guards.requireAuth }, async (request, reply) => {
    const id = parseId((request.params as { id?: string }).id, '情报 id');
    const item = findItem(ctx, id);
    if (!item) throw notFound('情报不存在');
    return replyOk(request, reply, item);
  });

  app.patch('/items/:id', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const id = parseId((request.params as { id?: string }).id, '情报 id');
    const body = z
      .object({
        isRead: z.boolean().optional(),
        isStarred: z.boolean().optional(),
      })
      .refine((value) => value.isRead !== undefined || value.isStarred !== undefined, {
        message: '请至少提供 isRead 或 isStarred',
      })
      .parse(request.body ?? {});

    const assignments: string[] = [];
    const params: Array<number> = [];
    if (body.isRead !== undefined) {
      assignments.push('is_read = ?');
      params.push(body.isRead ? 1 : 0);
    }
    if (body.isStarred !== undefined) {
      assignments.push('is_starred = ?');
      params.push(body.isStarred ? 1 : 0);
    }
    params.push(id);
    const result = ctx.db.run(`UPDATE items SET ${assignments.join(', ')} WHERE id = ?`, params);
    if (result.changes === 0) throw notFound('情报不存在');
    const item = findItem(ctx, id);
    return replyOk(request, reply, item ?? null);
  });

  app.post('/items/bulk', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = z
      .object({
        ids: z.array(z.number().int().positive()).min(1, '请选择至少一条情报').max(500, '单次最多 500 条'),
        action: z.enum(['mark_read', 'mark_unread', 'star', 'unstar', 'delete']),
      })
      .parse(request.body ?? {});

    const placeholders = body.ids.map(() => '?').join(', ');
    let affected = 0;
    if (body.action === 'delete') {
      affected = ctx.db.run(`DELETE FROM items WHERE id IN (${placeholders})`, body.ids).changes;
    } else {
      // 动作 → SQL 片段白名单（绝不把用户输入拼进 SET 子句）
      const actionSql: Record<Exclude<typeof body.action, 'delete'>, string> = {
        mark_read: 'is_read = 1',
        mark_unread: 'is_read = 0',
        star: 'is_starred = 1',
        unstar: 'is_starred = 0',
      };
      const setSql = actionSql[body.action];
      affected = ctx.db.run(`UPDATE items SET ${setSql} WHERE id IN (${placeholders})`, body.ids).changes;
    }

    ctx.audit.record({
      username: currentUser(request).username,
      action: `items.${body.action}`,
      target: `items:${body.ids.length}`,
      detail: { ids: body.ids, affected },
      ip: request.ip,
    });
    return replyOk(request, reply, { affected });
  });

  app.get('/items/export', { preHandler: guards.requireAuth }, async (request, reply) => {
    const query = itemFilterSchema.parse(request.query ?? {}) as ItemFilterQuery;
    const { where, params } = buildFilters(query, ctx.settings.get());
    const rows = ctx.db.all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM items${where} ORDER BY importance DESC, id DESC LIMIT ?`,
      [...params, EXPORT_LIMIT],
    );
    const items = rows.map(mapItemRow);

    const format = z
      .enum(['csv', 'json', 'markdown'])
      .catch('csv')
      .parse((request.query as { format?: unknown } | undefined)?.format);
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'json') {
      return sendDownload(
        reply,
        `knetsec-items-${stamp}.json`,
        'application/json; charset=utf-8',
        JSON.stringify(items, null, 2),
      );
    }
    if (format === 'markdown') {
      return sendDownload(
        reply,
        `knetsec-items-${stamp}.md`,
        'text/markdown; charset=utf-8',
        `# Knetsec_Ai 情报导出（${stamp}）\n\n${toMarkdown(items)}\n`,
      );
    }
    return sendDownload(reply, `knetsec-items-${stamp}.csv`, 'text/csv; charset=utf-8', toCsv(items));
  });
}
