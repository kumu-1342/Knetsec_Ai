/**
 * 认证模块集成测试：登录、限流、401/403、改密。
 * 全部走 app.inject()，不监听端口、不访问外网。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { authHeader, createTestApp, createViewer, type TestApp } from './api-helpers.js';

let ctx: TestApp | null = null;
afterEach(async () => {
  if (ctx) {
    await ctx.close();
    ctx = null;
  }
});

/** 解析失败信封里的错误码。 */
function errorCode(responseBody: string): string {
  return (JSON.parse(responseBody) as { error: { code: string } }).error.code;
}

describe('认证与限流', () => {
  it('健康检查公开可用且数据库连通', async () => {
    ctx = await createTestApp();
    const root = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(root.statusCode).toBe(200);
    const body = root.json() as { success: boolean; data: { status: string; db: string } };
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ok');
    expect(body.data.db).toBe('ok');

    const prefixed = await ctx.app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(prefixed.statusCode).toBe(200);
  });

  it('登录成功返回 JWT 与管理员信息', async () => {
    ctx = await createTestApp();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: config.admin.username, password: config.admin.password },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success: boolean;
      data: { token: string; expiresIn: number; user: { role: string; mustChangePassword: boolean } };
      requestId: string;
    };
    expect(body.success).toBe(true);
    expect(body.data.token.length).toBeGreaterThan(20);
    expect(body.data.expiresIn).toBe(config.jwt.expiresInSeconds);
    expect(body.data.user.role).toBe('admin');
    // 首次启动的默认管理员必须被标记「需修改密码」
    expect(body.data.user.mustChangePassword).toBe(true);
    expect(body.requestId.length).toBeGreaterThan(10);
  });

  it('错误密码返回 401 UNAUTHORIZED', async () => {
    ctx = await createTestApp();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: config.admin.username, password: 'definitely-wrong' },
    });
    expect(response.statusCode).toBe(401);
    expect(errorCode(response.body)).toBe('UNAUTHORIZED');
  });

  it('未携带 token 访问受保护接口返回 401', async () => {
    ctx = await createTestApp();
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/items' });
    expect(response.statusCode).toBe(401);
    expect(errorCode(response.body)).toBe('UNAUTHORIZED');
  });

  it('伪造 token 返回 401', async () => {
    ctx = await createTestApp();
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('短时间连续失败触发限流 429 RATE_LIMITED', async () => {
    ctx = await createTestApp();
    // 注意：夹具创建应用时已成功登录一次，已占用 1 次额度（max=5/分钟）
    let limited = false;
    let unauthorizedCount = 0;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: config.admin.username, password: `wrong-${attempt}` },
      });
      if (response.statusCode === 429) {
        expect(errorCode(response.body)).toBe('RATE_LIMITED');
        limited = true;
        break;
      }
      expect(response.statusCode).toBe(401);
      unauthorizedCount += 1;
    }
    expect(limited).toBe(true);
    expect(unauthorizedCount).toBeGreaterThanOrEqual(4);
  });

  it('viewer 可以读但不能写（403）', async () => {
    ctx = await createTestApp();
    const viewerToken = await createViewer(ctx.app, ctx.db);

    const listResponse = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/items',
      headers: authHeader(viewerToken),
    });
    expect(listResponse.statusCode).toBe(200);

    const writeResponse = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/items/bulk',
      headers: authHeader(viewerToken),
      payload: { ids: [1], action: 'mark_read' },
    });
    expect(writeResponse.statusCode).toBe(403);
    expect(errorCode(writeResponse.body)).toBe('FORBIDDEN');
  });

  it('修改密码：旧密码错误返回 400，成功后可用新密码登录', async () => {
    ctx = await createTestApp();
    const wrongOld = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: authHeader(ctx.token),
      payload: { oldPassword: 'not-the-old-password', newPassword: 'newPass1234' },
    });
    expect(wrongOld.statusCode).toBe(400);

    const weakPassword = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: authHeader(ctx.token),
      payload: { oldPassword: config.admin.password, newPassword: 'short' },
    });
    expect(weakPassword.statusCode).toBe(400);

    const changed = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: authHeader(ctx.token),
      payload: { oldPassword: config.admin.password, newPassword: 'newPass1234' },
    });
    expect(changed.statusCode).toBe(200);

    const relogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: config.admin.username, password: 'newPass1234' },
    });
    expect(relogin.statusCode).toBe(200);
    const body = relogin.json() as { data: { user: { mustChangePassword: boolean } } };
    expect(body.data.user.mustChangePassword).toBe(false);
  });
});
