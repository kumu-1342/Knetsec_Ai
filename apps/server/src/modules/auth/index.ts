/**
 * 认证模块：登录、当前用户、修改密码（契约 §6）。
 *
 * 安全要点：
 * - 登录限流 5 次/分钟/IP（防爆破），失败提示统一为「用户名或密码错误」，不泄露用户是否存在；
 * - scrypt 校验（infra/security.ts），比对使用 timingSafeEqual；
 * - JWT 有效期 12 小时，载荷只含 id/用户名/角色/显示名；
 * - 登录、改密写审计日志。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthUser, ChangePasswordRequest, LoginRequest, LoginResponse } from '@knetsec/shared';
import { config } from '../../config.js';
import { unauthorized, badRequest } from '../../infra/errors.js';
import { hashPassword, validatePasswordStrength, verifyPassword } from '../../infra/security.js';
import { createGuards, currentUser, findUserById, mapAuthUser } from '../core/auth-guard.js';
import type { AppContext } from '../core/context.js';
import { replyOk } from '../core/envelope.js';

/** 登录请求体校验（trim 用户名，限制长度防超长哈希 DoS）。 */
const loginSchema = z.object({
  username: z.string().trim().min(1, '请输入用户名').max(64, '用户名过长'),
  password: z.string().min(1, '请输入密码').max(200, '密码过长'),
});

/** 修改密码请求体校验。 */
const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, '请输入原密码').max(200),
  newPassword: z.string().min(1, '请输入新密码').max(200),
});

/** 登录时需要的用户行（含密码哈希，仅在认证模块内使用，绝不返回前端）。 */
interface UserCredentialRow {
  id: number;
  username: string;
  password_hash: string;
  display_name: string;
  role: string;
  must_change_password: number;
  last_login_at: string | null;
}

/** 按用户名查询含密码哈希的用户行。 */
function findCredentialByUsername(ctx: AppContext, username: string): UserCredentialRow | undefined {
  return ctx.db.get<UserCredentialRow>(
    'SELECT id, username, password_hash, display_name, role, must_change_password, last_login_at FROM users WHERE username = ?',
    [username],
  );
}

/** 注册认证路由。 */
export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guards = createGuards(ctx);

  app.post(
    '/auth/login',
    {
      // 限流配置由 @fastify/rate-limit 读取；登录是唯一公开写接口，必须最严格
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = loginSchema.parse(request.body) as LoginRequest;
      const row = findCredentialByUsername(ctx, body.username);

      // 用户不存在时也执行一次密码校验，保持响应时间一致，降低用户名枚举风险
      const storedHash = row?.password_hash ?? 'scrypt$N=16384,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA';
      const passwordOk = await verifyPassword(body.password, storedHash);

      if (!row || !passwordOk) {
        ctx.logger.warn({ username: body.username, ip: request.ip }, '登录失败');
        throw unauthorized('用户名或密码错误');
      }

      const nowIso = new Date().toISOString();
      ctx.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso, row.id]);

      const token = app.jwt.sign(
        { sub: row.id, username: row.username, role: row.role, displayName: row.display_name },
        { expiresIn: config.jwt.expiresInSeconds },
      );

      const user: AuthUser = {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        role: row.role as AuthUser['role'],
        mustChangePassword: row.must_change_password === 1,
        lastLoginAt: nowIso,
      };
      const result: LoginResponse = {
        token,
        expiresIn: config.jwt.expiresInSeconds,
        user,
      };

      ctx.audit.record({
        username: row.username,
        action: 'auth.login',
        target: `user:${row.username}`,
        detail: { role: row.role },
        ip: request.ip,
      });
      ctx.logger.info({ username: row.username, ip: request.ip }, '登录成功');
      return replyOk(request, reply, result);
    },
  );

  app.get('/auth/me', { preHandler: guards.requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    // 回查一次，确保返回的 lastLoginAt / mustChangePassword 是最新值
    const row = findUserById(ctx, user.id);
    return replyOk(request, reply, row ? mapAuthUser(row) : user);
  });

  app.post('/auth/change-password', { preHandler: guards.requireAuth }, async (request, reply) => {
    const body = changePasswordSchema.parse(request.body) as ChangePasswordRequest;
    const authUser = currentUser(request);
    const row = findCredentialByUsername(ctx, authUser.username);
    if (!row) throw unauthorized();

    const oldOk = await verifyPassword(body.oldPassword, row.password_hash);
    if (!oldOk) throw badRequest('原密码不正确');

    const strengthError = validatePasswordStrength(body.newPassword);
    if (strengthError) throw badRequest(strengthError);
    if (body.oldPassword === body.newPassword) throw badRequest('新密码不能与原密码相同');

    const newHash = await hashPassword(body.newPassword);
    ctx.db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [
      newHash,
      row.id,
    ]);

    ctx.audit.record({
      username: row.username,
      action: 'auth.change_password',
      target: `user:${row.username}`,
      ip: request.ip,
    });
    ctx.logger.info({ username: row.username }, '用户修改密码成功');
    return replyOk(request, reply, { changed: true });
  });
}
