/**
 * 报告服务：区间解析、情报装载、Markdown/HTML 生成、落盘与 reports 表读写。
 *
 * 为什么生成逻辑放 service 而非路由：定时任务（每周一 08:00）也要生成报告，
 * 必须与手动接口共用同一套逻辑，否则两条路径的报告口径会漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  REPORT_TYPES,
  type GenerateReportInput,
  type Paginated,
  type ReportDTO,
  type ReportDetailDTO,
  type ReportType,
} from '@knetsec/shared';
import type { Db } from '../../infra/db.js';
import type { AppLogger } from '../../infra/logger.js';
import { ITEM_COLUMNS, mapItemRow, type ItemRow } from '../core/items-mapper.js';
import { toPaginated, type PageParams } from '../core/pagination.js';
import type { SettingsStore } from '../core/settings-store.js';
import { buildReportMarkdown } from './generator.js';
import { renderReportHtml } from './renderer.js';

/** 报告服务依赖。 */
export interface ReportServiceDeps {
  db: Db;
  logger: AppLogger;
  settings: SettingsStore;
  /** 报告落盘根目录（data/reports）。 */
  reportsDir: string;
  /** 时钟，测试注入固定时间。 */
  now?: () => Date;
}

/** 生成报告参数（在 shared GenerateReportInput 基础上补充操作者）。 */
export interface GenerateReportOptions extends GenerateReportInput {
  createdBy: string;
}

/** reports 表完整行。 */
interface ReportRow {
  id: number;
  type: string;
  title: string;
  period_start: string;
  period_end: string;
  item_count: number;
  markdown: string;
  html: string;
  file_path: string | null;
  created_by: string;
  created_at: string;
}

/** 列表查询行（不取正文，只取前 800 字符预览，避免列表响应过大）。 */
interface ReportListRow {
  id: number;
  type: string;
  title: string;
  period_start: string;
  period_end: string;
  item_count: number;
  preview: string;
  created_by: string;
  created_at: string;
}

/** 报告列表查询条件。 */
export interface ReportListFilter {
  page: PageParams;
  type?: ReportType;
}

/** 补零。 */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地日期 → yyyyMMdd（落盘目录名）。 */
function compactDate(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/** 校验并规范化 ISO 时间；非法值返回 undefined。 */
function normalizeIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}

/** 行 → 列表 DTO。 */
function mapReportRow(row: ReportListRow): ReportDTO {
  return {
    id: row.id,
    type: row.type as ReportType,
    title: row.title,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    itemCount: row.item_count,
    createdAt: row.created_at,
    createdBy: row.created_by,
    preview: row.preview,
  };
}

/** 行 → 详情 DTO。 */
function mapReportDetail(row: ReportRow): ReportDetailDTO {
  return {
    id: row.id,
    type: row.type as ReportType,
    title: row.title,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    itemCount: row.item_count,
    createdAt: row.created_at,
    createdBy: row.created_by,
    preview: row.markdown.slice(0, 800),
    markdown: row.markdown,
    html: row.html,
  };
}

/** 报告服务。 */
export class ReportService {
  constructor(private readonly deps: ReportServiceDeps) {}

  /** 分页查询报告列表。 */
  list(filter: ReportListFilter): Paginated<ReportDTO> {
    const where = filter.type ? ' WHERE type = ?' : '';
    const params: Array<string | number> = filter.type ? [filter.type] : [];
    const total = this.deps.db.scalar<number>(`SELECT COUNT(1) FROM reports${where}`, params) ?? 0;
    const rows = this.deps.db.all<ReportListRow>(
      `SELECT id, type, title, period_start, period_end, item_count, substr(markdown, 1, 800) AS preview,
              created_by, created_at
         FROM reports${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, filter.page.pageSize, filter.page.offset],
    );
    return toPaginated(rows.map(mapReportRow), total, filter.page);
  }

  /** 查询报告详情（含 markdown/html）。 */
  getById(id: number): ReportDetailDTO | null {
    const row = this.deps.db.get<ReportRow>(
      `SELECT id, type, title, period_start, period_end, item_count, markdown, html, file_path, created_by, created_at
         FROM reports WHERE id = ?`,
      [id],
    );
    return row ? mapReportDetail(row) : null;
  }

  /** 删除报告记录并尽力清理落盘目录（历史文件不参与业务，删掉避免磁盘堆积）。 */
  remove(id: number): boolean {
    const row = this.deps.db.get<{ id: number; file_path: string | null }>(
      'SELECT id, file_path FROM reports WHERE id = ?',
      [id],
    );
    if (!row) return false;
    this.deps.db.run('DELETE FROM reports WHERE id = ?', [id]);
    if (row.file_path) {
      this.removeReportDir(row.file_path);
    }
    return true;
  }

  /**
   * 生成并保存报告。
   *
   * @throws 参数非法时抛 AppError(VALIDATION_ERROR)
   */
  generate(options: GenerateReportOptions): ReportDetailDTO {
    const now = this.deps.now?.() ?? new Date();
    const type: ReportType = (REPORT_TYPES as readonly string[]).includes(options.type ?? '')
      ? (options.type as ReportType)
      : 'weekly';
    const settings = this.deps.settings.get();
    const period = this.resolvePeriod(type, options.periodStart, options.periodEnd, now);
    const items = this.loadItems(options.itemIds, period.start, period.end);

    const built = buildReportMarkdown({
      items,
      type,
      periodStart: period.start,
      periodEnd: period.end,
      title: options.title,
      settings,
      now,
    });
    const html = renderReportHtml({
      title: built.title,
      markdown: built.markdown,
      generatedAt: now.toISOString(),
    });
    const createdAt = now.toISOString();

    const reportId = this.deps.db.run(
      `INSERT INTO reports (type, title, period_start, period_end, item_count, markdown, html, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        type,
        built.title,
        period.start,
        period.end,
        built.itemCount,
        built.markdown,
        html,
        options.createdBy,
        createdAt,
      ],
    ).lastInsertRowid;

    this.persistFiles(reportId, type, createdAt, built.markdown, html);
    return this.getById(reportId) as ReportDetailDTO;
  }

  /** 落盘 data/reports/<id>-<type>-<yyyyMMdd>/report.md + report.html。 */
  private persistFiles(
    reportId: number,
    type: ReportType,
    createdAt: string,
    markdown: string,
    html: string,
  ): void {
    const dirName = `${reportId}-${type}-${compactDate(new Date(createdAt))}`;
    const dir = path.join(this.deps.reportsDir, dirName);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'report.md'), markdown, 'utf8');
      fs.writeFileSync(path.join(dir, 'report.html'), html, 'utf8');
      this.deps.db.run('UPDATE reports SET file_path = ? WHERE id = ?', [dir, reportId]);
      this.deps.logger.info({ reportId, dir }, '报告已落盘');
    } catch (error) {
      // 落盘失败不影响报告可用性：正文已存库，下载接口从库读取
      this.deps.logger.warn({ reportId, err: String(error) }, '报告落盘失败（正文已存库，可正常下载）');
    }
  }

  /** 删除落盘目录（只允许删除 reportsDir 下的路径，防路径穿越）。 */
  private removeReportDir(filePath: string): void {
    try {
      const root = path.resolve(this.deps.reportsDir);
      const target = path.resolve(filePath);
      if (!target.startsWith(root + path.sep)) {
        this.deps.logger.warn({ filePath }, '报告目录不在 reports 根目录下，跳过清理');
        return;
      }
      fs.rmSync(target, { recursive: true, force: true });
    } catch (error) {
      this.deps.logger.warn({ filePath, err: String(error) }, '清理报告目录失败（忽略）');
    }
  }

  /** 按报告类型推断区间；自定义区间缺省时回退 settings.reportRangeDays。 */
  private resolvePeriod(
    type: ReportType,
    rawStart: string | undefined,
    rawEnd: string | undefined,
    now: Date,
  ): { start: string; end: string } {
    const end = normalizeIsoDate(rawEnd) ?? now.toISOString();
    const explicitStart = normalizeIsoDate(rawStart);
    if (explicitStart) {
      return explicitStart <= end ? { start: explicitStart, end } : { start: end, end: explicitStart };
    }

    const settings = this.deps.settings.get();
    const days =
      type === 'daily' ? 1 : type === 'weekly' ? 7 : type === 'monthly' ? 30 : settings.reportRangeDays;
    const start = new Date(Date.parse(end) - days * 24 * 60 * 60 * 1000).toISOString();
    return { start, end };
  }

  /** 装载报告素材：指定 itemIds 时按 id 取，否则按发布/抓取时间区间取（最多 2000 条）。 */
  private loadItems(
    itemIds: number[] | undefined,
    start: string,
    end: string,
  ): ReturnType<typeof mapItemRow>[] {
    if (itemIds && itemIds.length > 0) {
      const unique = [...new Set(itemIds)].slice(0, 2000);
      const placeholders = unique.map(() => '?').join(', ');
      const rows = this.deps.db.all<ItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM items WHERE id IN (${placeholders}) ORDER BY importance DESC, id DESC`,
        unique,
      );
      return rows.map(mapItemRow);
    }
    const rows = this.deps.db.all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM items
        WHERE COALESCE(published_at, fetched_at) >= ? AND COALESCE(published_at, fetched_at) <= ?
        ORDER BY importance DESC, id DESC LIMIT 2000`,
      [start, end],
    );
    return rows.map(mapItemRow);
  }
}
