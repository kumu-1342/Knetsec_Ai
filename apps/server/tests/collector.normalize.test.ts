/**
 * 归一化纯函数单测。
 *
 * 为什么必须测：uid 决定幂等（重复采集是否产生重复条目）、时间/分类/严重度的兜底
 * 决定脏上游数据会不会把库写坏。这些规则一旦回归，问题会以「数据看起来不对劲」的
 * 形式延迟暴露，因此用单测锁住契约（docs/00 §7.3 / §8）。
 */
import { describe, expect, it } from 'vitest';
import type { RawItem, SourceDescriptor } from '@knetsec/shared';
import {
  cleanSummary,
  computeUid,
  detectLanguage,
  emptyCollectorResult,
  extractIds,
  normalizeRawItem,
  normalizeRawItems,
  normalizeTitleForUid,
  parseIsoDate,
  serializeRawSnapshot,
  SUMMARY_MAX_CHARS,
} from '../src/pipeline/normalize.js';
import { matchAiKeyword, suggestAiCategory } from '../src/collectors/helpers.js';

/** 构造测试用数据源描述。 */
function makeSource(overrides: Partial<SourceDescriptor> = {}): SourceDescriptor {
  return {
    id: 1,
    key: 'test-source',
    name: '测试源',
    category: 'vuln-db',
    adapter: 'rss',
    url: 'https://example.com',
    config: {},
    enabled: true,
    intervalMinutes: 360,
    priority: 10,
    ...overrides,
  };
}

/** 固定基准时间，保证结果可断言。 */
const NOW = new Date('2026-11-17T00:00:00.000Z');

describe('computeUid', () => {
  it('相同源 + 相同 externalId 生成相同 uid（幂等）', () => {
    const a = computeUid('nvd-cve', 'CVE-2024-12345', '任意标题');
    const b = computeUid('nvd-cve', 'CVE-2024-12345', '标题变了也不影响');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('不同源的同一 externalId 生成不同 uid（来源隔离）', () => {
    expect(computeUid('source-a', 'CVE-2024-1', 'X')).not.toBe(computeUid('source-b', 'CVE-2024-1', 'X'));
  });

  it('无 externalId 时按规范化标题生成：大小写/标点/多余空白差异不影响', () => {
    const a = computeUid('rss-source', undefined, 'GitHub Advisory: Prompt Injection!');
    const b = computeUid('rss-source', undefined, '  github advisory — prompt injection  ');
    expect(a).toBe(b);
  });

  it('标题完全不同的条目 uid 不同', () => {
    expect(computeUid('rss-source', undefined, 'OpenSSL 漏洞')).not.toBe(
      computeUid('rss-source', undefined, 'Windows 漏洞'),
    );
  });
});

describe('extractIds', () => {
  it('提取并大写化 CVE / GHSA 编号', () => {
    const result = extractIds('见 cve-2024-12345 与 GHSA-ABCD-EFGH-IJKL，另有 CVE-2023-0001');
    expect(result.cveIds).toEqual(['CVE-2023-0001', 'CVE-2024-12345']);
    expect(result.ghsaIds).toEqual(['GHSA-ABCD-EFGH-IJKL']);
  });

  it('非法编号不误提取', () => {
    const result = extractIds('CVE-2024 GHSA-abc-def CVE-24-1234');
    expect(result.cveIds).toEqual([]);
    expect(result.ghsaIds).toEqual([]);
  });

  it('重复编号只保留一次且结果稳定排序', () => {
    const result = extractIds('CVE-2024-9999 CVE-2024-1111 CVE-2024-9999');
    expect(result.cveIds).toEqual(['CVE-2024-1111', 'CVE-2024-9999']);
  });

  it('空输入不抛错', () => {
    expect(extractIds('')).toEqual({ cveIds: [], ghsaIds: [] });
  });
});

describe('parseIsoDate', () => {
  it('解析 ISO 与 RFC822（RSS pubDate）', () => {
    expect(parseIsoDate('2026-11-01T12:00:00Z')).toBe('2026-11-01T12:00:00.000Z');
    expect(parseIsoDate('Mon, 02 Nov 2026 08:30:00 GMT')).toBe('2026-11-02T08:30:00.000Z');
  });

  it('纯日期按 UTC 零点处理（避免时区把日期推前一天）', () => {
    expect(parseIsoDate('2026-11-01')).toBe('2026-11-01T00:00:00.000Z');
  });

  it('非法值返回 undefined', () => {
    expect(parseIsoDate('not-a-date')).toBeUndefined();
    expect(parseIsoDate(undefined)).toBeUndefined();
    expect(parseIsoDate({})).toBeUndefined();
  });
});

describe('normalizeRawItem', () => {
  it('补默认值：缺失发布时间回退 fetchedAt，severity/category 收敛', () => {
    const raw: RawItem = { title: '示例漏洞' };
    const item = normalizeRawItem(raw, makeSource(), NOW);

    expect(item.fetchedAt).toBe(NOW.toISOString());
    expect(item.publishedAt).toBe(NOW.toISOString());
    expect(item.severity).toBe('unknown');
    // 源类别 vuln-db → 默认分类 vuln
    expect(item.category).toBe('vuln');
    expect(item.importance).toBe(0);
    expect(item.lang).toBe('zh');
  });

  it('非法发布时间与未来时间都回退 fetchedAt', () => {
    expect(normalizeRawItem({ title: 'A', publishedAt: 'garbage' }, makeSource(), NOW).publishedAt).toBe(
      NOW.toISOString(),
    );
    expect(
      normalizeRawItem({ title: 'B', publishedAt: '2030-01-01T00:00:00Z' }, makeSource(), NOW).publishedAt,
    ).toBe(NOW.toISOString());
  });

  it('合法历史时间保留为 ISO', () => {
    const item = normalizeRawItem({ title: 'C', publishedAt: '2026-11-10T08:00:00Z' }, makeSource(), NOW);
    expect(item.publishedAt).toBe('2026-11-10T08:00:00.000Z');
  });

  it('摘要去 HTML、折叠空白并截断到 600 字', () => {
    const longText = '<p>' + 'A'.repeat(800) + '</p>';
    const item = normalizeRawItem({ title: 'D', summary: longText }, makeSource(), NOW);
    expect(item.summary).not.toBeNull();
    expect(item.summary?.includes('<p>')).toBe(false);
    expect((item.summary ?? '').length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });

  it('从标题与摘要中合并 CVE / GHSA 编号并去重', () => {
    const item = normalizeRawItem(
      {
        title: 'CVE-2024-1111 漏洞',
        summary: '同时影响 GHSA-AAAA-BBBB-CCCC，参考 CVE-2024-1111。',
        cveIds: ['CVE-2024-1111', 'CVE-2024-2222'],
        ghsaIds: ['GHSA-AAAA-BBBB-CCCC'],
      },
      makeSource(),
      NOW,
    );
    expect(item.cveIds).toEqual(['CVE-2024-1111', 'CVE-2024-2222']);
    expect(item.ghsaIds).toEqual(['GHSA-AAAA-BBBB-CCCC']);
  });

  it('tags 去重（大小写不敏感）且过滤空值', () => {
    const item = normalizeRawItem({ title: 'E', tags: ['AI', 'ai', '', '  ', 'rag'] }, makeSource(), NOW);
    expect(item.tags).toEqual(['AI', 'rag']);
  });

  it('非法 category / severity / cvss 回退安全值', () => {
    const item = normalizeRawItem(
      { title: 'F', category: 'not-a-category' as never, severity: 'higher' as never, cvssScore: 99 },
      makeSource({ category: 'media' }),
      NOW,
    );
    expect(item.category).toBe('news');
    expect(item.severity).toBe('unknown');
    expect(item.cvssScore).toBeNull();
  });

  it('相对链接与 javascript 伪协议被丢弃', () => {
    expect(normalizeRawItem({ title: 'G', url: '/relative/path' }, makeSource(), NOW).url).toBeNull();
    expect(normalizeRawItem({ title: 'H', url: 'javascript:alert(1)' }, makeSource(), NOW).url).toBeNull();
  });

  it('原始快照序列化后体积受控且仍是合法 JSON', () => {
    const bigRaw = { body: 'x'.repeat(50_000), nested: { list: Array.from({ length: 500 }, (_, i) => i) } };
    const item = normalizeRawItem({ title: 'I', raw: bigRaw }, makeSource(), NOW);
    const snapshot = item.raw ?? '';
    expect(snapshot.length).toBeLessThanOrEqual(16 * 1024);
    expect(() => JSON.parse(snapshot)).not.toThrow();
  });

  it('空标题给出占位符而不是崩溃', () => {
    const item = normalizeRawItem({ title: '   ' }, makeSource(), NOW);
    expect(item.title).toBe('（无标题）');
  });
});

describe('matchAiKeyword（语义边界匹配，防止子串误判）', () => {
  it('短关键词不会误命中普通单词（cuda/ray/mcp 实测踩过的坑）', () => {
    expect(matchAiKeyword('Barracuda ESG zero-day exploited')).toBeUndefined();
    expect(matchAiKeyword('Arraytics WordPress plugin flaw')).toBeUndefined();
    expect(matchAiKeyword('McPherson customer data leak')).toBeUndefined();
  });

  it('独立出现的组件名能命中', () => {
    expect(matchAiKeyword('CUDA toolkit privilege escalation')).toBe('cuda');
    expect(matchAiKeyword('vLLM remote code execution')).toBe('vllm');
    expect(matchAiKeyword('LangChain path traversal')).toBe('langchain');
    expect(matchAiKeyword('model-context-protocol server flaw')).toBe('model-context-protocol');
  });

  it('带连字符/冒号/下划线的写法仍然命中（边界只排除字母数字）', () => {
    expect(matchAiKeyword('cuda: driver bug')).toBe('cuda');
    expect(matchAiKeyword('CUDA-enabled inference server')).toBe('cuda');
  });

  it('空文本不命中', () => {
    expect(matchAiKeyword('')).toBeUndefined();
  });

  it('suggestAiCategory 依命中结果给出分类建议', () => {
    expect(suggestAiCategory('Barracuda ESG zero-day', 'vuln')).toBe('vuln');
    expect(suggestAiCategory('ollama RCE', 'vuln')).toBe('ai-security');
  });
});

describe('辅助函数', () => {
  it('normalizeTitleForUid 处理全角/标点/大小写', () => {
    expect(normalizeTitleForUid('ＡＢＣ：测试（一）')).toBe('abc-测试-一');
  });

  it('detectLanguage 区分中文/英文/其他', () => {
    expect(detectLanguage('中文标题', null)).toBe('zh');
    expect(detectLanguage('English title', null)).toBe('en');
    expect(detectLanguage('12345', null)).toBe('other');
  });

  it('cleanSummary 对空/非字符串返回 null', () => {
    expect(cleanSummary('')).toBeNull();
    expect(cleanSummary(undefined)).toBeNull();
    expect(cleanSummary('<p>ok</p>')).toBe('ok');
  });

  it('serializeRawSnapshot 对 undefined/循环引用安全', () => {
    expect(serializeRawSnapshot(undefined)).toBeNull();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const text = serializeRawSnapshot(circular);
    expect(() => JSON.parse(text ?? '')).not.toThrow();
  });

  it('normalizeRawItems 单条失败不影响整批', () => {
    const raws: RawItem[] = [{ title: '好条目' }, { title: '会失败的条目' }];
    const result = normalizeRawItems(raws, makeSource(), NOW, () => undefined);
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);
  });

  it('emptyCollectorResult 返回空条目 + 告警', () => {
    const result = emptyCollectorResult(['w1']);
    expect(result.items).toEqual([]);
    expect(result.warnings).toEqual(['w1']);
  });
});
