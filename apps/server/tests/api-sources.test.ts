/**
 * 数据源管理集成测试：校验、409、不可改 key/adapter、启停、试采（假采集器）、删除保留历史。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { CollectorFactory } from '../src/modules/core/context.js';
import { authHeader, createTestApp, createViewer, insertItem, type TestApp } from './api-helpers.js';

let ctx: TestApp | null = null;
afterEach(async () => {
  if (ctx) {
    await ctx.close();
    ctx = null;
  }
});

/** 假采集器工厂：返回两条固定数据，绝不访问外网。 */
const fakeCollectorFactory: CollectorFactory = (source) => ({
  id: source.adapter,
  async fetch() {
    return {
      items: [{ title: '假数据标题一' }, { title: '假数据标题二' }],
      warnings: [],
    };
  },
});

describe('数据源管理', () => {
  it('创建数据源成功（201）并返回 DTO', async () => {
    ctx = await createTestApp();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sources',
      headers: authHeader(ctx.token),
      payload: {
        key: 'test-rss',
        name: '测试 RSS',
        category: 'media',
        adapter: 'rss',
        url: 'https://example.com/feed.xml',
        config: { url: 'https://example.com/feed.xml', maxItems: 10 },
        intervalMinutes: 60,
        priority: 10,
      },
    });
    expect(response.statusCode).toBe(201);
    const source = (
      response.json() as { data: { key: string; config: Record<string, unknown>; enabled: boolean } }
    ).data;
    expect(source.key).toBe('test-rss');
    expect(source.enabled).toBe(true);
    expect(source.config.maxItems).toBe(10);
  });

  it('重复 key 返回 409', async () => {
    ctx = await createTestApp();
    const payload = { key: 'dup-source', name: '重复源', category: 'media', adapter: 'rss' };
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sources',
      headers: authHeader(ctx.token),
      payload,
    });
    expect(first.statusCode).toBe(201);
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sources',
      headers: authHeader(ctx.token),
      payload,
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: { code: string } }).error.code).toBe('CONFLICT');
  });

  it('校验非法 key / adapter / interval / URL（400）', async () => {
    ctx = await createTestApp();
    const headers = authHeader(ctx.token);
    const cases = [
      { key: 'Bad Key', name: 'x', category: 'media', adapter: 'rss' },
      { key: 'ok-key', name: 'x', category: 'media', adapter: 'not_an_adapter' },
      { key: 'ok-key2', name: 'x', category: 'media', adapter: 'rss', intervalMinutes: 1 },
      { key: 'ok-key3', name: 'x', category: 'media', adapter: 'rss', url: 'ftp://bad' },
      { key: 'ok-key4', name: '', category: 'media', adapter: 'rss' },
    ];
    for (const payload of cases) {
      const response = await ctx.app.inject({ method: 'POST', url: '/api/v1/sources', headers, payload });
      expect(response.statusCode).toBe(400);
      expect((response.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('key / adapter 创建后不可修改，其它字段可改', async () => {
    ctx = await createTestApp();
    const headers = authHeader(ctx.token);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sources',
      headers,
      payload: { key: 'patch-source', name: '原名', category: 'media', adapter: 'rss' },
    });
    const id = (created.json() as { data: { id: number } }).data.id;

    const changeAdapter = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/sources/${id}`,
      headers,
      payload: { adapter: 'arxiv' },
    });
    expect(changeAdapter.statusCode).toBe(400);

    const changeKey = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/sources/${id}`,
      headers,
      payload: { key: 'another-key' },
    });
    expect(changeKey.statusCode).toBe(400);

    const rename = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/sources/${id}`,
      headers,
      payload: { name: '新名字', intervalMinutes: 120 },
    });
    expect(rename.statusCode).toBe(200);
    const updated = (rename.json() as { data: { name: string; intervalMinutes: number } }).data;
    expect(updated.name).toBe('新名字');
    expect(updated.intervalMinutes).toBe(120);
  });

  it('启停切换 enabled', async () => {
    ctx = await createTestApp();
    const headers = authHeader(ctx.token);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sources',
      headers,
      payload: { key: 'toggle-source', name: '启停源', category: 'media', adapter: 'rss' },
    });
    const id = (created.json() as { data: { id: number } }).data.id;

    const toggled = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/sources/${id}/toggle`,
      headers,
    });
    expect(toggled.statusCode).toBe(200);
    expect((toggled.json() as { data: { enabled: boolean } }).data.enabled).toBe(false);
  });

  it('试采调用假采集器且不写库', async () => {
    ctx = await createTestApp({ collectorFactory: fakeCollectorFactory });
    const headers = authHeader(ctx.token);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sources',
      headers,
      payload: { key: 'probe-source', name: '试采源', category: 'media', adapter: 'rss' },
    });
    const id = (created.json() as { data: { id: number } }).data.id;

    const before = ctx.db.scalar<number>('SELECT COUNT(1) FROM items') ?? 0;
    const result = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/sources/${id}/test`,
      headers,
    });
    expect(result.statusCode).toBe(200);
    const body = (
      result.json() as {
        data: { ok: boolean; fetched: number; sample: string[]; adapter: string; durationMs: number };
      }
    ).data;
    expect(body.ok).toBe(true);
    expect(body.fetched).toBe(2);
    expect(body.sample).toEqual(['假数据标题一', '假数据标题二']);
    expect(body.adapter).toBe('rss');
    expect(body.durationMs).toBeGreaterThanOrEqual(0);

    const after = ctx.db.scalar<number>('SELECT COUNT(1) FROM items') ?? 0;
    expect(after).toBe(before);
  });

  it('删除数据源保留历史情报', async () => {
    ctx = await createTestApp();
    const headers = authHeader(ctx.token);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sources',
      headers,
      payload: { key: 'delete-source', name: '待删源', category: 'media', adapter: 'rss' },
    });
    const id = (created.json() as { data: { id: number } }).data.id;
    insertItem(ctx.db, { title: '历史情报不可删除', sourceKey: 'delete-source', sourceName: '待删源' });

    const deleted = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/sources/${id}`, headers });
    expect(deleted.statusCode).toBe(200);

    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/sources', headers });
    expect(
      (list.json() as { data: Array<{ key: string }> }).data.some((source) => source.key === 'delete-source'),
    ).toBe(false);

    const items = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items?q=历史情报不可删除',
      headers,
    });
    expect((items.json() as { data: { total: number } }).data.total).toBe(1);
  });

  it('不存在的 id 返回 404', async () => {
    ctx = await createTestApp();
    const headers = authHeader(ctx.token);
    const response = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/sources/99999',
      headers,
      payload: { name: 'x' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('viewer 不能创建数据源（403）', async () => {
    ctx = await createTestApp();
    const viewerToken = await createViewer(ctx.app, ctx.db);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sources',
      headers: authHeader(viewerToken),
      payload: { key: 'viewer-source', name: 'x', category: 'media', adapter: 'rss' },
    });
    expect(response.statusCode).toBe(403);
  });
});
