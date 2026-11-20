/**
 * 审计日志服务。
 *
 * 契约 §5.3：登录、改设置、增删源、生成报告、批量操作都要留痕。
 * 设计要点：审计写入失败不能影响主流程（例如磁盘满），因此内部吞掉异常并 warn。
 */
import type { AuditLogDTO, Paginated } from '@knetsec/shared';
import type { Db } from '../../infra/db.js';
import type { AppLogger } from '../../infra/logger.js';
import { toPaginated, type PageParams } from './pagination.js';

/** 写入审计所需字段。 */
export interface AuditInput {
  /** 操作者用户名；定时任务用 system。 */
  username: string;
  /** 动作标识，如 auth.login / source.create。 */
  action: string;
  /** 作用对象（如 source:github-ghsa）。 */
  target?: string | null;
  /** 附加信息（禁止写入密码、token 等敏感值）。 */
  detail?: Record<string, unknown> | null;
  /** 客户端 IP。 */
  ip?: string | null;
}

/** 审计日志查询条件。 */
export interface AuditQuery {
  page: PageParams;
  username?: string;
  action?: string;
}

interface AuditRow {
  id: number;
  username: string;
  action: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
  created_at: string;
}

/** 审计日志服务。 */
export class AuditService {
  constructor(
    private readonly db: Db,
    private readonly logger: AppLogger,
  ) {}

  /** 写入一条审计日志（失败仅告警，不阻塞业务）。 */
  record(input: AuditInput): void {
    try {
      this.db.run(
        'INSERT INTO audit_logs (username, action, target, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          input.username,
          input.action,
          input.target ?? null,
          input.detail ? JSON.stringify(input.detail) : null,
          input.ip ?? null,
          new Date().toISOString(),
        ],
      );
    } catch (error) {
      this.logger.warn({ err: String(error), action: input.action }, '审计日志写入失败（已忽略）');
    }
  }

  /** 分页查询审计日志（仅 admin 可访问，见 modules/audit）。 */
  list(query: AuditQuery): Paginated<AuditLogDTO> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (query.username) {
      where.push('username = ?');
      params.push(query.username);
    }
    if (query.action) {
      where.push('action LIKE ?');
      params.push(`%${query.action}%`);
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';

    const total = this.db.scalar<number>(`SELECT COUNT(1) FROM audit_logs${whereSql}`, params) ?? 0;
    const rows = this.db.all<AuditRow>(
      `SELECT id, username, action, target, detail, ip, created_at FROM audit_logs${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, query.page.pageSize, query.page.offset],
    );

    return toPaginated(rows.map((row) => this.mapRow(row)), total, query.page);
  }

  private mapRow(row: AuditRow): AuditLogDTO {
    let detail: Record<string, unknown> | null = null;
    if (row.detail) {
      try {
        const parsed = JSON.parse(row.detail) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          detail = parsed as Record<string, unknown>;
        }
      } catch {
        detail = null;
      }
    }
    return {
      id: row.id,
      username: row.username,
      action: row.action,
      target: row.target,
      detail,
      ip: row.ip,
      createdAt: row.created_at,
    };
  }
}
