/**
 * 采集器公共工具。
 *
 * 为什么集中在一处：10 个适配器要处理同一批脏数据问题——上游字段类型不稳定
 * （该是字符串的给了对象/数字）、HTML 混在摘要里、时间格式五花八门、相对链接、
 * 限流需要 sleep。把这些统一收口，适配器只剩「字段映射」这一件事，代码短且好审。
 *
 * 约定：本文件不写库、不发请求（除类型外无副作用），便于单测与复用。
 */
import { XMLParser } from 'fast-xml-parser';
import type { CollectorContext, ItemCategory } from '@knetsec/shared';
import { cleanSummary, parseIsoDate } from '../pipeline/normalize.js';

/** 普通请求之间的默认间隔：多数站点对「无间隔连发」敏感，300ms 是稳妥下限。 */
export const DEFAULT_REQUEST_INTERVAL_MS = 300;

/** GitHub 未认证搜索接口限流 10 次/分钟，因此搜索类请求之间至少间隔 6 秒。 */
export const GITHUB_SEARCH_INTERVAL_MS = 6_000;

/** NVD 未认证限流 5 次/30 秒（≈6 秒/次）。 */
export const NVD_INTERVAL_MS = 6_000;

/** NVD 带 API Key 时限流 50 次/30 秒，0.6 秒即可。 */
export const NVD_KEYED_INTERVAL_MS = 600;

/** 单次采集默认最多返回条数，防止首次接入灌入过多历史数据（docs/00 §7 时效约定）。 */
export const DEFAULT_MAX_ITEMS = 30;

/** 默认只看最近 N 天，与「首次接入不回灌历史」的约定一致。 */
export const DEFAULT_KEEP_DAYS = 30;

/**
 * AI 模型/框架/工具链关键词。
 *
 * 用途：GitHub Advisory / NVD 这类混合源中，把「命中 AI 生态组件」的漏洞
 * 建议归类为 ai-security（流水线 enrich 还会用 settings.aiSecurityKeywords 二次校正）。
 * 只放组件名，不放泛化词（如 "ai"），否则会把大量无关条目误判为 AI 安全。
 */
export const AI_STACK_KEYWORDS: readonly string[] = [
  'pytorch',
  'tensorflow',
  'keras',
  'transformers',
  'huggingface',
  'hugging face',
  'langchain',
  'llamaindex',
  'llama-index',
  'llama_index',
  'openai',
  'anthropic',
  'vllm',
  'ollama',
  'onnx',
  'onnxruntime',
  'scikit-learn',
  'sklearn',
  'mlflow',
  'ray',
  'diffusers',
  'gradio',
  'streamlit',
  'sentence-transformers',
  'faiss',
  'chromadb',
  'pinecone',
  'weaviate',
  'qdrant',
  'model-context-protocol',
  'mcp',
  'autogen',
  'crewai',
  'semantic-kernel',
  'litellm',
  'pydantic-ai',
  'dspy',
  'peft',
  'torch',
  'jax',
  'wandb',
  'comfyui',
  'stable-diffusion',
  'invokeai',
  'gpt4all',
  'triton',
  'xformers',
  'nvidia',
  'cuda',
];

/** 可等待的 sleep：适配器内部串行限流用。 */
export function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 判断是否为普通对象（排除数组与 null），外部数据收窄的第一步。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 安全取字符串：数字也转字符串（上游常把 ID 写成数字）。 */
export function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** 安全取数字：字符串数字也尝试转换，失败返回 undefined。 */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** 安全取布尔：兼容字符串 true/false 与 1/0。 */
export function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return undefined;
}

/** 统一成数组：fast-xml-parser 单元素不返回数组，JSON 上游也常有单对象/数组两种形态。 */
export function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

/** 折叠所有空白为单空格并去首尾。 */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** 截断到指定长度（超出部分用省略号，保证不超长）。 */
export function truncate(value: string, max: number): string {
  if (max <= 0) return '';
  if (value.length <= max) return value;
  return value.slice(0, Math.max(1, max - 1)) + '…';
}

/**
 * 从 XML / HTML 节点的解析结果中取出文本。
 *
 * fast-xml-parser 在 ignoreAttributes=false 时会把带属性的节点解析成
 * { '@_href': '...', '#text': '...' }；CDATA 默认合并进 '#text'。
 */
export function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (isRecord(value)) {
    const candidates = ['#text', '_', 'text', 'value'];
    for (const key of candidates) {
      const found = value[key];
      if (typeof found === 'string') return found;
      if (typeof found === 'number') return String(found);
    }
  }
  return undefined;
}

/** 把 HTML 清洗为纯文本摘要（复用归一化层的实现，保证摘要口径一致）。 */
export function plainText(value: unknown, maxChars = 600): string | undefined {
  const text = textOf(value);
  if (typeof text !== 'string' || text.trim().length === 0) return undefined;
  const cleaned = cleanSummary(text, maxChars);
  return cleaned ?? undefined;
}

/** 时间解析的统一入口：无法解析返回 undefined，由归一化层回退到 fetchedAt。 */
export function toIsoOrUndefined(value: unknown): string | undefined {
  return parseIsoDate(value);
}

/**
 * 判断文本是否命中 AI 生态关键词，返回命中的关键词（便于写日志/打标签）。
 *
 * 为什么不能简单 includes：关键词里有 cuda / ray / torch / mcp 这类短词，
 * 子串匹配会把 "Barracuda"（cuda）、"Arraytics"（ray）、"McPherson"（mcp）误判成
 * AI 生态组件，导致 CISA KEV 的 Barracuda 漏洞被错误归到 ai-security（实测踩过）。
 *
 * 因此改为「语义边界」匹配：关键词前后必须是非 ASCII 字母数字字符（或字符串首尾）。
 * - 中文关键词（如 大模型）同样成立：前后是汉字时不是 [a-z0-9]，能正常命中；
 * - 带连字符的关键词（model-context-protocol）按整体匹配，不会被边界切断；
 * - "CUDA-enabled"、"cuda:" 这类写法依然命中（连字符/冒号不是字母数字）。
 *
 * 实现用 indexOf 扫描而不是正则：无需转义关键词里的 regex 元字符，且更快更直白。
 */
export function matchAiKeyword(text: string): string | undefined {
  if (!text) return undefined;
  const haystack = text.toLowerCase();
  for (const keyword of AI_STACK_KEYWORDS) {
    if (containsKeywordWithBoundary(haystack, keyword.toLowerCase())) return keyword;
  }
  return undefined;
}

/** 判断字符是否属于 ASCII 字母数字（关键词边界判定口径）。 */
function isAsciiAlnum(char: string | undefined): boolean {
  if (!char) return false;
  return (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9');
}

/**
 * 在已小写化的文本中查找「独立词」形式的关键词。
 *
 * 逐个出现位置检查左右相邻字符，避免 Barracuda / Arraytics 这类误命中。
 */
function containsKeywordWithBoundary(haystack: string, keyword: string): boolean {
  if (keyword.length === 0) return false;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(keyword, from);
    if (index < 0) return false;
    const before = index === 0 ? undefined : haystack[index - 1];
    const afterIndex = index + keyword.length;
    const after = afterIndex >= haystack.length ? undefined : haystack[afterIndex];
    if (!isAsciiAlnum(before) && !isAsciiAlnum(after)) return true;
    from = index + 1;
  }
}

/** 依据关键词命中给出建议分类：命中 AI 组件 → ai-security，否则回退传入的默认分类。 */
export function suggestAiCategory(text: string, fallback: ItemCategory): ItemCategory {
  return matchAiKeyword(text) ? 'ai-security' : fallback;
}

/** 把相对链接解析为绝对链接；解析失败返回 undefined（丢弃脏链接比写坏链接好）。 */
export function toAbsoluteUrl(base: string, href: string | undefined): string | undefined {
  if (typeof href !== 'string') return undefined;
  const trimmed = href.trim();
  if (trimmed.length === 0) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return undefined;
  }
}

/**
 * 按点路径从 JSON 中取值，支持 "data.items" 与数组下标 "data.0.items"。
 *
 * json_list 适配器需要从任意结构的接口里定位条目数组，路径由配置给出，
 * 因此必须容错：路径不存在时返回 undefined 而不是抛错。
 */
export function getByPath(value: unknown, path: string): unknown {
  if (!path) return value;
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (segment.length === 0) continue;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[segment];
    if (current === undefined) return undefined;
  }
  return current;
}

/** 构造 GitHub API 请求头；有 token 时附带 Authorization（未认证限流 60 次/小时）。 */
export function githubHeaders(ctx: CollectorContext, options?: { accept?: string }): Record<string, string> {
  const headers: Record<string, string> = {
    accept: options?.accept ?? 'application/vnd.github+json',
    // GitHub 强烈建议固定 API 版本，避免上游默认行为变化影响解析
    'x-github-api-version': '2022-11-28',
  };
  const token = ctx.secrets.githubToken?.trim();
  if (token) headers.authorization = 'Bearer ' + token;
  return headers;
}

/** 构造 NVD 请求头；有 API Key 时写入 apiKey 头（限流从 5 次/30 秒提升到 50 次/30 秒）。 */
export function nvdHeaders(ctx: CollectorContext): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const apiKey = ctx.secrets.nvdApiKey?.trim();
  if (apiKey) headers.apiKey = apiKey;
  return headers;
}

/** XML 解析器：统一配置，属性保留为 @_xxx，避免各适配器配置不一致导致字段名漂移。 */
export function parseXml(xml: string): unknown {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: true,
    // 关闭自动类型转换：CVE 编号、日期字符串不能被转成 number
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: true,
  });
  return parser.parse(xml);
}

/**
 * 解析上游报文中的时间窗口过滤。
 *
 * 为什么统一实现：所有适配器都要「只返回最近 N 天」，但上游时间可能是 ISO、
 * 纯日期或非法值；这里统一处理为「无法判断时间时保留条目」（宁可多采一条，
 * 也不要因为时间脏数据丢掉新情报）。
 */
export function isWithinDays(isoTime: string | undefined, now: Date, days: number): boolean {
  if (!isoTime) return true;
  const time = new Date(isoTime).getTime();
  if (Number.isNaN(time)) return true;
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  return time >= cutoff;
}

/**
 * 规整配置数值：把非法值收敛到 [min, max] 区间。
 *
 * 配置来自数据库（管理员可手改 JSON），不能让一个拼错的字符串把采集搞崩，
 * 因此所有数值型配置都要经过这里。
 */
export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = asNumber(value);
  if (parsed === undefined) return fallback;
  const rounded = Math.round(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

/** 校验并返回 -- 配置里的字符串数组（去空、去重、限长）。 */
export function stringList(value: unknown, limit = 32): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const text = asString(entry)?.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

/** 校验分类配置值是否合法；非法返回 undefined 交给上层兜底。 */
export function asItemCategory(value: unknown): ItemCategory | undefined {
  const allowed: readonly string[] = ['ai-security', 'vuln', 'cyber', 'research', 'tool', 'policy', 'news'];
  const text = asString(value);
  return text && allowed.includes(text) ? (text as ItemCategory) : undefined;
}

/** 计算本次采集的起始时间，用于「只看最近 N 天」的请求参数。 */
export function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - Math.max(1, days) * 24 * 60 * 60 * 1000);
}
