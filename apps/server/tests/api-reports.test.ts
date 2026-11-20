/**
 * 报告中心集成测试：生成、落盘、列表、详情、下载、删除、权限。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authHeader, createTestApp, createViewer, insertItem, type TestApp } from './api-helpers.js';

let ctx: TestApp | null = null;
afterEach(async () => {
  if (ctx) {
    await ctx.close();
    ctx = null;
  }
});

/** 构造覆盖多个章节的情报。 */
function seedReportItems(db: TestApp['db']): void {
  insertItem(db, {
    title: 'OpenAI 修复 LLM 提示注入漏洞',
    summary: 'prompt injection 可绕过系统提示词',
    category: 'ai-security',
    severity: 'critical',
    cveIds: ['CVE-2025-9001'],
    isKev: true,
    cvssScore: 9.8,
    importance: 95,
    tags: ['prompt-injection'],
  });
  insertItem(db, {
    title: '某中间件高危 RCE 漏洞',
    category: 'vuln',
    severity: 'high',
    cveIds: ['CVE-2025-9002'],
    cvssScore: 8.1,
    importance: 80,
    vendor: '示例厂商',
  });
  insertItem(db, {
    title: 'arXiv 论文：对抗样本防御新方法',
    category: 'research',
    severity: 'medium',
    importance: 50,
  });
}

describe('报告中心', () => {
  it('生成周报：标题、章节、统计齐全且落盘', async () => {
    ctx = await createTestApp();
    seedReportItems(ctx.db);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/reports/generate',
      headers: authHeader(ctx.token),
      payload: { type: 'weekly' },
    });
    expect(response.statusCode).toBe(200);
    const report = (
      response.json() as {
        data: { id: number; title: string; markdown: string; html: string; itemCount: number; type: string };
      }
    ).data;

    expect(report.type).toBe('weekly');
    expect(report.title).toContain('Knetsec_Ai AI 安全与网络安全周报');
    expect(report.itemCount).toBe(3);
    expect(report.markdown).toContain('## 本周速览');
    expect(report.markdown).toContain('## AI 安全');
    expect(report.markdown).toContain('## 漏洞与补丁');
    expect(report.markdown).toContain('## 安全研究');
    expect(report.markdown).toContain('## 本周数据统计');
    expect(report.markdown).toContain('## 下期关注');
    // KEV 条目的优先级更高，速览里应出现
    expect(report.markdown).toContain('OpenAI 修复 LLM 提示注入漏洞');
    expect(report.html).toContain('<!doctype html>');
    expect(report.html).toContain('<style>');

    // 落盘校验：data/reports/<id>-weekly-<yyyyMMdd>/report.md + report.html
    const reportDirs = fs
      .readdirSync(path.join(ctx.dir, 'reports'))
      .filter((name) => name.startsWith(`${report.id}-weekly-`));
    expect(reportDirs.length).toBe(1);
    const dirPath = path.join(ctx.dir, 'reports', reportDirs[0] as string);
    expect(fs.existsSync(path.join(dirPath, 'report.md'))).toBe(true);
    expect(fs.existsSync(path.join(dirPath, 'report.html'))).toBe(true);
  });

  it('支持自定义区间与标题、指定 itemIds 生成专题报告', async () => {
    ctx = await createTestApp();
    seedReportItems(ctx.db);
    const itemId = insertItem(ctx.db, { title: '专题条目', category: 'ai-security', severity: 'high' });
    const now = new Date().toISOString();
    const start = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/reports/generate',
      headers: authHeader(ctx.token),
      payload: {
        type: 'custom',
        title: 'AI 安全专题报告',
        periodStart: start,
        periodEnd: now,
        itemIds: [itemId],
      },
    });
    expect(response.statusCode).toBe(200);
    const report = (response.json() as { data: { title: string; itemCount: number; markdown: string } }).data;
    expect(report.title).toBe('AI 安全专题报告');
    expect(report.itemCount).toBe(1);
    expect(report.markdown).toContain('专题条目');
  });

  it('列表分页、详情、下载 md/html', async () => {
    ctx = await createTestApp();
    seedReportItems(ctx.db);
    const headers = authHeader(ctx.token);
    const generated = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/reports/generate',
      headers,
      payload: { type: 'weekly' },
    });
    const reportId = (generated.json() as { data: { id: number } }).data.id;

    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/reports?page=1&pageSize=10', headers });
    expect(list.statusCode).toBe(200);
    const listBody = list.json() as {
      data: { total: number; items: Array<{ id: number; preview: string }> };
    };
    expect(listBody.data.total).toBe(1);
    expect(listBody.data.items[0]?.preview.length).toBeGreaterThan(0);

    const detail = await ctx.app.inject({ method: 'GET', url: `/api/v1/reports/${reportId}`, headers });
    expect(detail.statusCode).toBe(200);

    const markdown = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/reports/${reportId}/download?format=md`,
      headers,
    });
    expect(markdown.statusCode).toBe(200);
    expect(markdown.headers['content-type']).toContain('text/markdown');
    expect(markdown.headers['content-disposition']).toContain('attachment');
    expect(markdown.body).toContain('## 本周速览');

    const html = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/reports/${reportId}/download?format=html`,
      headers,
    });
    expect(html.statusCode).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.body).toContain('<!doctype html>');
  });

  it('删除报告后详情 404 且审计留痕', async () => {
    ctx = await createTestApp();
    seedReportItems(ctx.db);
    const headers = authHeader(ctx.token);
    const generated = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/reports/generate',
      headers,
      payload: { type: 'weekly' },
    });
    const reportId = (generated.json() as { data: { id: number } }).data.id;

    const deleted = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/reports/${reportId}`, headers });
    expect(deleted.statusCode).toBe(200);

    const detail = await ctx.app.inject({ method: 'GET', url: `/api/v1/reports/${reportId}`, headers });
    expect(detail.statusCode).toBe(404);

    const audit = await ctx.app.inject({ method: 'GET', url: '/api/v1/audit-logs', headers });
    const body = audit.json() as { data: { items: Array<{ action: string }> } };
    expect(body.data.items.some((entry) => entry.action === 'report.delete')).toBe(true);
  });

  it('viewer 不能生成报告（403）', async () => {
    ctx = await createTestApp();
    const viewerToken = await createViewer(ctx.app, ctx.db);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/reports/generate',
      headers: authHeader(viewerToken),
      payload: { type: 'weekly' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('不存在的报告返回 404', async () => {
    ctx = await createTestApp();
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/reports/9999',
      headers: authHeader(ctx.token),
    });
    expect(response.statusCode).toBe(404);
  });
});
