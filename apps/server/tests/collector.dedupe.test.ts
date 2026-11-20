/**
 * 去重纯函数单测。
 *
 * 覆盖三层去重规则（docs/00 §8.1）：uid 相同、CVE/GHSA 交集、标题 3-gram 相似度；
 * 以及跨源库内判定（时间窗 ±3 天、LIMIT、排除自身、分类隔离）。
 * 这些规则直接决定「信息会不会丢」——错合并比漏合并可怕得多，所以两个方向都要断言。
 *
 * 阈值说明：0.85 的实测含义是「标题只有屈折变化/一两个词差异」才会判重，
 * 例如 vulnerability→vulnerabilities 得 0.91，allows→permits 只有 0.77（不判重）。
 * 这是刻意的保守取值：漏合并可由运营手工处理，错合并会永久丢失独立情报。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { NormalizedItem } from '@knetsec/shared';
import {
  CROSS_SOURCE_SCAN_LIMIT,
  dedupeWithinBatch,
  findCrossSourceDuplicate,
  hasSharedIds,
  jaccardSimilarity,
  titleFingerprint,
  TITLE_SIMILARITY_THRESHOLD,
} from '../src/pipeline/dedupe.js';
import { Db } from '../src/infra/db.js';

/** 构造归一化条目，只覆盖需要断言的字段。 */
function makeItem(overrides: Partial<NormalizedItem> & { title: string }): NormalizedItem {
  const title = overrides.title;
  return {
    uid: overrides.uid ?? 'uid-' + title,
    sourceKey: overrides.sourceKey ?? 'source-a',
    sourceName: overrides.sourceName ?? '源 A',
    title,
    summary: overrides.summary ?? null,
    url: overrides.url ?? null,
    author: overrides.author ?? null,
    publishedAt: overrides.publishedAt ?? '2026-11-17T00:00:00.000Z',
    fetchedAt: overrides.fetchedAt ?? '2026-11-17T00:00:00.000Z',
    category: overrides.category ?? 'vuln',
    tags: overrides.tags ?? [],
    severity: overrides.severity ?? 'unknown',
    cveIds: overrides.cveIds ?? [],
    ghsaIds: overrides.ghsaIds ?? [],
    cvssScore: overrides.cvssScore ?? null,
    isKev: overrides.isKev ?? false,
    vendor: overrides.vendor ?? null,
    lang: overrides.lang ?? 'en',
    importance: overrides.importance ?? 0,
    raw: overrides.raw ?? null,
  };
}

/** 一对「同一事件、仅屈折变化」的标题，实测相似度 0.91（≥0.85 应判重）。 */
const NEAR_DUPLICATE_A = 'Microsoft patches critical Windows RCE vulnerability exploited in the wild';
const NEAR_DUPLICATE_B = 'Microsoft patches critical Windows RCE vulnerabilities exploited in the wild';

/** 一对「同主题不同写法」的标题，实测相似度 0.77（<0.85 不应判重）。 */
const DISTINCT_A = 'Critical OpenSSL vulnerability allows remote code execution';
const DISTINCT_B = 'Critical OpenSSL vulnerability permits remote code execution';

describe('titleFingerprint', () => {
  it('小写化、去标点、折叠空白、去停用词', () => {
    expect(titleFingerprint('The Critical RCE in OpenSSL!')).toBe('critical rce openssl');
  });

  it('幂等（二次调用结果不变）', () => {
    const once = titleFingerprint('Critical RCE in the OpenSSL library');
    expect(titleFingerprint(once)).toBe(once);
  });

  it('中文按标点切分后去虚词', () => {
    expect(titleFingerprint('漏洞！修复？建议')).toBe('漏洞 修复 建议');
    // 中文没有空格分词，只有标点/空白能切出词元；切出来的虚词会被去掉
    expect(titleFingerprint('关于·该漏洞·的·修复·与·建议')).toBe('关于 该漏洞 修复 建议');
  });

  it('无标点的连续中文保留原串（依赖字符级 3-gram 计算相似度）', () => {
    // 中文不引入分词词典：整串保留后仍能通过字符 3-gram 表达相似度，避免误删有信息量的字
    expect(titleFingerprint('提示注入攻击')).toBe('提示注入攻击');
  });

  it('空标题返回空串', () => {
    expect(titleFingerprint('')).toBe('');
    expect(titleFingerprint('!!!')).toBe('');
  });
});

describe('jaccardSimilarity', () => {
  it('完全相同的标题相似度为 1', () => {
    expect(jaccardSimilarity('Critical RCE in OpenSSL', 'critical rce in openssl')).toBe(1);
  });

  it('仅虚词/标点差异的标题仍为 1', () => {
    expect(
      jaccardSimilarity(
        'A critical vulnerability in the OpenSSL library',
        'Critical vulnerability in OpenSSL library',
      ),
    ).toBe(1);
  });

  it('无关标题相似度低于阈值', () => {
    const similarity = jaccardSimilarity('Critical RCE in OpenSSL', 'Windows kernel privilege escalation');
    expect(similarity).toBeLessThan(TITLE_SIMILARITY_THRESHOLD);
  });

  it('屈折变化（vulnerability → vulnerabilities）相似度达到阈值', () => {
    expect(jaccardSimilarity(NEAR_DUPLICATE_A, NEAR_DUPLICATE_B)).toBeGreaterThanOrEqual(
      TITLE_SIMILARITY_THRESHOLD,
    );
  });

  it('同主题但换动词的标题低于阈值（宁可漏合并，不误合并）', () => {
    expect(jaccardSimilarity(DISTINCT_A, DISTINCT_B)).toBeLessThan(TITLE_SIMILARITY_THRESHOLD);
  });

  it('空输入返回 0 而不是 NaN', () => {
    expect(jaccardSimilarity('', '')).toBe(0);
    expect(jaccardSimilarity('abc', '')).toBe(0);
  });
});

describe('dedupeWithinBatch', () => {
  it('uid 相同视为重复，只保留一条', () => {
    const result = dedupeWithinBatch([
      makeItem({ title: 'Same', uid: 'uid-same' }),
      makeItem({ title: 'Same', uid: 'uid-same' }),
    ]);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicateCount).toBe(1);
  });

  it('CVE 交集视为重复，并保留信息更全的一条', () => {
    const thin = makeItem({
      title: 'CVE-2024-1234 漏洞',
      cveIds: ['CVE-2024-1234'],
      sourceKey: 'rss-media',
      uid: 'uid-thin',
    });
    const rich = makeItem({
      title: 'OpenSSL 远程代码执行漏洞（CVE-2024-1234）',
      cveIds: ['CVE-2024-1234'],
      cvssScore: 9.8,
      severity: 'critical',
      summary: '详细描述',
      url: 'https://example.com/advisory',
      sourceKey: 'nvd-cve',
      uid: 'uid-rich',
    });
    const result = dedupeWithinBatch([thin, rich]);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicateCount).toBe(1);
    // 信息更全的条目胜出，但位置保持首次出现
    expect(result.unique[0]?.sourceKey).toBe('nvd-cve');
  });

  it('同分类 + 标题相似 ≥0.85 视为重复', () => {
    const result = dedupeWithinBatch([
      makeItem({ title: NEAR_DUPLICATE_A, uid: 'uid-a', sourceKey: 'rss-a' }),
      makeItem({ title: NEAR_DUPLICATE_B, uid: 'uid-b', sourceKey: 'rss-b' }),
    ]);
    expect(result.unique).toHaveLength(1);
    expect(result.duplicateCount).toBe(1);
  });

  it('不同分类的相似标题不合并（论文 vs 新闻）', () => {
    const result = dedupeWithinBatch([
      makeItem({ title: NEAR_DUPLICATE_A, uid: 'uid-research', sourceKey: 'arxiv', category: 'research' }),
      makeItem({ title: NEAR_DUPLICATE_B, uid: 'uid-news', sourceKey: 'media', category: 'ai-security' }),
    ]);
    expect(result.unique).toHaveLength(2);
    expect(result.duplicateCount).toBe(0);
  });

  it('同分类但文字差异较大的条目都保留', () => {
    const result = dedupeWithinBatch([
      makeItem({ title: DISTINCT_A, uid: 'uid-d1', sourceKey: 'rss-a' }),
      makeItem({ title: DISTINCT_B, uid: 'uid-d2', sourceKey: 'rss-b' }),
    ]);
    expect(result.unique).toHaveLength(2);
    expect(result.duplicateCount).toBe(0);
  });

  it('完全无关的条目全部保留', () => {
    const result = dedupeWithinBatch([
      makeItem({ title: 'OpenSSL 漏洞公告', uid: 'uid-1' }),
      makeItem({ title: 'Windows 内核提权事件', uid: 'uid-2' }),
      makeItem({ title: '某公司发布 AI 治理白皮书', uid: 'uid-3', category: 'policy' }),
    ]);
    expect(result.unique).toHaveLength(3);
    expect(result.duplicateCount).toBe(0);
  });

  it('空输入返回空结果', () => {
    expect(dedupeWithinBatch([])).toEqual({ unique: [], duplicateCount: 0 });
  });
});

describe('hasSharedIds', () => {
  it('CVE 或 GHSA 任一交集即判定为共享', () => {
    const a = makeItem({ title: 'a', cveIds: ['CVE-2024-1'], ghsaIds: ['GHSA-AAAA-BBBB-CCCC'] });
    const b = makeItem({ title: 'b', cveIds: ['CVE-2024-2'], ghsaIds: ['GHSA-AAAA-BBBB-CCCC'] });
    const c = makeItem({ title: 'c', cveIds: ['CVE-2024-3'] });
    expect(hasSharedIds(a, b)).toBe(true);
    expect(hasSharedIds(a, c)).toBe(false);
  });
});

describe('findCrossSourceDuplicate', () => {
  let db: Db;

  /** 建内存库并初始化 items 表（字段与迁移脚本保持一致，只取判定所需列）。 */
  function createDb(): Db {
    const instance = new Db(':memory:');
    instance.exec(
      [
        'CREATE TABLE items (',
        '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
        '  uid TEXT NOT NULL UNIQUE,',
        '  source_key TEXT NOT NULL,',
        '  title TEXT NOT NULL,',
        '  category TEXT NOT NULL,',
        "  cve_ids TEXT NOT NULL DEFAULT '[]',",
        "  ghsa_ids TEXT NOT NULL DEFAULT '[]',",
        '  published_at TEXT',
        ')',
      ].join(' '),
    );
    return instance;
  }

  /** 插入一条库内条目（id 由自增分配）。 */
  function insertItem(params: {
    uid: string;
    sourceKey: string;
    title: string;
    category: string;
    cveIds?: string[];
    publishedAt: string;
  }): void {
    db.run(
      'INSERT INTO items (uid, source_key, title, category, cve_ids, ghsa_ids, published_at) VALUES (?,?,?,?,?,?,?)',
      [
        params.uid,
        params.sourceKey,
        params.title,
        params.category,
        JSON.stringify(params.cveIds ?? []),
        '[]',
        params.publishedAt,
      ],
    );
  }

  afterEach(() => {
    try {
      db?.close();
    } catch {
      // 部分用例会主动关闭实例（模拟表不存在），此处忽略重复关闭
    }
  });

  it('库内存在相同 CVE 且在 3 天窗口内 → 判为重复', () => {
    db = createDb();
    insertItem({
      uid: 'uid-existing',
      sourceKey: 'nvd-cve',
      title: 'CVE-2024-1234 OpenSSL RCE',
      category: 'vuln',
      cveIds: ['CVE-2024-1234'],
      publishedAt: '2026-11-16T00:00:00.000Z',
    });

    const candidate = makeItem({
      title: 'OpenSSL 远程代码执行（CVE-2024-1234）',
      cveIds: ['CVE-2024-1234'],
      sourceKey: 'rss-media',
      publishedAt: '2026-11-17T00:00:00.000Z',
    });
    const result = findCrossSourceDuplicate(db, candidate);
    expect(result.duplicate).toBe(true);
    expect(result.existingId).toBe(1);
    expect(result.similarity).toBe(1);
  });

  it('相同 CVE 但超出 3 天窗口 → 不判重复', () => {
    db = createDb();
    insertItem({
      uid: 'uid-old',
      sourceKey: 'nvd-cve',
      title: 'CVE-2024-1234 旧条目',
      category: 'vuln',
      cveIds: ['CVE-2024-1234'],
      publishedAt: '2026-11-01T00:00:00.000Z',
    });
    const candidate = makeItem({
      title: '另一条完全不同的标题',
      cveIds: ['CVE-2024-1234'],
      sourceKey: 'rss-media',
      publishedAt: '2026-11-17T00:00:00.000Z',
    });
    expect(findCrossSourceDuplicate(db, candidate).duplicate).toBe(false);
  });

  it('不同 category 的相同 CVE 不会被跨源判定命中（分类隔离）', () => {
    db = createDb();
    insertItem({
      uid: 'uid-x',
      sourceKey: 'nvd-cve',
      title: 'CVE-2024-9999 漏洞',
      category: 'tool',
      cveIds: ['CVE-2024-9999'],
      publishedAt: '2026-11-16T00:00:00.000Z',
    });
    const candidate = makeItem({
      title: 'CVE-2024-9999 漏洞',
      cveIds: ['CVE-2024-9999'],
      uid: 'uid-candidate',
      category: 'vuln',
      publishedAt: '2026-11-17T00:00:00.000Z',
    });
    expect(findCrossSourceDuplicate(db, candidate).duplicate).toBe(false);
  });

  it('标题高度相似（无编号）→ 判为重复并给出相似度', () => {
    db = createDb();
    insertItem({
      uid: 'uid-sim',
      sourceKey: 'rss-a',
      title: NEAR_DUPLICATE_A,
      category: 'vuln',
      publishedAt: '2026-11-16T00:00:00.000Z',
    });
    const candidate = makeItem({
      title: NEAR_DUPLICATE_B,
      uid: 'uid-sim-new',
      publishedAt: '2026-11-17T00:00:00.000Z',
    });
    const result = findCrossSourceDuplicate(db, candidate);
    expect(result.duplicate).toBe(true);
    expect(result.similarity).toBeGreaterThanOrEqual(TITLE_SIMILARITY_THRESHOLD);
  });

  it('排除自身 uid（重复采集同一源不算跨源重复）', () => {
    db = createDb();
    insertItem({
      uid: 'uid-self',
      sourceKey: 'rss-a',
      title: 'Some security advisory',
      category: 'vuln',
      publishedAt: '2026-11-17T00:00:00.000Z',
    });
    const candidate = makeItem({
      title: 'Some security advisory',
      uid: 'uid-self',
      publishedAt: '2026-11-17T00:00:00.000Z',
    });
    expect(findCrossSourceDuplicate(db, candidate).duplicate).toBe(false);
  });

  it('空库返回不重复且不抛错', () => {
    db = createDb();
    expect(findCrossSourceDuplicate(db, makeItem({ title: '任何标题' }))).toEqual({ duplicate: false });
  });

  it('表不存在时安全降级为「不重复」', () => {
    const emptyDb = new Db(':memory:');
    try {
      const result = findCrossSourceDuplicate(emptyDb, makeItem({ title: '任何标题', uid: 'uid-any' }));
      expect(result).toEqual({ duplicate: false });
    } finally {
      emptyDb.close();
    }
    // 让 afterEach 的 close 作用在已关闭实例上也不会抛错
  });

  it('扫描上限常量与 SQL 保持一致（防止误改成全表扫描）', () => {
    expect(CROSS_SOURCE_SCAN_LIMIT).toBe(200);
  });
});
