/**
 * 系统设置存储（settings 表，键值对 + JSON 值）。
 *
 * 为什么带内存缓存：调度器、每条采集流水线、几乎每个请求都要读设置，
 * 而 SQLite 同步查询虽然快，但高频读仍会与采集写库抢锁；设置变更频率极低，
 * 因此启动加载一次、PUT 后整表重载即可。
 */
import { DEFAULT_SETTINGS, type AppSettings } from '@knetsec/shared';
import type { Db } from '../../infra/db.js';
import type { AppLogger } from '../../infra/logger.js';

/** 设置项键名（与 AppSettings 字段一致，seed 时逐项写入）。 */
export type SettingsKey = keyof AppSettings;

export const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingsKey[];

/**
 * 把数据库中的 JSON 值按默认值的类型还原；类型不符时返回 undefined（由调用方回退默认值）。
 * 这样即使有人手工改坏 settings 表，服务也不会因类型错误崩溃。
 */
function normalizeValue<K extends SettingsKey>(key: K, value: unknown): AppSettings[K] | undefined {
  const fallback: AppSettings[K] = DEFAULT_SETTINGS[key];
  if (Array.isArray(fallback)) {
    if (!Array.isArray(value)) return undefined;
    const list = value.filter((item): item is string => typeof item === 'string');
    return list as unknown as AppSettings[K];
  }
  if (typeof fallback === 'number') {
    return (typeof value === 'number' && Number.isFinite(value) ? value : undefined) as unknown as AppSettings[K];
  }
  if (typeof fallback === 'boolean') {
    return (typeof value === 'boolean' ? value : undefined) as unknown as AppSettings[K];
  }
  return (typeof value === 'string' ? value : undefined) as unknown as AppSettings[K];
}

/** 系统设置读写器。 */
export class SettingsStore {
  private cache: AppSettings;

  constructor(
    private readonly db: Db,
    private readonly logger: AppLogger,
  ) {
    this.cache = this.load();
  }

  /** 从数据库加载设置并与默认值合并（缺项用默认值补齐）。 */
  private load(): AppSettings {
    const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    const rows = this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings');
    for (const row of rows) {
      if (!SETTINGS_KEYS.includes(row.key as SettingsKey)) continue;
      try {
        const parsed = JSON.parse(row.value) as unknown;
        const normalized = normalizeValue(row.key as SettingsKey, parsed);
        if (normalized !== undefined) merged[row.key] = normalized;
      } catch (error) {
        this.logger.warn({ key: row.key, err: String(error) }, '设置项解析失败，已回退默认值');
      }
    }
    return merged as unknown as AppSettings;
  }

  /** 同步读取当前设置（返回副本，避免调用方误改缓存）。 */
  get(): AppSettings {
    return { ...this.cache };
  }

  /** 整表重载（PUT /settings 后调用）。 */
  reload(): AppSettings {
    this.cache = this.load();
    return this.get();
  }

  /** 幂等写入默认值：仅补齐 settings 表缺失的键，不覆盖已有值（seed 使用）。 */
  ensureDefaults(): void {
    const now = new Date().toISOString();
    for (const key of SETTINGS_KEYS) {
      this.db.run('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)', [
        key,
        JSON.stringify(DEFAULT_SETTINGS[key]),
        now,
      ]);
    }
    this.cache = this.load();
  }

  /**
   * 局部更新设置：只接受 AppSettings 已知键，值统一 JSON 序列化落库。
   * @returns 更新后的完整设置
   */
  update(patch: Partial<AppSettings>): AppSettings {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const key of SETTINGS_KEYS) {
        if (!(key in patch)) continue;
        const value = patch[key];
        if (value === undefined) continue;
        this.db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [
          key,
          JSON.stringify(value),
          now,
        ]);
      }
    });
    this.logger.info({ keys: Object.keys(patch) }, '系统设置已更新');
    return this.reload();
  }
}
