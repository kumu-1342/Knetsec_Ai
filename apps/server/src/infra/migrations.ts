/**
 * 数据库迁移。
 *
 * 采用「版本号 + 顺序执行 + 记录到 schema_migrations」的轻量方案：
 * - 每个版本的 SQL 只允许追加，不允许修改已发布版本（生产数据已执行过）；
 * - 迁移在服务启动时自动执行，单事务保证原子性；
 * - 新增表/字段时同时更新 docs/03-总体架构设计.md 的数据模型章节。
 */
import type { Db } from './db.js';
import type { AppLogger } from './logger.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init_schema',
    sql: `
      -- 管理员/只读用户
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        must_change_password INTEGER NOT NULL DEFAULT 0,
        last_login_at TEXT,
        created_at TEXT NOT NULL
      );

      -- 数据源注册表（管理面板可增删改、启停）
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        adapter TEXT NOT NULL,
        url TEXT,
        config TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        interval_minutes INTEGER NOT NULL DEFAULT 360,
        priority INTEGER NOT NULL DEFAULT 100,
        last_run_at TEXT,
        last_status TEXT,
        last_error TEXT,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- 情报条目（去重后的事实表）
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT NOT NULL UNIQUE,
        source_key TEXT NOT NULL,
        source_name TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        url TEXT,
        author TEXT,
        published_at TEXT,
        fetched_at TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'news',
        tags TEXT NOT NULL DEFAULT '[]',
        severity TEXT NOT NULL DEFAULT 'unknown',
        cve_ids TEXT NOT NULL DEFAULT '[]',
        ghsa_ids TEXT NOT NULL DEFAULT '[]',
        cvss_score REAL,
        is_kev INTEGER NOT NULL DEFAULT 0,
        vendor TEXT,
        lang TEXT NOT NULL DEFAULT 'en',
        importance INTEGER NOT NULL DEFAULT 0,
        raw TEXT,
        is_read INTEGER NOT NULL DEFAULT 0,
        is_starred INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_items_published ON items (published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_items_fetched ON items (fetched_at DESC);
      CREATE INDEX IF NOT EXISTS idx_items_source ON items (source_key, published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_items_category ON items (category, published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_items_severity ON items (severity, published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_items_read ON items (is_read);

      -- 采集任务运行记录（含结构化日志行）
      CREATE TABLE IF NOT EXISTS fetch_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        sources_total INTEGER NOT NULL DEFAULT 0,
        sources_ok INTEGER NOT NULL DEFAULT 0,
        sources_failed INTEGER NOT NULL DEFAULT 0,
        items_new INTEGER NOT NULL DEFAULT 0,
        items_duplicate INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        logs TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_runs_started ON fetch_runs (started_at DESC);

      -- 自动生成的报告
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        item_count INTEGER NOT NULL DEFAULT 0,
        markdown TEXT NOT NULL,
        html TEXT NOT NULL,
        file_path TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reports_created ON reports (created_at DESC);

      -- 键值型系统设置
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- 审计日志
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        detail TEXT,
        ip TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs (created_at DESC);
    `,
  },
];

/**
 * 执行所有未应用的迁移。
 * @returns 本次实际执行的迁移版本号列表
 */
export function migrate(db: Db, logger: AppLogger): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.all<{ version: number }>('SELECT version FROM schema_migrations').map((row) => row.version),
  );

  const executed: number[] = [];
  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue;

    db.transaction(() => {
      db.exec(migration.sql);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        new Date().toISOString(),
      ]);
    });

    executed.push(migration.version);
    logger.info({ version: migration.version, name: migration.name }, '数据库迁移已执行');
  }

  return executed;
}
