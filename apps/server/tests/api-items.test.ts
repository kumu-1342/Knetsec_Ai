/**
 * 情报中心集成测试：分页、筛选、排序、详情、标记、批量、导出。
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

/** 构造一组覆盖各筛选维度的测试数据。 */
function seedItems(db: TestApp['db']): void {
  insertItem(db, {
    uid: 'uid-critical',
    title: 'OpenAI 发布 LLM 提示注入漏洞公告',
    summary: 'prompt injection 可导致数据泄露',
    category: 'ai-security',
    severity: 'critical',
    cveIds: ['CVE-2025-1111'],
    isKev: true,
    cvssScore: 9.8,
    importance: 95,
    tags: ['prompt-injection'],
    sourceKey: 'github-ghsa',
    sourceName: 'GitHub 安全公告库',
    url: 'https://example.com/critical',
  });
  insertItem(db, {
    uid: 'uid-high',
    title: '某厂商修复高危远程代码执行漏洞',
    category: 'vuln',
    severity: 'high',
    cveIds: ['CVE-2025-2222'],
    cvssScore: 7.5,
    importance: 70,
  });
  insertItem(db, {
    uid: 'uid-medium',
    title: 'LiteLLM 供应链投毒事件分析',
    category: 'research',
    severity: 'medium',
    importance: 40,
    isRead: true,
    isStarred: true,
  });
  insertItem(db, {
    uid: 'uid-low',
    title: '普通安全资讯',
    category: 'news',
    severity: 'low',
    importance: 10,
  });
  insertItem(db, {
    uid: 'uid-info',
    title: '行业会议日程',
    category: 'policy',
    severity: 'info',
    importance: 5,
  });
}

describe('情报中心', () => {
  it('默认分页返回 total / totalPages，并支持 pageSize', async () => {
    ctx = await createTestApp();
    seedItems(ctx.db);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items?page=1&pageSize=2',
      headers: authHeader(ctx.token),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: {
        items: Array<{ title: string }>;
        page: number;
        pageSize: number;
        total: number;
        totalPages: number;
      };
    };
    expect(body.data.total).toBe(5);
    expect(body.data.page).toBe(1);
    expect(body.data.pageSize).toBe(2);
    expect(body.data.totalPages).toBe(3);
    expect(body.data.items).toHaveLength(2);
  });

  it('pageSize 超过上限被夹到 100', async () => {
    ctx = await createTestApp();
    seedItems(ctx.db);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items?page=1&pageSize=500',
      headers: authHeader(ctx.token),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: { pageSize: number } };
    expect(body.data.pageSize).toBe(100);
  });

  it('支持 q / category / severity / sourceKey / read / starred 筛选', async () => {
    ctx = await createTestApp();
    seedItems(ctx.db);
    const headers = authHeader(ctx.token);

    const byQuery = await ctx.app.inject({ method: 'GET', url: '/api/v1/items?q=OpenAI', headers });
    expect((byQuery.json() as { data: { total: number } }).data.total).toBe(1);

    const byCategory = await ctx.app.inject({ method: 'GET', url: '/api/v1/items?category=vuln', headers });
    expect((byCategory.json() as { data: { total: number } }).data.total).toBe(1);

    const bySeverity = await ctx.app.inject({ method: 'GET', url: '/api/v1/items?severity=medium', headers });
    expect((bySeverity.json() as { data: { total: number } }).data.total).toBe(1);

    const bySource = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items?sourceKey=github-ghsa',
      headers,
    });
    expect((bySource.json() as { data: { total: number } }).data.total).toBe(1);

    const unread = await ctx.app.inject({ method: 'GET', url: '/api/v1/items?read=false', headers });
    expect((unread.json() as { data: { total: number } }).data.total).toBe(4);

    const starred = await ctx.app.inject({ method: 'GET', url: '/api/v1/items?starred=true', headers });
    expect((starred.json() as { data: { total: number } }).data.total).toBe(1);
  });

  it('watched 命中关注关键词（设置里的 watchKeywords）', async () => {
    ctx = await createTestApp();
    seedItems(ctx.db);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items?watched=true',
      headers: authHeader(ctx.token),
    });
    expect(response.statusCode).toBe(200);
    // 默认关注词含 openai；只有第一条命中
    const body = response.json() as { data: { total: number; items: Array<{ title: string }> } };
    expect(body.data.total).toBe(1);
    expect(body.data.items[0]?.title).toContain('OpenAI');
  });

  it('按严重度排序时 critical 在最前', async () => {
    ctx = await createTestApp();
    seedItems(ctx.db);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items?sort=severity&order=desc',
      headers: authHeader(ctx.token),
    });
    const body = response.json() as { data: { items: Array<{ severity: string }> } };
    expect(body.data.items.map((item) => item.severity)).toEqual([
      'critical',
      'high',
      'medium',
      'low',
      'info',
    ]);
  });

  it('详情返回完整 DTO（tags/CVE 反序列化、boolean 转换）', async () => {
    ctx = await createTestApp();
    const id = insertItem(ctx.db, {
      uid: 'uid-detail',
      title: '详情条目',
      tags: ['agent', 'rag'],
      cveIds: ['CVE-2025-3333'],
      ghsaIds: ['GHSA-aaaa-bbbb-cccc'],
      isKev: true,
      isStarred: true,
      severity: 'high',
      category: 'ai-security',
    });
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/items/${id}`,
      headers: authHeader(ctx.token),
    });
    expect(response.statusCode).toBe(200);
    const item = (
      response.json() as {
        data: { tags: string[]; cveIds: string[]; ghsaIds: string[]; isKev: boolean; isStarred: boolean };
      }
    ).data;
    expect(item.tags).toEqual(['agent', 'rag']);
    expect(item.cveIds).toEqual(['CVE-2025-3333']);
    expect(item.ghsaIds).toEqual(['GHSA-aaaa-bbbb-cccc']);
    expect(item.isKev).toBe(true);
    expect(item.isStarred).toBe(true);
  });

  it('详情 404 与非法 id 400', async () => {
    ctx = await createTestApp();
    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items/9999',
      headers: authHeader(ctx.token),
    });
    expect(missing.statusCode).toBe(404);
    const invalid = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items/abc',
      headers: authHeader(ctx.token),
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('PATCH 标记已读；viewer 403', async () => {
    ctx = await createTestApp();
    const id = insertItem(ctx.db, { title: '待标记条目' });
    const viewerToken = await createViewer(ctx.app, ctx.db);

    const forbidden = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/items/${id}`,
      headers: authHeader(viewerToken),
      payload: { isRead: true },
    });
    expect(forbidden.statusCode).toBe(403);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/items/${id}`,
      headers: authHeader(ctx.token),
      payload: { isRead: true, isStarred: true },
    });
    expect(patched.statusCode).toBe(200);
    const item = (patched.json() as { data: { isRead: boolean; isStarred: boolean } }).data;
    expect(item.isRead).toBe(true);
    expect(item.isStarred).toBe(true);
  });

  it('批量标记已读与批量删除写审计', async () => {
    ctx = await createTestApp();
    const ids = [insertItem(ctx.db, { title: '批量一' }), insertItem(ctx.db, { title: '批量二' })];
    const headers = authHeader(ctx.token);

    const marked = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/items/bulk',
      headers,
      payload: { ids, action: 'mark_read' },
    });
    expect(marked.statusCode).toBe(200);
    expect((marked.json() as { data: { affected: number } }).data.affected).toBe(2);

    const readList = await ctx.app.inject({ method: 'GET', url: '/api/v1/items?read=true', headers });
    expect((readList.json() as { data: { total: number } }).data.total).toBe(2);

    const deleted = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/items/bulk',
      headers,
      payload: { ids, action: 'delete' },
    });
    expect(deleted.statusCode).toBe(200);
    expect((deleted.json() as { data: { affected: number } }).data.affected).toBe(2);

    const audit = await ctx.app.inject({ method: 'GET', url: '/api/v1/audit-logs', headers });
    const body = audit.json() as { data: { items: Array<{ action: string }> } };
    expect(body.data.items.some((entry) => entry.action === 'items.delete')).toBe(true);
  });

  it('导出 csv / json / markdown 三种格式', async () => {
    ctx = await createTestApp();
    seedItems(ctx.db);
    const headers = authHeader(ctx.token);

    const csv = await ctx.app.inject({ method: 'GET', url: '/api/v1/items/export?format=csv', headers });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain('标题');
    expect(csv.body).toContain('OpenAI');

    const json = await ctx.app.inject({ method: 'GET', url: '/api/v1/items/export?format=json', headers });
    expect(json.statusCode).toBe(200);
    expect(json.headers['content-type']).toContain('application/json');
    expect((JSON.parse(json.body) as unknown[]).length).toBe(5);

    const markdown = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items/export?format=markdown',
      headers,
    });
    expect(markdown.statusCode).toBe(200);
    expect(markdown.body).toContain('# Knetsec_Ai 情报导出');
  });

  it('导出受筛选条件约束', async () => {
    ctx = await createTestApp();
    seedItems(ctx.db);
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items/export?format=json&severity=critical',
      headers: authHeader(ctx.token),
    });
    expect((JSON.parse(response.body) as unknown[]).length).toBe(1);
  });
});
