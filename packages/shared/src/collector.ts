/**
 * 采集器（Collector）扩展契约。
 *
 * 设计目标：新增一个数据源 = 写一个实现 {@link CollectorAdapter} 的类 + 在数据库登记一行
 * sources 记录，不修改流水线代码。适配器只负责「把外部数据变成 RawItem」，不直接写库、
 * 不负责去重与打标——那些属于流水线（pipeline）职责，便于单测与复用。
 */
import type { AdapterId, ItemCategory, Severity, SourceCategory } from './domain.js';
import type { AppSettings } from './constants.js';

/** 数据源运行期描述（来自 sources 表，供适配器使用）。 */
export interface SourceDescriptor {
  id: number;
  /** 稳定唯一键，如 github-ghsa、nvd-cve */
  key: string;
  name: string;
  category: SourceCategory;
  adapter: AdapterId;
  url: string | null;
  /** 适配器私有配置（JSON），结构由各适配器自行校验 */
  config: Record<string, unknown>;
  enabled: boolean;
  intervalMinutes: number;
  priority: number;
}

/** 最小日志接口：pino 与测试桩都满足，避免适配器直接依赖 pino。 */
export interface CollectorLogger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** 采集器可用的 HTTP 客户端（带超时、重试、UA、代理支持）。 */
export interface CollectorHttpClient {
  getText(url: string, init?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<string>;
  getJson<T = unknown>(
    url: string,
    init?: { headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<T>;
}

/** 采集器执行上下文。 */
export interface CollectorContext {
  source: SourceDescriptor;
  /** 本次采集的基准时间（测试时可注入固定值，保证幂等） */
  now: Date;
  logger: CollectorLogger;
  http: CollectorHttpClient;
  settings: AppSettings;
  /** 可选凭据（如 GITHUB_TOKEN / NVD_API_KEY），由服务端注入 */
  secrets: {
    githubToken: string;
    nvdApiKey: string;
  };
}

/** 适配器输出的标准化原始条目（未去重、未落库）。 */
export interface RawItem {
  /** 数据源内稳定 ID（GHSA 编号、CVE 编号、RSS guid 等）；缺省时流水线回退为标题+URL 哈希 */
  externalId?: string;
  title: string;
  summary?: string;
  url?: string;
  author?: string;
  /** ISO 8601 时间；缺失时流水线使用 fetchedAt */
  publishedAt?: string;
  /** 适配器的分类建议，流水线会结合关键词做最终判定 */
  category?: ItemCategory;
  tags?: string[];
  severity?: Severity;
  cveIds?: string[];
  ghsaIds?: string[];
  cvssScore?: number;
  isKev?: boolean;
  vendor?: string;
  lang?: 'zh' | 'en' | 'other';
  /** 原始数据快照（用于排障与二次解析，落库前会裁剪体积） */
  raw?: unknown;
}

/** 单次采集结果。 */
export interface CollectorResult {
  items: RawItem[];
  /** 可选增量游标（如上次最新时间戳），便于后续做增量采集 */
  cursor?: string;
  /** 非致命告警，会记录到运行日志 */
  warnings?: string[];
}

/** 采集器适配器接口。所有适配器必须幂等、可重入、对上游超时与限流有兜底。 */
export interface CollectorAdapter {
  readonly id: AdapterId;
  fetch(ctx: CollectorContext): Promise<CollectorResult>;
}
