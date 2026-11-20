/**
 * 流水线（Pipeline）数据契约。
 *
 * 职责划分：
 * - collectors/*：把外部数据变成 RawItem（不做去重/不写库）；
 * - pipeline/normalize.ts：RawItem → NormalizedItem（补默认值、时间规范化、UID 生成、ID 提取）；
 * - pipeline/dedupe.ts：批内去重、跨源相似标题去重；
 * - pipeline/enrich.ts（服务端 core 实现）：CVSS/KEV → severity、AI 安全标签、importance、可选 LLM 摘要；
 * - pipeline/orchestrator.ts：编排上述步骤并落库。
 */
import type { ItemCategory, Severity } from './domain.js';

/** 归一化后的待入库条目（字段与 items 表一一对应）。 */
export interface NormalizedItem {
  /** 去重键：sha256(sourceKey + ':' + externalId) 或 sha256(sourceKey + ':' + 规范化标题) */
  uid: string;
  sourceKey: string;
  sourceName: string;
  title: string;
  summary: string | null;
  url: string | null;
  author: string | null;
  /** ISO 8601，缺失时取 fetchedAt */
  publishedAt: string;
  fetchedAt: string;
  category: ItemCategory;
  tags: string[];
  severity: Severity;
  cveIds: string[];
  ghsaIds: string[];
  cvssScore: number | null;
  isKev: boolean;
  vendor: string | null;
  lang: 'zh' | 'en' | 'other';
  /** 0-100，富化阶段计算 */
  importance: number;
  /** 原始快照 JSON 字符串（≤16KB） */
  raw: string | null;
}

/** 批内去重结果。 */
export interface DedupeResult {
  unique: NormalizedItem[];
  duplicateCount: number;
}

/** 跨源重复判定结果。 */
export interface CrossSourceDuplicate {
  duplicate: boolean;
  /** 命中的库内条目 id，便于日志与运营合并 */
  existingId?: number;
  /** 相似度 0-1 */
  similarity?: number;
}
