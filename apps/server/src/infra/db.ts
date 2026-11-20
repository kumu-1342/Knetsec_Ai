/**
 * SQLite 访问层（基于 Node 24 内置 node:sqlite，零原生依赖、免编译）。
 *
 * 为什么不用 better-sqlite3：Windows 上需要 Visual Studio 生成工具编译，
 * 新机器首次安装容易失败；node:sqlite 由 Node 官方提供，开箱即用。
 *
 * 使用约定：
 * - 业务代码只通过 Db 类的 all/get/run/transaction 方法访问数据库；
 * - SQL 全部参数化，禁止字符串拼接用户输入；
 * - 事务用 transaction()，失败自动回滚。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/** 轻量 SQLite 封装。 */
export class Db {
  private readonly db: DatabaseSync;
  private readonly statementCache = new Map<string, StatementSync>();

  constructor(filePath: string) {
    if (filePath !== ':memory:') {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    this.db = new DatabaseSync(filePath);
    // WAL 模式提升并发读性能；busy_timeout 避免调度写库与接口读库短时冲突
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
  }

  /** 执行原生 SQL（仅用于建表/PRAGMA 等无参数语句）。 */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  private statement(sql: string): StatementSync {
    const cached = this.statementCache.get(sql);
    if (cached) return cached;
    const prepared = this.db.prepare(sql);
    this.statementCache.set(sql, prepared);
    return prepared;
  }

  /** 执行写语句，返回影响行数与自增 ID。 */
  run(sql: string, params: SqlValue[] = []): RunResult {
    const result = this.statement(sql).run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  /** 查询单行。 */
  get<T>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.statement(sql).get(...params) as T | undefined;
  }

  /** 查询多行。 */
  all<T>(sql: string, params: SqlValue[] = []): T[] {
    return this.statement(sql).all(...params) as T[];
  }

  /** 单个值查询（COUNT、MAX 等）。 */
  scalar<T = number>(sql: string, params: SqlValue[] = []): T | undefined {
    const row = this.get<Record<string, T>>(sql, params);
    if (!row) return undefined;
    const values = Object.values(row);
    return values.length > 0 ? values[0] : undefined;
  }

  /** 事务包装：BEGIN IMMEDIATE 立即拿写锁，失败自动回滚。 */
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = work();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // 回滚失败通常意味着连接已不可用，交由上层日志记录
      }
      throw error;
    }
  }

  /** 关闭连接（进程退出或测试清理时调用）。 */
  close(): void {
    this.statementCache.clear();
    this.db.close();
  }
}

/** 打开默认数据库（路径来自 config.dbPath）。 */
export function openDatabase(dbPath: string): Db {
  return new Db(dbPath);
}
