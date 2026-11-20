/**
 * 系统设置集成测试：脱敏、空值保持、校验、权限、审计。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { authHeader, createTestApp, createViewer, type TestApp } from './api-helpers.js';

let ctx: TestApp | null = null;
afterEach(async () => {
  if (ctx) {
    await ctx.close();
    ctx = null;
  }
});

/** 从 settings 表读取原始 JSON 值。 */
function rawSetting(db: TestApp['db'], key: string): unknown {
  const row = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? (JSON.parse(row.value) as unknown) : undefined;
}

describe('系统设置', () => {
  it('GET 返回默认设置且 llmApiKey 为空时不泄露', async () => {
    ctx = await createTestApp();
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: authHeader(ctx.token),
    });
    expect(response.statusCode).toBe(200);
    const settings = (
      response.json() as { data: { llmApiKey: string; retentionDays: number; reportSections: string[] } }
    ).data;
    expect(settings.llmApiKey).toBe('');
    expect(settings.retentionDays).toBe(180);
    expect(settings.reportSections.length).toBeGreaterThan(0);
  });

  it('PUT 更新后 GET 返回脱敏 Key，但库中保留明文', async () => {
    ctx = await createTestApp();
    const headers = authHeader(ctx.token);
    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers,
      payload: { llmEnabled: true, llmApiKey: 'sk-test-1234567890', retentionDays: 90 },
    });
    expect(put.statusCode).toBe(200);
    const masked = (put.json() as { data: { llmApiKey: string; retentionDays: number } }).data;
    expect(masked.llmApiKey).toBe('sk-t****7890');
    expect(masked.llmApiKey).not.toContain('1234567890');
    expect(masked.retentionDays).toBe(90);
    expect(rawSetting(ctx.db, 'llmApiKey')).toBe('sk-test-1234567890');
  });

  it('llmApiKey 传空字符串或脱敏值表示保持原值', async () => {
    ctx = await createTestApp();
    const headers = authHeader(ctx.token);
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers,
      payload: { llmApiKey: 'sk-original-abcdefgh' },
    });

    const emptyPut = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers,
      payload: { llmApiKey: '', notificationEnabled: true },
    });
    expect(emptyPut.statusCode).toBe(200);
    expect(rawSetting(ctx.db, 'llmApiKey')).toBe('sk-original-abcdefgh');
    expect(rawSetting(ctx.db, 'notificationEnabled')).toBe(true);

    const maskedPut = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers,
      payload: { llmApiKey: 'sk-o****efgh' },
    });
    expect(maskedPut.statusCode).toBe(200);
    expect(rawSetting(ctx.db, 'llmApiKey')).toBe('sk-original-abcdefgh');
  });

  it('非法值返回 400', async () => {
    ctx = await createTestApp();
    const headers = authHeader(ctx.token);
    const cases = [
      { retentionDays: 3 },
      { reportRangeDays: 0 },
      { llmBaseUrl: 'ftp://not-http' },
      { notificationChannel: 'sms' },
      { reportSections: ['not-a-category'] },
    ];
    for (const payload of cases) {
      const response = await ctx.app.inject({ method: 'PUT', url: '/api/v1/settings', headers, payload });
      expect(response.statusCode).toBe(400);
    }
  });

  it('viewer 不能修改设置（403）', async () => {
    ctx = await createTestApp();
    const viewerToken = await createViewer(ctx.app, ctx.db);
    const response = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: authHeader(viewerToken),
      payload: { retentionDays: 90 },
    });
    expect(response.statusCode).toBe(403);
  });

  it('设置变更写入审计日志（只记录字段名）', async () => {
    ctx = await createTestApp();
    const headers = authHeader(ctx.token);
    await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/settings',
      headers,
      payload: { watchKeywords: ['openai', 'mcp'] },
    });
    const audit = await ctx.app.inject({ method: 'GET', url: '/api/v1/audit-logs', headers });
    const body = audit.json() as {
      data: { items: Array<{ action: string; detail: Record<string, unknown> | null }> };
    };
    const entry = body.data.items.find((item) => item.action === 'settings.update');
    expect(entry).toBeTruthy();
    expect(entry?.detail).toEqual({ keys: ['watchKeywords'] });
  });
});
