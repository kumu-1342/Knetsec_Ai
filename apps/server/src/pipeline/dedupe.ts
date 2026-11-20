/**
 * 去重流水线：批内去重 + 跨源相似标题判定。
 *
 * 业务背景（docs/00 §8.1）：同一个漏洞/事件会被 GitHub Advisory、NVD、CISA KEV、
 * 安全媒体反复报道，如果不去重，报告里会出现同一件事的 5 个版本，运营无法使用。
 *
 * 三层去重：
 * 1. uid 相同：完全相同的外部 ID（同一源重复采集），直接丢弃；
 * 2. CVE / GHSA 编号交集：不同源报道同一个漏洞，编号是最可靠的关联依据；
 * 3. 标题 3-gram Jaccard 相似度 ≥ 0.85 且同一 category：覆盖「媒体转述同一事件、
 *    标题措辞略有差异」的情况（编号缺失时才依赖它）。
 *
 * 为什么用 3-gram Jaccard 而不是编辑距离：编辑距离对语序变化与同义替换不敏感，
 * 且需要 O(n*m) 的动态规划；3-gram 集合运算对短标题（10-20 词）足够且更快。
 * 阈值 0.85 偏保守——宁可漏合并（运营可手工合并）也不能错合并（丢失独立情报）。
 */
import type { DedupeResult, CrossSourceDuplicate } from '@knetsec/shared';
import type { NormalizedItem } from '@knetsec/shared';
import type { Db } from '../infra/db.js';

/**
 * 标题停用词表。
 *
 * 为什么去掉：英文虚词（the/of/for）与中文虚词（的/与/及）在所有标题里高频出现，
 * 会把相似度整体抬高，导致「无关标题被判为相似」；只去掉纯语法词与极高频的
 * 版本/动作词，保留 "vulnerability"、"security" 这类有信息量的领域词。
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // 英文语法词
  'a',
  'an',
  'the',
  'of',
  'for',
  'to',
  'in',
  'on',
  'at',
  'by',
  'with',
  'from',
  'and',
  'or',
  'as',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
  'their',
  'his',
  'her',
  'our',
  'your',
  'we',
  'you',
  'they',
  'he',
  'she',
  'not',
  'no',
  'has',
  'have',
  'had',
  'will',
  'would',
  'can',
  'could',
  'may',
  'might',
  'via',
  'into',
  'over',
  'under',
  'about',
  'after',
  'before',
  // 中文语法词
  '的',
  '了',
  '与',
  '和',
  '及',
  '或',
  '在',
  '是',
  '有',
  '对',
  '将',
  '被',
  '把',
  '从',
  '到',
  '中',
  '上',
  '下',
  '之',
  '其',
  '此',
  '该',
  '等',
  '并',
  '而',
  '也',
  '都',
  '就',
  '要',
  '会',
  '可',
  '为',
]);

/** 3-gram 的分词长度：中文按字切分同样适用，短标题也能得到足够多的 gram。 */
const GRAM_SIZE = 3;

/** 标题判定为「重复」的相似度阈值（docs/00 §8.1）。 */
export const TITLE_SIMILARITY_THRESHOLD = 0.85;

/** 跨源去重的时间窗：发布时间相差 ≤ 3 天。超出窗口的相同标题视为不同事件（周期性公告）。 */
export const CROSS_SOURCE_WINDOW_DAYS = 3;

/** 跨源去重单次扫描的库内条目上限，避免全表扫描拖慢采集。 */
export const CROSS_SOURCE_SCAN_LIMIT = 200;

/**
 * 标题指纹：小写 → 去标点/空白 → 去停用词 → 单空格连接。
 *
 * 为什么不直接用小写标题做相似度：标点与虚词会让「同一事件」的两个标题产生
 * 大量差异 gram，相似度被压低到阈值以下。
 *
 * 该函数是幂等的：对指纹再次调用结果不变，因此 {@link jaccardSimilarity}
 * 可以安全地对「原始标题」和「指纹」两种输入统一处理。
 *
 * @param title 原始标题
 * @returns 规范化后的词序列（空格分隔）
 */
export function titleFingerprint(title: string): string {
  if (typeof title !== 'string' || title.trim().length === 0) return '';

  const words = title
    .normalize('NFKC')
    .toLowerCase()
    // 保留字母、数字与 CJK；其余（标点、引号、括号、连字符）一律视为分隔符
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((word) => word.length > 0 && !STOPWORDS.has(word));

  return words.join(' ');
}

/** 把字符串切成 3-gram 集合；长度不足 3 时退化为整串，避免短标题相似度恒为 0。 */
function buildGramSet(input: string): Set<string> {
  const text = input.replace(/\s+/g, ' ').trim();
  const grams = new Set<string>();
  if (text.length === 0) return grams;
  if (text.length <= GRAM_SIZE) {
    grams.add(text);
    return grams;
  }
  for (let i = 0; i <= text.length - GRAM_SIZE; i += 1) {
    grams.add(text.slice(i, i + GRAM_SIZE));
  }
  return grams;
}

/**
 * 计算两个标题（或指纹）的 3-gram Jaccard 相似度。
 *
 * Jaccard = |A ∩ B| / |A ∪ B|，取值 0-1；完全一致为 1，无公共 gram 为 0。
 * 输入会自动做 {@link titleFingerprint} 规范化，因此传原始标题或已规范化的指纹都可以。
 *
 * @param a 标题 A
 * @param b 标题 B
 * @returns 相似度 0-1
 */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = buildGramSet(titleFingerprint(a));
  const setB = buildGramSet(titleFingerprint(b));
  if (setA.size === 0 || setB.size === 0) return 0;

  // 遍历较小集合求交集，减少比较次数
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let intersection = 0;
  for (const gram of small) {
    if (large.has(gram)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 计算条目的「信息完整度」得分，用于重复合并时决定保留哪一条。
 *
 * 为什么需要：同一条漏洞如果 GitHub 版有 CVSS/CVE、媒体版有长摘要，
 * 保留字段更全的那条对报告与面板更有价值。评分只用于比较，不落库。
 */
function richnessScore(item: NormalizedItem): number {
  let score = 0;
  score += Math.min(item.summary?.length ?? 0, SUMMARY_BONUS_CAP) / 10;
  score += Math.min(item.tags.length, 8) * 3;
  if (item.url) score += 50;
  if (item.cvssScore !== null) score += 40;
  if (item.severity !== 'unknown') score += 20;
  if (item.isKev) score += 30;
  if (item.vendor) score += 10;
  score += Math.min(item.cveIds.length, 5) * 12;
  score += Math.min(item.ghsaIds.length, 5) * 12;
  if (item.author) score += 5;
  return score;
}

/** 摘要长度加分上限，避免超长摘要单方面压过「有 CVE/CVSS」的条目。 */
const SUMMARY_BONUS_CAP = 600;

/** 判断两个条目的编号是否有交集（CVE 或 GHSA 任一即可）。 */
export function hasSharedIds(a: NormalizedItem, b: NormalizedItem): boolean {
  const cveSet = new Set(a.cveIds);
  for (const id of b.cveIds) {
    if (cveSet.has(id)) return true;
  }
  const ghsaSet = new Set(a.ghsaIds);
  for (const id of b.ghsaIds) {
    if (ghsaSet.has(id)) return true;
  }
  return false;
}

/**
 * 批内去重：把同一批采集结果里的重复条目合并为一条。
 *
 * 判定顺序（一旦命中即停止比较，保证 O(n) 级别的常见路径）：
 * 1. uid 相同 → 重复；
 * 2. CVE/GHSA 编号交集 → 重复（不同源同一漏洞）；
 * 3. 同一 category 且标题相似度 ≥ {@link TITLE_SIMILARITY_THRESHOLD} → 重复。
 *
 * 保留策略：命中重复时比较 {@link richnessScore}，保留信息更全的那条，
 * 但**位置保持首次出现的位置**，避免打乱适配器给出的时间/优先级顺序。
 *
 * 为什么相似度判定限制在同一 category：安全论文与新闻稿标题可能高度相似
 * （都含 "LLM prompt injection"），但它们属于不同业务分类，不应互相吞掉。
 *
 * @param items 归一化后的条目（通常来自同一批次、可能跨多个数据源）
 * @returns 去重后的唯一条目与被合并的重复数量
 */
export function dedupeWithinBatch(items: NormalizedItem[]): DedupeResult {
  const unique: NormalizedItem[] = [];
  const fingerprints: string[] = [];
  /** uid → unique 下标 */
  const uidIndex = new Map<string, number>();
  /** CVE/GHSA 编号 → unique 下标 */
  const idIndex = new Map<string, number>();

  let duplicateCount = 0;

  for (const item of items) {
    let target = uidIndex.get(item.uid);

    if (target === undefined) {
      for (const id of [...item.cveIds, ...item.ghsaIds]) {
        const found = idIndex.get(id);
        if (found !== undefined) {
          target = found;
          break;
        }
      }
    }

    if (target === undefined) {
      const fingerprint = titleFingerprint(item.title);
      for (let i = 0; i < unique.length; i += 1) {
        const existing = unique[i];
        if (!existing || existing.category !== item.category) continue;
        if (jaccardSimilarity(fingerprints[i] ?? '', fingerprint) >= TITLE_SIMILARITY_THRESHOLD) {
          target = i;
          break;
        }
      }
    }

    if (target === undefined) {
      const position = unique.length;
      unique.push(item);
      fingerprints.push(titleFingerprint(item.title));
      uidIndex.set(item.uid, position);
      for (const id of [...item.cveIds, ...item.ghsaIds]) idIndex.set(id, position);
      continue;
    }

    // 命中重复：保留信息更全的一条，同时把新条目的编号补进索引
    duplicateCount += 1;
    const existing = unique[target];
    if (existing && richnessScore(item) > richnessScore(existing)) {
      unique[target] = item;
      fingerprints[target] = titleFingerprint(item.title);
    }
    for (const id of [...item.cveIds, ...item.ghsaIds]) {
      if (!idIndex.has(id)) idIndex.set(id, target);
    }
  }

  return { unique, duplicateCount };
}

/** 库内查询返回的行结构（只取判定需要的列，禁止 SELECT *）。 */
interface CrossSourceRow {
  id: number;
  uid: string;
  title: string;
  cve_ids: string;
  ghsa_ids: string;
  published_at: string;
}

/** 安全解析库内 JSON 数组字段（历史数据可能为空串或坏 JSON）。 */
function parseJsonIds(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

/** 把 ISO 时间平移若干天，用于构造跨源查询的时间窗。 */
function shiftDays(isoTime: string, days: number): string {
  const base = new Date(isoTime);
  if (Number.isNaN(base.getTime())) return isoTime;
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * 查找库内是否已存在「同一事件的其他来源条目」。
 *
 * 查询策略（为什么这样写）：
 * - 先按 category + 发布时间窗过滤，能用上 idx_items_category 索引；
 * - 时间窗 ±3 天（docs/00 §8.1），避免把周期性的同标题公告（例如每周例行发布）误判为重复；
 * - LIMIT 200，防止某分类数据量大时把整表读进内存拖慢采集；
 * - 排除 uid 相同的行：那是「自己」，属于 uid 冲突路径而不是跨源重复；
 * - 全部参数化，杜绝注入。
 *
 * 判定顺序：CVE/GHSA 交集（相似度记为 1）→ 标题 Jaccard ≥ 0.85。
 *
 * @param db 数据库封装（infra/db.ts 的 Db）
 * @param item 待判定的归一化条目
 * @returns 是否重复、命中的库内条目 id 与相似度
 */
export function findCrossSourceDuplicate(db: Db, item: NormalizedItem): CrossSourceDuplicate {
  const from = shiftDays(item.publishedAt, -CROSS_SOURCE_WINDOW_DAYS);
  const to = shiftDays(item.publishedAt, CROSS_SOURCE_WINDOW_DAYS);

  let rows: CrossSourceRow[];
  try {
    rows = db.all<CrossSourceRow>(
      [
        'SELECT id, uid, title, cve_ids, ghsa_ids, published_at',
        'FROM items',
        'WHERE category = ?',
        '  AND published_at IS NOT NULL',
        '  AND published_at >= ?',
        '  AND published_at <= ?',
        '  AND uid <> ?',
        'ORDER BY published_at DESC',
        'LIMIT ?',
      ].join(' '),
      [item.category, from, to, item.uid, CROSS_SOURCE_SCAN_LIMIT],
    );
  } catch {
    // 表不存在（首次启动前调用）或 SQL 异常时不影响采集：视为无重复
    return { duplicate: false };
  }

  const ownIds = new Set<string>([...item.cveIds, ...item.ghsaIds]);
  let best: CrossSourceDuplicate = { duplicate: false };
  let bestSimilarity = 0;

  for (const row of rows) {
    if (ownIds.size > 0) {
      const rowIds = [...parseJsonIds(row.cve_ids), ...parseJsonIds(row.ghsa_ids)];
      if (rowIds.some((id) => ownIds.has(id))) {
        // 编号相同即同一漏洞，相似度视为 1（比标题更可信）
        return { duplicate: true, existingId: row.id, similarity: 1 };
      }
    }

    const similarity = jaccardSimilarity(item.title, row.title);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      best = { duplicate: similarity >= TITLE_SIMILARITY_THRESHOLD, existingId: row.id, similarity };
    }
  }

  return best;
}
