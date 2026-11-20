/**
 * 仪表盘聚合（契约 §10 /dashboard）。
 *
 * 为什么用一个接口返回全部指标：仪表盘首屏需要 6 组数据，拆成 6 个请求会产生
 * 6 次 JWT 校验与 6 次 SQLite 同步查询的往返；单接口内用同一条连接顺序查询更快，
 * 且保证同一时间点的数据口径一致。
 */
import type { FastifyInstance } from 'fastify';
import { ITEM_CATEGORIES, ITEM_CATEGORY_LABELS, SEVERITIES, SEVERITY_WEIGHT } from '@knetsec/shared';
import type { DashboardSummary, ItemCategory, Severity } from '@knetsec/shared';
import { createGuards } from '../core/auth-guard.js';
import type { AppContext } from '../core/context.js';
import { replyOk } from '../core/envelope.js';
import { ITEM_COLUMNS, mapItemRow, type ItemRow } from '../core/items-mapper.js';
import { RUN_COLUMNS, mapRunRow, type RunRow } from '../core/run-mapper.js';

/** 趋势图展示天数（契约：最近 14 天）。 */
const TREND_DAYS = 14;

/** 以本地时区计算「今天 0 点」的 ISO 时间（运营视角的自然日，而不是 UTC 日）。 */
function startOfToday(now: Date): string {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.toISOString();
}

/** 生成最近 N 天的 YYYY-MM-DD 列表（含今天，从旧到新）。 */
function recentDateKeys(now: Date, days: number): string[] {
  const keys: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    keys.push(`${year}-${month}-${day}`);
  }
  return keys;
}

/** 注册仪表盘路由。 */
export function registerStatsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guards = createGuards(ctx);

  app.get('/dashboard/summary', { preHandler: guards.requireAuth }, async (request, reply) => {
    const now = new Date();
    const nowIso = now.toISOString();
    const todayIso = startOfToday(now);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const db = ctx.db;

    const totals = {
      items: db.scalar<number>('SELECT COUNT(1) FROM items') ?? 0,
      itemsToday: db.scalar<number>('SELECT COUNT(1) FROM items WHERE fetched_at >= ?', [todayIso]) ?? 0,
      items7d: db.scalar<number>('SELECT COUNT(1) FROM items WHERE fetched_at >= ?', [sevenDaysAgo]) ?? 0,
      unread: db.scalar<number>('SELECT COUNT(1) FROM items WHERE is_read = 0') ?? 0,
      critical7d:
        db.scalar<number>("SELECT COUNT(1) FROM items WHERE severity = 'critical' AND fetched_at >= ?", [
          sevenDaysAgo,
        ]) ?? 0,
      sources: db.scalar<number>('SELECT COUNT(1) FROM sources') ?? 0,
      sourcesEnabled: db.scalar<number>('SELECT COUNT(1) FROM sources WHERE enabled = 1') ?? 0,
      reports: db.scalar<number>('SELECT COUNT(1) FROM reports') ?? 0,
    };

    // 严重度/分类分布按字典顺序补齐 0 值，前端饼图不会因缺项跳色
    const severityRows = db.all<{ severity: string; count: number }>(
      'SELECT severity, COUNT(1) AS count FROM items GROUP BY severity',
    );
    const severityMap = new Map(severityRows.map((row) => [row.severity, row.count]));
    const severityDistribution = [...SEVERITIES]
      .map((severity) => ({ severity: severity as Severity, count: severityMap.get(severity) ?? 0 }))
      .sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]);

    const categoryRows = db.all<{ category: string; count: number }>(
      'SELECT category, COUNT(1) AS count FROM items GROUP BY category',
    );
    const categoryMap = new Map(categoryRows.map((row) => [row.category, row.count]));
    const categoryDistribution = [...ITEM_CATEGORIES]
      .map((category) => ({ category: category as ItemCategory, count: categoryMap.get(category) ?? 0 }))
      .filter((entry) => entry.count > 0 || ITEM_CATEGORY_LABELS[entry.category] !== undefined);

    const sourceRows = db.all<{ source_key: string; source_name: string; count: number }>(
      `SELECT source_key, MAX(source_name) AS source_name, COUNT(1) AS count
         FROM items GROUP BY source_key ORDER BY count DESC LIMIT 20`,
    );
    // SQL 返回 snake_case，对外契约是 sourceKey/sourceName，必须显式映射
    const sourceDistribution = sourceRows.map((row) => ({
      sourceKey: row.source_key,
      sourceName: row.source_name,
      count: row.count,
    }));

    const trendRows = db.all<{ day: string; total: number; aiSecurity: number; vuln: number }>(
      `SELECT substr(fetched_at, 1, 10) AS day,
              COUNT(1) AS total,
              SUM(CASE WHEN category = 'ai-security' THEN 1 ELSE 0 END) AS aiSecurity,
              SUM(CASE WHEN category = 'vuln' THEN 1 ELSE 0 END) AS vuln
         FROM items WHERE fetched_at >= ? GROUP BY day`,
      [new Date(now.getTime() - TREND_DAYS * 24 * 60 * 60 * 1000).toISOString()],
    );
    const trendMap = new Map(trendRows.map((row) => [row.day, row]));
    const trend = recentDateKeys(now, TREND_DAYS).map((date) => {
      const row = trendMap.get(date);
      return {
        date,
        total: row?.total ?? 0,
        aiSecurity: row?.aiSecurity ?? 0,
        vuln: row?.vuln ?? 0,
      };
    });

    const latestRows = db.all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM items ORDER BY importance DESC, fetched_at DESC LIMIT 10`,
    );
    const recentRunRows = db.all<RunRow>(`SELECT ${RUN_COLUMNS} FROM fetch_runs ORDER BY id DESC LIMIT 5`);

    const summary: DashboardSummary = {
      totals,
      severityDistribution,
      categoryDistribution,
      sourceDistribution,
      trend,
      latestItems: latestRows.map(mapItemRow),
      recentRuns: recentRunRows.map((row) => mapRunRow(row, false)),
    };
    // nowIso 仅用于日志排查时对齐时间口径，不进入响应
    ctx.logger.debug({ nowIso }, '仪表盘聚合完成');
    return replyOk(request, reply, summary);
  });
}
