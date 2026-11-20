/**
 * 分页与数值解析工具。
 *
 * 所有列表接口共用：page 从 1 开始、pageSize 上限 100（shared MAX_PAGE_SIZE），
 * 避免前端传入超大 pageSize 拖垮 SQLite 与网络。
 */
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type Paginated } from '@knetsec/shared';
import { badRequest } from '../../infra/errors.js';

/** 归一化后的分页参数。 */
export interface PageParams {
  page: number;
  pageSize: number;
  offset: number;
}

/** 把任意输入安全转成整数并夹到 [min, max]；非法值回退 fallback。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const int = Math.trunc(parsed);
  if (int < min) return min;
  if (int > max) return max;
  return int;
}

/** 从 query 中解析分页参数（query 全部是字符串，需容错）。 */
export function parsePage(input: { page?: unknown; pageSize?: unknown }): PageParams {
  const page = clampInt(input.page, 1, 1, 1_000_000);
  const pageSize = clampInt(input.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** 组装 shared Paginated<T>；total 为不受分页影响的命中总数。 */
export function toPaginated<T>(items: T[], total: number, params: PageParams): Paginated<T> {
  return {
    items,
    page: params.page,
    pageSize: params.pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / params.pageSize),
  };
}

/** 解析路径参数中的正整数 id；非法值抛 400 由全局错误处理器转成标准信封。 */
export function parseId(raw: unknown, label = 'id'): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`INVALID_ID:${label}`);
  }
  return value;
}