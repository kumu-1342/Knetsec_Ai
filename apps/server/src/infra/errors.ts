/**
 * 统一业务异常与 HTTP 错误映射。
 *
 * 所有模块抛出的可预期错误都应使用 {@link AppError}，由 Fastify 全局错误处理器
 * 转换成 { success:false, error:{code,message} } 信封，避免把堆栈泄露给前端。
 */
import type { ApiErrorCode } from '@knetsec/shared';

export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError('VALIDATION_ERROR', message, 400, details);

export const unauthorized = (message = '登录状态已失效，请重新登录'): AppError =>
  new AppError('UNAUTHORIZED', message, 401);

export const forbidden = (message = '当前账号无权执行该操作'): AppError =>
  new AppError('FORBIDDEN', message, 403);

export const notFound = (message = '资源不存在'): AppError =>
  new AppError('NOT_FOUND', message, 404);

export const conflict = (message: string): AppError => new AppError('CONFLICT', message, 409);

export const upstreamError = (message: string, details?: unknown): AppError =>
  new AppError('UPSTREAM_ERROR', message, 502, details);

export const internalError = (message = '服务器内部错误'): AppError =>
  new AppError('INTERNAL_ERROR', message, 500);
