/**
 * 富化规则单测（契约 §8.2）：CVSS→severity、KEV 抬升、AI 标签、importance、体积裁剪、LLM 失败降级。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings, type NormalizedItem } from '@knetsec/shared';
import { enrichItem, enrichItemWithLlm, MAX_RAW_BYTES, MAX_SUMMARY_LENGTH } from '../src/pipeline/enrich.js';

/** 构造一条归一化条目，只覆盖需要断言的字段。 */
function makeItem(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  const now = new Date().toISOString();
  return {
    uid: 'uid-test',
    sourceKey: 'test-source',
    sourceName: '测试源',
    title: '默认标题',
    summary: null,
    url: null,
    author: null,
    publishedAt: now,
    fetchedAt: now,
    category: 'news',
    tags: [],
    severity: 'unknown',
    cveIds: [],
    ghsaIds: [],
    cvssScore: null,
    isKev: false,
    vendor: null,
    lang: 'en',
    importance: 0,
    raw: null,
    ...overrides,
  };
}

/** 测试用设置：清空关注词，隔离 importance 的额外加分。 */
function settingsWith(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, watchKeywords: [], ...overrides };
}

const FIXED_NOW = new Date('2026-11-17T08:00:00.000Z');

describe('富化：严重度推导', () => {
  it('CVSS 阈值映射：critical/high/medium/low/info', () => {
    const settings = settingsWith();
    const now = FIXED_NOW;
    expect(enrichItem(makeItem({ cvssScore: 9.8 }), settings, { now }).severity).toBe('critical');
    expect(enrichItem(makeItem({ cvssScore: 7.0 }), settings, { now }).severity).toBe('high');
    expect(enrichItem(makeItem({ cvssScore: 5.5 }), settings, { now }).severity).toBe('medium');
    expect(enrichItem(makeItem({ cvssScore: 2.1 }), settings, { now }).severity).toBe('low');
    expect(enrichItem(makeItem({ cvssScore: 0 }), settings, { now }).severity).toBe('info');
  });

  it('无 CVSS 时沿用适配器建议；KEV 强制至少 high', () => {
    const settings = settingsWith();
    expect(enrichItem(makeItem({ severity: 'low' }), settings, { now: FIXED_NOW }).severity).toBe('low');

    const kev = enrichItem(makeItem({ severity: 'medium', isKev: true }), settings, { now: FIXED_NOW });
    expect(kev.severity).toBe('high');

    // 已经是 critical 的 KEV 条目不应被降级
    const kevCritical = enrichItem(makeItem({ cvssScore: 9.9, isKev: true }), settings, {
      now: FIXED_NOW,
    });
    expect(kevCritical.severity).toBe('critical');
  });
});

describe('富化：AI 安全标签与分类', () => {
  it('命中词典打标签并把 category 提升为 ai-security', () => {
    const settings = settingsWith();
    const enriched = enrichItem(
      makeItem({
        title: 'Prompt injection attack against LLM agent platform',
        summary: 'attackers bypass tool calling restrictions',
        category: 'news',
      }),
      settings,
      { now: FIXED_NOW },
    );
    expect(enriched.tags).toEqual(expect.arrayContaining(['prompt-injection', 'llm-app', 'agent']));
    expect(enriched.category).toBe('ai-security');
    expect(enriched.tags).not.toContain('rag');
  });

  it('原分类为 vuln 时保持 vuln（漏洞应进「漏洞与补丁」章节）', () => {
    const settings = settingsWith();
    const enriched = enrichItem(
      makeItem({ title: 'LLM plugin vulnerability allows prompt injection', category: 'vuln' }),
      settings,
      { now: FIXED_NOW },
    );
    expect(enriched.category).toBe('vuln');
    expect(enriched.tags.length).toBeGreaterThan(0);
  });

  it('管理员自定义 AI 关键词也能命中（打通用标签）', () => {
    const settings = settingsWith({ aiSecurityKeywords: ['自定义风险词'] });
    const enriched = enrichItem(
      makeItem({ title: '突发：自定义风险词出现在供应链报告中', category: 'news' }),
      settings,
      { now: FIXED_NOW },
    );
    expect(enriched.tags).toContain('ai-security');
    expect(enriched.category).toBe('ai-security');
  });
});

describe('富化：importance 打分', () => {
  it('critical + KEV + CVE + 24h 内达到 80 分（无关注词）', () => {
    const settings = settingsWith();
    const enriched = enrichItem(
      makeItem({
        cvssScore: 9.8,
        isKev: true,
        cveIds: ['CVE-2025-1234'],
        publishedAt: FIXED_NOW.toISOString(),
      }),
      settings,
      { now: FIXED_NOW },
    );
    // 40(severity) + 20(KEV) + 10(24h) + 10(CVE) = 80
    expect(enriched.importance).toBe(80);
  });

  it('PoC 表述额外 +5，关注关键词 +15，总分封顶 100', () => {
    const settings = settingsWith({ watchKeywords: ['openai'] });
    const enriched = enrichItem(
      makeItem({
        title: 'OpenAI 相关漏洞已有 PoC 利用代码',
        cvssScore: 9.8,
        isKev: true,
        cveIds: ['CVE-2025-1234'],
        publishedAt: FIXED_NOW.toISOString(),
      }),
      settings,
      { now: FIXED_NOW },
    );
    // 40(severity) + 20(KEV) + 15(关注词) + 10(24h) + 10(CVE) + 5(PoC) = 100
    expect(enriched.importance).toBe(100);
  });

  it('超过 24h 的条目失去时效加分', () => {
    const settings = settingsWith();
    const oldItem = enrichItem(
      makeItem({
        cvssScore: 9.8,
        isKev: true,
        cveIds: ['CVE-2025-1234'],
        publishedAt: new Date(FIXED_NOW.getTime() - 3 * 24 * 3600 * 1000).toISOString(),
      }),
      settings,
      { now: FIXED_NOW },
    );
    // 40(severity) + 20(KEV) + 10(CVE) = 70（无 24h 时效分）
    expect(oldItem.importance).toBe(70);
  });
});

describe('富化：体积裁剪', () => {
  it('summary 截断到 600 字', () => {
    const settings = settingsWith();
    const enriched = enrichItem(makeItem({ summary: 'A'.repeat(900) }), settings, { now: FIXED_NOW });
    expect(enriched.summary?.length).toBe(MAX_SUMMARY_LENGTH);
  });

  it('raw 快照按 16KB 截断', () => {
    const settings = settingsWith();
    const enriched = enrichItem(makeItem({ raw: 'x'.repeat(20_000) }), settings, { now: FIXED_NOW });
    expect(enriched.raw).not.toBeNull();
    const bytes = Buffer.from(enriched.raw ?? '', 'utf8').length;
    expect(bytes).toBeLessThanOrEqual(MAX_RAW_BYTES + 64);
    expect(enriched.raw).toContain('[raw truncated]');
  });
});

describe('富化：LLM 增强失败降级', () => {
  it('未开启 LLM 时不发起请求', async () => {
    const settings = settingsWith({ llmEnabled: false });
    let called = 0;
    const enriched = await enrichItemWithLlm(makeItem({ cvssScore: 9.8 }), settings, {
      now: FIXED_NOW,
      fetchImpl: (async () => {
        called += 1;
        return new Response('{}');
      }) as typeof fetch,
    });
    expect(called).toBe(0);
    expect(enriched.summary).toBeNull();
  });

  it('LLM 请求失败只告警，返回规则富化结果', async () => {
    const settings = settingsWith({ llmEnabled: true, llmApiKey: 'sk-test' });
    const enriched = await enrichItemWithLlm(makeItem({ cvssScore: 9.8, summary: '原始摘要' }), settings, {
      now: FIXED_NOW,
      fetchImpl: (async () => {
        throw new Error('network down');
      }) as typeof fetch,
    });
    expect(enriched.severity).toBe('critical');
    expect(enriched.summary).toBe('原始摘要');
  });

  it('LLM 成功时用返回摘要替换', async () => {
    const settings = settingsWith({ llmEnabled: true, llmApiKey: 'sk-test' });
    const enriched = await enrichItemWithLlm(makeItem({ cvssScore: 9.8 }), settings, {
      now: FIXED_NOW,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: '该漏洞影响面较大，建议立即修复。' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    });
    expect(enriched.summary).toBe('该漏洞影响面较大，建议立即修复。');
  });
});
