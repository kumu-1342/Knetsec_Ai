/**
 * 仪表盘聚合与系统信息集成测试。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { authHeader, createTestApp, createViewer, insertItem, type TestApp } from './api-helpers.js';

let ctx: TestApp | null = null;
afterEach(async () => {
  if (ctx) {
    await ctx.close();
    ctx = null;
  }
});

describe('仪表盘与系统信息', () => {
  it('聚合 totals / 严重度与分类分布 / 趋势 / 最新情报 / 最近任务', async () => {
    ctx = await createTestApp();
    insertItem(ctx.db, {
      title: 'AI 安全事件',
      category: 'ai-security',
      severity: 'critical',
      sourceKey: 'github-ghsa',
      sourceName: 'GitHub 安全公告库',
      isKev: true,
      importance: 90,
    });
    insertItem(ctx.db, {
      title: '漏洞条目',
      category: 'vuln',
      severity: 'high',
      sourceKey: 'nvd-cve',
      sourceName: 'NVD',
      importance: 60,
    });
    insertItem(ctx.db, { title: '普通资讯', category: 'news', severity: 'low', importance: 10 });
    ctx.db.run(
      "INSERT INTO fetch_runs (trigger, status, started_at, sources_total, sources_ok) VALUES ('manual', 'success', ?, 2, 2)",
      [new Date().toISOString()],
    );

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/summary',
      headers: authHeader(ctx.token),
    });
    expect(response.statusCode).toBe(200);
    const data = (
      response.json() as {
        data: {
          totals: { items: number; sources: number; sourcesEnabled: number; reports: number; unread: number };
          severityDistribution: Array<{ severity: string; count: number }>;
          categoryDistribution: Array<{ category: string; count: number }>;
          sourceDistribution: Array<{ sourceKey: string; sourceName: string; count: number }>;
          trend: Array<{ date: string; total: number }>;
          latestItems: Array<{ title: string }>;
          recentRuns: Array<{ id: number; status: string }>;
        };
      }
    ).data;

    expect(data.totals.items).toBe(3);
    expect(data.totals.unread).toBe(3);
    expect(data.totals.sources).toBeGreaterThan(0);
    expect(data.totals.sourcesEnabled).toBeGreaterThan(0);
    expect(data.severityDistribution.find((entry) => entry.severity === 'critical')?.count).toBe(1);
    expect(data.categoryDistribution.find((entry) => entry.category === 'ai-security')?.count).toBe(1);
    expect(data.sourceDistribution.find((entry) => entry.sourceKey === 'github-ghsa')?.count).toBe(1);
    // 14 天趋势补齐，最新一条日期为今天
    expect(data.trend.length).toBe(14);
    expect(data.trend[data.trend.length - 1]?.total).toBe(3);
    expect(data.latestItems.length).toBe(3);
    expect(data.latestItems[0]?.title).toBe('AI 安全事件');
    expect(data.recentRuns.length).toBe(1);
    expect(data.recentRuns[0]?.status).toBe('success');
  });

  it('未登录访问仪表盘返回 401', async () => {
    ctx = await createTestApp();
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/dashboard/summary' });
    expect(response.statusCode).toBe(401);
  });

  it('系统信息返回版本、运行时长、库大小与计数', async () => {
    ctx = await createTestApp();
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/system/info',
      headers: authHeader(ctx.token),
    });
    expect(response.statusCode).toBe(200);
    const info = (
      response.json() as {
        data: {
          version: string;
          uptimeSeconds: number;
          dbSizeBytes: number;
          counts: { items: number; sources: number; runs: number };
          scheduler: { enabled: boolean };
        };
      }
    ).data;
    expect(info.version).toBe('1.0.0');
    expect(info.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(info.dbSizeBytes).toBeGreaterThanOrEqual(0);
    expect(info.counts.sources).toBeGreaterThan(0);
    expect(info.counts.items).toBe(0);
    // 测试环境 scheduler=false
    expect(info.scheduler.enabled).toBe(false);
  });

  it('审计日志仅 admin 可读（viewer 403）且分页结构正确', async () => {
    ctx = await createTestApp();
    const viewerToken = await createViewer(ctx.app, ctx.db);
    const forbidden = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit-logs',
      headers: authHeader(viewerToken),
    });
    expect(forbidden.statusCode).toBe(403);

    const ok = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/audit-logs?page=1&pageSize=10',
      headers: authHeader(ctx.token),
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { data: { page: number; pageSize: number; total: number; totalPages: number } };
    expect(body.data.page).toBe(1);
    expect(body.data.pageSize).toBe(10);
    expect(body.data.total).toBeGreaterThanOrEqual(1);
  });
});
