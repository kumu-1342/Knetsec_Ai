/**
 * items 表行 → shared ItemDTO 的映射与公共 SQL 片段。
 *
 * 数据库字段是 snake_case、JSON 数组以 TEXT 存储、布尔以 0/1 存储；
 * 前端契约要求 camelCase + 真正的数组/布尔。集中在映射层转换，避免各接口重复实现且口径不一致。
 */
import type { ItemCategory, ItemDTO, Severity } from '@knetsec/shared';

/** items 表原始行（只保留接口需要的列，禁止 SELECT *）。 */
export interface ItemRow {
  id: number;
  uid: string;
  source_key: string;
  source_name: string;
  title: string;
  summary: string | null;
  url: string | null;
  author: string | null;
  published_at: string | null;
  fetched_at: string;
  category: string;
  tags: string;
  severity: string;
  cve_ids: string;
  ghsa_ids: string;
  cvss_score: number | null;
  is_kev: number;
  vendor: string | null;
  lang: string;
  is_read: number;
  is_starred: number;
  importance: number;
}

/** 查询 items 时统一使用的列清单（显式列名，避免 SELECT *）。 */
export const ITEM_COLUMNS =
  'id, uid, source_key, source_name, title, summary, url, author, published_at, fetched_at, category, tags, severity, cve_ids, ghsa_ids, cvss_score, is_kev, vendor, lang, is_read, is_starred, importance';

/** 安全解析 JSON 字符串数组（脏数据回退空数组，绝不抛错）。 */
export function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

/** 行 → DTO。 */
export function mapItemRow(row: ItemRow): ItemDTO {
  return {
    id: row.id,
    uid: row.uid,
    sourceKey: row.source_key,
    sourceName: row.source_name,
    title: row.title,
    summary: row.summary,
    url: row.url,
    author: row.author,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    category: row.category as ItemCategory,
    tags: parseJsonArray(row.tags),
    severity: row.severity as Severity,
    cveIds: parseJsonArray(row.cve_ids),
    ghsaIds: parseJsonArray(row.ghsa_ids),
    cvssScore: row.cvss_score,
    isKev: row.is_kev === 1,
    vendor: row.vendor,
    lang: row.lang,
    isRead: row.is_read === 1,
    isStarred: row.is_starred === 1,
    importance: row.importance,
  };
}
