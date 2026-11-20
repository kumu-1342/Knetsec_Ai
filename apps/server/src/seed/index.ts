/**
 * 种子数据：默认管理员、默认系统设置、默认数据源（契约 §5 / §7.1）。
 *
 * 幂等原则：启动时每次都会执行，但只在「缺失」时写入：
 * - 没有任何 admin 用户时创建管理员（首次启动），并标记 must_change_password=1；
 * - settings 表逐键补齐默认值，不覆盖管理员已修改的配置；
 * - 默认数据源按 key 插入缺失项，不覆盖运营已调整的启停/间隔/配置。
 */
import type { Db } from '../infra/db.js';
import type { AppLogger } from '../infra/logger.js';
import { hashPassword } from '../infra/security.js';
import { config } from '../config.js';
import { SETTINGS_KEYS, SettingsStore } from '../modules/core/settings-store.js';
import { DEFAULT_SOURCES } from './sources.seed.js';

/** 种子执行结果，便于启动日志与 CLI 输出。 */
export interface SeedResult {
  /** 本次是否新建了管理员账号。 */
  adminCreated: boolean;
  /** settings 表默认键数量（总是全量补齐）。 */
  settingsKeys: number;
  /** 本次新插入的默认数据源数量。 */
  sourcesInserted: number;
}

/**
 * 初始化种子数据（幂等）。
 *
 * @param db 已完成迁移的数据库连接
 * @param logger 结构化日志器
 */
export async function ensureSeedData(db: Db, logger: AppLogger): Promise<SeedResult> {
  // 1) 系统设置：INSERT OR IGNORE 逐键补齐，不覆盖已有值
  const settingsStore = new SettingsStore(db, logger);
  settingsStore.ensureDefaults();

  // 2) 管理员：只在「没有任何 admin」时创建，避免运维删号后无法登录
  const adminCount = db.scalar<number>("SELECT COUNT(1) FROM users WHERE role = 'admin'") ?? 0;
  let adminCreated = false;
  if (adminCount === 0) {
    const passwordHash = await hashPassword(config.admin.password);
    const nowIso = new Date().toISOString();
    const result = db.run(
      'INSERT OR IGNORE INTO users (username, password_hash, display_name, role, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [config.admin.username, passwordHash, '系统管理员', 'admin', 1, nowIso],
    );
    adminCreated = result.changes > 0;
    if (adminCreated) {
      // 不打印密码，只提示账号与「请修改初始密码」
      logger.warn(
        { username: config.admin.username },
        '已创建默认管理员账号（初始密码见 ADMIN_PASSWORD 环境变量），请登录后立即修改',
      );
    }
  }

  // 3) 默认数据源：按 key 幂等插入
  const nowIso = new Date().toISOString();
  let sourcesInserted = 0;
  for (const source of DEFAULT_SOURCES) {
    const result = db.run(
      `INSERT OR IGNORE INTO sources
         (key, name, category, adapter, url, config, enabled, interval_minutes, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        source.key,
        source.name,
        source.category,
        source.adapter,
        source.url ?? null,
        JSON.stringify(source.config ?? {}),
        source.enabled === false ? 0 : 1,
        source.intervalMinutes ?? 360,
        source.priority ?? 100,
        nowIso,
        nowIso,
      ],
    );
    sourcesInserted += result.changes;
  }

  logger.info(
    {
      adminCreated,
      sourcesInserted,
      sourcesTotal: DEFAULT_SOURCES.length,
      settingsKeys: SETTINGS_KEYS.length,
    },
    '种子数据检查完成',
  );
  return { adminCreated, settingsKeys: SETTINGS_KEYS.length, sourcesInserted };
}
