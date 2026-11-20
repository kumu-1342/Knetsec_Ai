/**
 * 鉴权守卫与 JWT 载荷类型。
 *
 * 为什么在 requireAuth 里回查数据库：JWT 只有 12 小时有效期，但管理员可能在此期间
 * 被删除或降权；每次请求多一次 SQLite 主键查询（微秒级）换取权限实时性，值得。
 *
 * 类型增强（declare module）放在本文件而不是分散到各处：
 * - FastifyRequest.authUser：守卫注入的当前用户；
 * - @fastify/jwt 的 payload/user：统一签名与校验的载荷结构。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
// 显式加载 @fastify/jwt 的类型扩展（它通过 declare module 'fastify' 补充 jwt / jwtVerify / user）
import '@fastify/jwt';
import type { AuthUser, UserRole } from '@knetsec/shared';
import { forbidden, unauthorized } from '../../infra/errors.js';
import type { AppContext } from './context.js';

/** JWT 载荷：sub 为用户 id，其余字段用于无库快速展示与审计。 */
export interface JwtPayload {
  sub: number;
  username: string;
  role: UserRole;
  displayName: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** 通过 requireAuth 后一定存在；未鉴权路由上为 undefined。 */
    authUser?: AuthUser;
  }
}

/** 路由守卫集合。 */
export interface RouteGuards {
  /** 必须登录；校验 token 并回查用户。 */
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** 必须为 admin；viewer 调写接口返回 403。 */
  requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  role: string;
  must_change_password: number;
  last_login_at: string | null;
}

/** 从数据库行构造 AuthUser（路由与 /auth/me 共用）。 */
export function mapAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role as UserRole,
    mustChangePassword: row.must_change_password === 1,
    lastLoginAt: row.last_login_at,
  };
}

/** 查询用户行（鉴权回查、登录、改密共用，禁止 SELECT *）。 */
export function findUserByUsername(ctx: AppContext, username: string): UserRow | undefined {
  return ctx.db.get<UserRow>(
    'SELECT id, username, display_name, role, must_change_password, last_login_at FROM users WHERE username = ?',
    [username],
  );
}

/** 按 id 查询用户行。 */
export function findUserById(ctx: AppContext, id: number): UserRow | undefined {
  return ctx.db.get<UserRow>(
    'SELECT id, username, display_name, role, must_change_password, last_login_at FROM users WHERE id = ?',
    [id],
  );
}

/** 取当前登录用户（守卫之后调用；缺失说明路由配置错误，一律按未授权处理）。 */
export function currentUser(request: FastifyRequest): AuthUser {
  if (!request.authUser) throw unauthorized();
  return request.authUser;
}

/** 创建守卫（绑定 ctx 以访问数据库）。 */
export function createGuards(ctx: AppContext): RouteGuards {
  const requireAuth = async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    let payload: JwtPayload;
    try {
      payload = await request.jwtVerify<JwtPayload>();
    } catch {
      // 过期、签名错误、缺少 header 全部归一成 401，避免泄露具体校验细节
      throw unauthorized();
    }

    const row = findUserById(ctx, payload.sub);
    if (!row) throw unauthorized('账号不存在或已被删除，请重新登录');
    request.authUser = mapAuthUser(row);
  };

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await requireAuth(request, reply);
    if (currentUser(request).role !== 'admin') throw forbidden();
  };

  return { requireAuth, requireAdmin };
}

/** 供 app.ts 注册类型增强（保证 @fastify/jwt 装饰器类型可用）。 */
export type { FastifyInstance };
