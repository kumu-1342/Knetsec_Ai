/**
 * fetch_runs 表行 → shared RunDTO 的映射。
 *
 * 列表接口与任务详情、仪表盘「最近任务」共用，避免三处各写一遍字段转换。
 * logs 以 JSON 字符串数组落库，列表接口为控制响应体积只返回摘要，详情接口才带日志。
 */
import type { RunDTO, RunStatus, RunTrigger } from '@knetsec/shared';

/** fetch_runs 表原始行。 */
export interface RunRow {
  id: number;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  sources_total: number;
  sources_ok: number;
  sources_failed: number;
  items_new: number;
  items_duplicate: number;
  error: string | null;
  logs: string;
}

/** 查询 fetch_runs 的列清单（显式列名）。 */
export const RUN_COLUMNS =
  'id, trigger, status, started_at, finished_at, sources_total, sources_ok, sources_failed, items_new, items_duplicate, error, logs';

/** 解析运行日志 JSON 数组（脏数据回退空数组）。 */
export function parseRunLogs(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((line): line is string => typeof line === 'string');
  } catch {
    return [];
  }
}

/**
 * 行 → DTO。
 * @param includeLogs 列表页传 false 避免一次返回上百条运行的全部日志
 */
export function mapRunRow(row: RunRow, includeLogs = true): RunDTO {
  return {
    id: row.id,
    trigger: row.trigger as RunTrigger,
    status: row.status as RunStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    sourcesTotal: row.sources_total,
    sourcesOk: row.sources_ok,
    sourcesFailed: row.sources_failed,
    itemsNew: row.items_new,
    itemsDuplicate: row.items_duplicate,
    error: row.error,
    logs: includeLogs ? parseRunLogs(row.logs) : [],
  };
}
