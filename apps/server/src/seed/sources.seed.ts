/**
 * 默认数据源种子清单。
 *
 * 为什么由采集器模块提供而不是 seed/index.ts 硬编码：数据源清单与适配器是一体两面
 * （每新增一个适配器就要登记源），放在同一目录能保证「代码与数据同步演进」；
 * backend 的 ensureSeedData 只负责把这里的声明写入 sources 表（幂等 upsert）。
 *
 * enabled 的判定依据是 2026-11-17 在本机实测（Node fetch，与线上 HttpClient 同一路径）：
 * - 200 且内容可用 → enabled: true；
 * - 403/404/网络失败/返回验证页 → enabled: false，并在 docs/04 记录原因与开启方法（代理/Token）。
 * 停用的源**保留登记**，管理员可在面板里改配置后一键启用，不需要改代码。
 *
 * 新增源步骤（docs/04 §6）：写适配器（如需）→ 在 collectors/index.ts 注册 →
 * 在这里追加一条 → 跑 LIVE 实测确认可达 → 更新 docs/04 的实测结果表。
 */
import type { AdapterId, SourceCategory } from '@knetsec/shared';

/** 数据源种子条目：字段与 sources 表一一对应（config 以 JSON 落库）。 */
export interface SeedSource {
  /** 稳定唯一键（报告与前端引用，创建后不要改） */
  key: string;
  /** 中文展示名 */
  name: string;
  /** 数据源类别（决定面板分组与默认分类映射） */
  category: SourceCategory;
  /** 采集适配器 */
  adapter: AdapterId;
  /** 入口地址（排障用；部分适配器从 config.url 取地址） */
  url?: string;
  /** 适配器私有配置 */
  config: Record<string, unknown>;
  /** 是否启用（false = 登记但默认不采集） */
  enabled: boolean;
  /** 采集间隔（分钟） */
  intervalMinutes: number;
  /** 优先级（数值越小越优先，报告排序与并发排队用） */
  priority: number;
}

/**
 * 内置默认数据源。
 *
 * 覆盖 docs/00 §7.1 清单的 5 大类：GitHub / 漏洞库 / 厂商公告 / 研究机构 / 安全媒体，
 * 并补充了若干实测可达的 AI 安全垂直来源。共 32 条，其中启用 24 条。
 */
export const DEFAULT_SOURCES: SeedSource[] = [
  // ---------------------------------------------------------------------------
  // 漏洞库 / 权威数据（最高优先级：KEV 在野利用 → NVD → GHSA）
  // ---------------------------------------------------------------------------
  {
    key: 'cisa-kev',
    name: 'CISA 已知被利用漏洞',
    category: 'vuln-db',
    adapter: 'cisa_kev',
    url: 'https://www.cisa.gov/known-exploited-vulnerabilities-catalog',
    config: { days: 30, maxItems: 200, ransomwareOnly: false },
    enabled: true,
    intervalMinutes: 180,
    priority: 5,
  },
  {
    key: 'github-ghsa',
    name: 'GitHub 安全公告库（GHSA）',
    category: 'github',
    adapter: 'github_advisories',
    url: 'https://github.com/advisories',
    config: { perPage: 50, severities: ['critical', 'high'], days: 30 },
    enabled: true,
    intervalMinutes: 180,
    priority: 10,
  },
  {
    key: 'github-ghsa-ai',
    name: 'GitHub 安全公告 · AI 生态（pip/npm）',
    category: 'github',
    adapter: 'github_advisories',
    url: 'https://github.com/advisories',
    // 只保留 pip/npm 生态，用于 AI/ML 供应链专项监控（噪音更少）。
    // 注意：ecosystems 走 GitHub 的 ecosystem 参数（每生态 1 次请求），此模式下不再传
    // published 参数（实测二者同时使用会返回 0 条），改由适配器本地按 days 过滤。
    config: { perPage: 100, severities: ['critical', 'high'], days: 30, ecosystems: ['pip', 'npm'] },
    enabled: true,
    intervalMinutes: 360,
    priority: 12,
  },
  {
    key: 'nvd-ai',
    name: 'NVD · AI/LLM 相关 CVE',
    category: 'vuln-db',
    adapter: 'nvd_cve',
    url: 'https://nvd.nist.gov/vuln/search',
    // NVD 未认证限流 5 次/30 秒：5 个关键词 = 约 30 秒，因此间隔放到 12 小时
    config: {
      keywords: ['large language model', 'prompt injection', 'llm', 'ai agent', 'model context protocol'],
      days: 7,
      minCvss: 0,
      resultsPerPage: 100,
    },
    enabled: true,
    intervalMinutes: 720,
    priority: 15,
  },
  {
    key: 'nvd-recent',
    name: 'NVD · 近期高危 CVE',
    category: 'vuln-db',
    adapter: 'nvd_cve',
    url: 'https://nvd.nist.gov/vuln/search',
    // 只要 CVSS ≥ 7 的近期漏洞，减少低价值条目
    config: { days: 7, minCvss: 7, resultsPerPage: 100 },
    enabled: true,
    intervalMinutes: 720,
    priority: 20,
  },
  {
    key: 'msrc',
    name: '微软 MSRC 安全公告',
    category: 'vendor',
    adapter: 'msrc_cvrf',
    url: 'https://api.msrc.microsoft.com/cvrf/v3.0/updates',
    config: { maxDocuments: 8, includeSeverities: ['Critical', 'Important'] },
    enabled: true,
    intervalMinutes: 720,
    priority: 25,
  },

  // ---------------------------------------------------------------------------
  // GitHub 生态（项目发现 / 重点 AI 项目发布）
  // ---------------------------------------------------------------------------
  {
    key: 'github-ai-security-projects',
    name: 'GitHub · AI 安全项目',
    category: 'github',
    adapter: 'github_search',
    url: 'https://github.com/topics/ai-security',
    config: { query: 'topic:ai-security stars:>50', sort: 'updated', perPage: 20 },
    enabled: true,
    intervalMinutes: 720,
    priority: 60,
  },
  {
    key: 'github-llm-security-projects',
    name: 'GitHub · LLM 安全项目',
    category: 'github',
    adapter: 'github_search',
    url: 'https://github.com/topics/llm-security',
    config: { query: 'topic:llm-security stars:>20', sort: 'updated', perPage: 20 },
    enabled: true,
    intervalMinutes: 720,
    priority: 62,
  },
  {
    key: 'github-releases',
    name: 'GitHub · 重点 AI 项目发布',
    category: 'github',
    adapter: 'github_releases',
    url: 'https://github.com/vllm-project/vllm/releases',
    config: {
      repos: [
        'vllm-project/vllm',
        'langchain-ai/langchain',
        'ollama/ollama',
        'promptfoo/promptfoo',
        'BerriAI/litellm',
      ],
      perRepo: 5,
    },
    enabled: true,
    intervalMinutes: 360,
    priority: 50,
  },

  // ---------------------------------------------------------------------------
  // 研究机构（arXiv + 安全研究博客）
  // ---------------------------------------------------------------------------
  {
    key: 'arxiv-cr',
    name: 'arXiv · cs.CR 密码学与安全',
    category: 'research',
    adapter: 'arxiv',
    url: 'https://arxiv.org/list/cs.CR/recent',
    // arXiv 官方要求 3 秒/次，本适配器单次只发 1 个请求
    config: { categories: ['cs.CR'], keywords: [], maxResults: 30 },
    enabled: true,
    intervalMinutes: 720,
    priority: 30,
  },
  {
    key: 'arxiv-ai',
    name: 'arXiv · AI 安全交叉（cs.CR × cs.AI）',
    category: 'research',
    adapter: 'arxiv',
    url: 'https://arxiv.org/list/cs.AI/recent',
    config: {
      categories: ['cs.CR'],
      keywords: ['llm security', 'prompt injection', 'jailbreak'],
      maxResults: 20,
    },
    enabled: true,
    intervalMinutes: 1440,
    priority: 32,
  },
  {
    key: 'project-zero',
    name: 'Google Project Zero',
    category: 'research',
    adapter: 'rss',
    url: 'https://googleprojectzero.blogspot.com/',
    config: { url: 'https://googleprojectzero.blogspot.com/feeds/posts/default', maxItems: 20, keepDays: 60 },
    enabled: false,
    intervalMinutes: 1440,
    priority: 34,
  },
  {
    key: 'trailofbits',
    name: 'Trail of Bits 博客',
    category: 'research',
    adapter: 'rss',
    url: 'https://blog.trailofbits.com/',
    config: { url: 'https://blog.trailofbits.com/feed/', maxItems: 20, keepDays: 60, category: 'research' },
    enabled: true,
    intervalMinutes: 720,
    priority: 36,
  },
  {
    key: 'unit42',
    name: 'Palo Alto Unit 42',
    category: 'vendor',
    adapter: 'rss',
    url: 'https://unit42.paloaltonetworks.com/',
    config: {
      url: 'https://unit42.paloaltonetworks.com/feed/',
      maxItems: 20,
      keepDays: 60,
      category: 'cyber',
    },
    enabled: true,
    intervalMinutes: 720,
    priority: 38,
  },
  {
    key: 'nist-news',
    name: 'NIST 新闻与公告',
    category: 'research',
    adapter: 'rss',
    url: 'https://www.nist.gov/news-events/news',
    config: {
      url: 'https://www.nist.gov/news-events/news/rss.xml',
      maxItems: 20,
      keepDays: 90,
      category: 'policy',
    },
    enabled: true,
    intervalMinutes: 1440,
    priority: 40,
  },

  // ---------------------------------------------------------------------------
  // 厂商公告与安全博客
  // ---------------------------------------------------------------------------
  {
    key: 'cisco',
    name: 'Cisco PSIRT 安全公告',
    category: 'vendor',
    adapter: 'rss',
    url: 'https://tools.cisco.com/security/center/publicationListing.x',
    config: {
      url: 'https://tools.cisco.com/security/center/rss.x?i=44',
      maxItems: 30,
      keepDays: 60,
      category: 'vuln',
    },
    enabled: true,
    intervalMinutes: 360,
    priority: 35,
  },
  {
    key: 'microsoft-security',
    name: '微软安全博客',
    category: 'vendor',
    adapter: 'rss',
    url: 'https://www.microsoft.com/en-us/security/blog/',
    config: { url: 'https://www.microsoft.com/en-us/security/blog/feed/', maxItems: 20, keepDays: 60 },
    enabled: true,
    intervalMinutes: 720,
    priority: 42,
  },
  {
    key: 'msrc-blog',
    name: '微软 MSRC 博客',
    category: 'vendor',
    adapter: 'rss',
    url: 'https://msrc.microsoft.com/blog/',
    config: { url: 'https://msrc.microsoft.com/blog/feed/', maxItems: 20, keepDays: 60, category: 'vuln' },
    enabled: true,
    intervalMinutes: 720,
    priority: 44,
  },
  {
    key: 'aws-security',
    name: 'AWS 安全公告',
    category: 'vendor',
    adapter: 'rss',
    url: 'https://aws.amazon.com/security/security-bulletins/',
    config: {
      url: 'https://aws.amazon.com/security/security-bulletins/rss/feed/',
      maxItems: 20,
      keepDays: 60,
      category: 'vuln',
    },
    enabled: true,
    intervalMinutes: 720,
    priority: 46,
  },
  {
    key: 'fortinet',
    name: 'Fortinet PSIRT',
    category: 'vendor',
    adapter: 'rss',
    url: 'https://www.fortiguard.com/psirt',
    config: { url: 'https://www.fortiguard.com/rss/irc_feed', maxItems: 20, keepDays: 60, category: 'vuln' },
    // 实测 404：官方已下线该 RSS，保留登记等适配器支持 JSON 接口后再启用
    enabled: false,
    intervalMinutes: 720,
    priority: 48,
  },
  {
    key: 'cloudflare-blog',
    name: 'Cloudflare 安全博客',
    category: 'vendor',
    adapter: 'rss',
    url: 'https://blog.cloudflare.com/tag/security/',
    config: { url: 'https://blog.cloudflare.com/tag/security/rss/', maxItems: 20, keepDays: 60 },
    enabled: true,
    intervalMinutes: 720,
    priority: 52,
  },
  {
    key: 'securelist',
    name: 'Kaspersky Securelist',
    category: 'vendor',
    adapter: 'rss',
    url: 'https://securelist.com/',
    config: { url: 'https://securelist.com/feed/', maxItems: 20, keepDays: 60, category: 'cyber' },
    enabled: true,
    intervalMinutes: 720,
    priority: 54,
  },

  // ---------------------------------------------------------------------------
  // AI 垂直来源（OpenAI / Anthropic / HuggingFace / 安全研究员个人博客）
  // ---------------------------------------------------------------------------
  {
    key: 'openai',
    name: 'OpenAI 官方动态',
    category: 'community',
    adapter: 'rss',
    url: 'https://openai.com/news/',
    config: { url: 'https://openai.com/news/rss.xml', maxItems: 15, keepDays: 60, category: 'ai-security' },
    enabled: true,
    intervalMinutes: 720,
    priority: 55,
  },
  {
    key: 'anthropic',
    name: 'Anthropic 官方动态',
    category: 'community',
    adapter: 'rss',
    url: 'https://www.anthropic.com/news',
    config: {
      url: 'https://www.anthropic.com/news/rss.xml',
      maxItems: 15,
      keepDays: 60,
      category: 'ai-security',
    },
    // 实测：该 RSS 路径不存在（fetch failed），保留登记，待官方提供订阅地址后启用
    enabled: false,
    intervalMinutes: 720,
    priority: 56,
  },
  {
    key: 'hf-blog',
    name: 'Hugging Face 博客',
    category: 'community',
    adapter: 'rss',
    url: 'https://huggingface.co/blog',
    config: {
      url: 'https://huggingface.co/blog/feed.xml',
      maxItems: 20,
      keepDays: 60,
      category: 'ai-security',
    },
    // 实测：网络不可达（fetch failed，疑地域限制），可配置 KNETSEC_HTTP_PROXY 后启用
    enabled: false,
    intervalMinutes: 720,
    priority: 58,
  },
  {
    key: 'embracethered',
    name: 'Embrace The Red（AI 安全研究）',
    category: 'community',
    adapter: 'rss',
    url: 'https://embracethered.com/blog/',
    config: {
      url: 'https://embracethered.com/blog/index.xml',
      maxItems: 20,
      keepDays: 90,
      category: 'ai-security',
    },
    enabled: true,
    intervalMinutes: 1440,
    priority: 45,
  },
  {
    key: 'simonwillison',
    name: 'Simon Willison（AI 安全观察）',
    category: 'community',
    adapter: 'rss',
    url: 'https://simonwillison.net/',
    config: {
      url: 'https://simonwillison.net/atom/everything/',
      maxItems: 20,
      keepDays: 30,
      category: 'ai-security',
    },
    enabled: true,
    intervalMinutes: 720,
    priority: 47,
  },
  {
    key: 'schneier',
    name: 'Schneier on Security',
    category: 'community',
    adapter: 'rss',
    url: 'https://www.schneier.com/',
    config: { url: 'https://www.schneier.com/feed/atom/', maxItems: 20, keepDays: 60, category: 'policy' },
    enabled: true,
    intervalMinutes: 1440,
    priority: 90,
  },

  // ---------------------------------------------------------------------------
  // 安全媒体
  // ---------------------------------------------------------------------------
  {
    key: 'github-blog',
    name: 'GitHub Security Blog',
    category: 'media',
    adapter: 'rss',
    url: 'https://github.blog/category/security/',
    config: { url: 'https://github.blog/category/security/feed/', maxItems: 20, keepDays: 60 },
    enabled: true,
    intervalMinutes: 360,
    priority: 65,
  },
  {
    key: 'darkreading',
    name: 'Dark Reading',
    category: 'media',
    adapter: 'rss',
    url: 'https://www.darkreading.com/',
    config: { url: 'https://www.darkreading.com/rss.xml', maxItems: 20, keepDays: 30, category: 'cyber' },
    enabled: true,
    intervalMinutes: 360,
    priority: 80,
  },
  {
    key: 'cybernews',
    name: 'Cyber Security News',
    category: 'media',
    adapter: 'rss',
    url: 'https://www.cybersecuritynews.com/',
    config: { url: 'https://www.cybersecuritynews.com/feed/', maxItems: 20, keepDays: 30, category: 'cyber' },
    enabled: true,
    intervalMinutes: 360,
    priority: 82,
  },
  {
    key: 'exploit-db',
    name: 'Exploit-DB 公开 PoC 列表',
    category: 'media',
    adapter: 'rss',
    url: 'https://www.exploit-db.com/',
    config: { url: 'https://www.exploit-db.com/rss.xml', maxItems: 20, keepDays: 30, category: 'vuln' },
    // 只保留「有公开 PoC」的信號，报告中用于标记「已有 PoC」；不存储利用代码本体
    enabled: true,
    intervalMinutes: 360,
    priority: 70,
  },
  {
    key: 'freebuf',
    name: 'FreeBuf 安全资讯',
    category: 'media',
    adapter: 'rss',
    url: 'https://www.freebuf.com/',
    config: { url: 'https://www.freebuf.com/feed', maxItems: 20, keepDays: 30, category: 'cyber' },
    enabled: true,
    intervalMinutes: 360,
    priority: 84,
  },
  {
    key: 'thehackernews',
    name: 'The Hacker News',
    category: 'media',
    adapter: 'rss',
    url: 'https://thehackernews.com/',
    config: {
      url: 'https://thehackernews.com/feeds/posts/default',
      maxItems: 20,
      keepDays: 30,
      category: 'cyber',
    },
    // 实测：feedburner 与自有 feed 均 fetch failed（网络不可达），可配置代理后启用
    enabled: false,
    intervalMinutes: 360,
    priority: 86,
  },
  {
    key: 'securityweek',
    name: 'SecurityWeek',
    category: 'media',
    adapter: 'rss',
    url: 'https://www.securityweek.com/',
    config: { url: 'https://www.securityweek.com/feed/', maxItems: 20, keepDays: 30, category: 'cyber' },
    // 实测 403：站点对非浏览器 UA 有反爬，需代理/浏览器 UA 方案，暂不启用
    enabled: false,
    intervalMinutes: 360,
    priority: 88,
  },
  {
    key: 'bleepingcomputer',
    name: 'BleepingComputer',
    category: 'media',
    adapter: 'rss',
    url: 'https://www.bleepingcomputer.com/',
    config: { url: 'https://www.bleepingcomputer.com/feed/', maxItems: 20, keepDays: 30, category: 'cyber' },
    // 实测 403（docs/00 §13 已记录），保留登记便于将来用代理启用
    enabled: false,
    intervalMinutes: 360,
    priority: 89,
  },

  // ---------------------------------------------------------------------------
  // 国内漏洞库（实测不可达，登记但停用；代理开启方法见 docs/04 §7）
  // ---------------------------------------------------------------------------
  {
    key: 'cnvd',
    name: '国家信息安全漏洞共享平台（CNVD）',
    category: 'vuln-db',
    adapter: 'html_list',
    url: 'https://www.cnvd.org.cn/flaw/list',
    config: {
      url: 'https://www.cnvd.org.cn/flaw/list',
      itemSelector: 'table.tlist tr',
      titleSelector: 'td a',
      linkSelector: 'td a',
      dateSelector: 'td:last-child',
      category: 'vuln',
      maxItems: 30,
      keepDays: 60,
    },
    // 实测 HTTP 521（站点前置防护拒绝非浏览器访问），需代理 + 浏览器 UA，默认停用
    enabled: false,
    intervalMinutes: 720,
    priority: 28,
  },
  {
    key: 'cnnvd',
    name: '国家漏洞库（CNNVD）',
    category: 'vuln-db',
    adapter: 'html_list',
    url: 'https://www.cnnvd.org.cn/home/warn',
    config: {
      url: 'https://www.cnnvd.org.cn/home/warn',
      itemSelector: '.list-item, li.item, table tr',
      titleSelector: 'a',
      linkSelector: 'a',
      category: 'vuln',
      maxItems: 30,
      keepDays: 60,
    },
    // 实测返回 200 但正文仅为验证页（非列表结构），默认停用
    enabled: false,
    intervalMinutes: 720,
    priority: 29,
  },

  // ---------------------------------------------------------------------------
  // 通用适配器示例（演示 json_list 的接法，默认停用避免噪音）
  // ---------------------------------------------------------------------------
  {
    key: 'first-epss',
    name: 'FIRST EPSS 利用预测评分',
    category: 'vuln-db',
    adapter: 'json_list',
    url: 'https://api.first.org/data/v1/epss',
    config: {
      url: 'https://api.first.org/data/v1/epss?order=!epss&limit=50',
      itemsPath: 'data',
      fieldMap: { title: 'cve', url: 'cve', publishedAt: 'date', summary: 'epss', externalId: 'cve' },
      maxItems: 30,
      keepDays: 7,
      category: 'vuln',
    },
    // 实测可达（200）；但该接口只给 CVE + 分数，标题信息量低，作为 json_list 配置示例默认停用
    enabled: false,
    intervalMinutes: 720,
    priority: 95,
  },
];

/** 启用中的默认数据源（编排器/脚本按需使用，便于统计「有多少源会真正跑」）。 */
export const DEFAULT_ENABLED_SOURCES: SeedSource[] = DEFAULT_SOURCES.filter((source) => source.enabled);

/** 按 key 查默认源（测试与「试采」接口用）。 */
export function findDefaultSource(key: string): SeedSource | undefined {
  return DEFAULT_SOURCES.find((source) => source.key === key);
}
