/**
 * REST 统一响应信封。
 *
 * 契约 §6：成功 { success:true, data, requestId }；失败 { success:false, error:{code,message,details?}, requestId }。
 * 把 requestId 写进信封，便于结合 pino 日志定位一次请求的全部链路。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorCode, ApiFailure, ApiSuccess } from '@knetsec/shared';

/** 发送成功信封（默认 200，可指定 201/202）。 */
export function replyOk<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  data: T,
  statusCode = 200,
): FastifyReply {
  const body: ApiSuccess<T> = { success: true, data, requestId: request.id };
  return reply.code(statusCode).send(body);
}

/** 构造失败信封（全局错误处理器使用）。 */
export function buildFailure(
  request: FastifyRequest,
  code: ApiErrorCode,
  message: string,
  details?: unknown,
): ApiFailure {
  return {
    success: false,
    error: { code, message, ...(details === undefined ? {} : { details }) },
    requestId: request.id,
  };
}

/** 发送失败信封。 */
export function replyError(
  request: FastifyRequest,
  reply: FastifyReply,
  statusCode: number,
  code: ApiErrorCode,
  message: string,
  details?: unknown,
): FastifyReply {
  return reply.code(statusCode).send(buildFailure(request, code, message, details));
}
