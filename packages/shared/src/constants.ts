/**
 * 全仓共享常量与默认配置。
 *
 * 注意：默认配置只是「首次启动时的初始值」，运行期以数据库中 settings 表为准，
 * 管理员可以在管理面板中在线修改。
 */
import type { ItemCategory, NotificationChannel, Severity } from './domain.js';

/** 应用名（日志、报告、页面标题统一使用）。 */
export const APP_NAME = 'Knetsec_Ai';
export const APP_VERSION = '1.0.0';
/** 产品定位一句话，用于 README / 报告 / 登录页副标题。 */
export const APP_TAGLINE = 'AI 安全 × 网络安全实时情报平台';

/** REST API 版本前缀。 */
export const API_PREFIX = '/api/v1';

/** 分页默认值与上限。 */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** 服务默认端口（仅监听 127.0.0.1）。 */
export const DEFAULT_PORT = 8787;

/** 报告默认章节顺序，与报告生成器、管理面板设置项保持一致。 */
export const REPORT_SECTIONS: ItemCategory[] = [
  'ai-security',
  'vuln',
  'cyber',
  'research',
  'tool',
  'policy',
  'news',
];

/**
 * AI 安全分类词典（规则打标）。
 *
 * 采集到的标题/摘要命中任一关键词即打上对应标签，用于：
 * 1. 自动判定 category = ai-security；
 * 2. 报告「AI 安全」章节的分组；
 * 3. 管理面板的关键词筛选。
 * 该词典可由管理员在「系统设置」中覆盖（aiSecurityKeywords）。
 */
export const AI_SECURITY_TAXONOMY: Array<{ tag: string; label: string; keywords: string[] }> = [
  {
    tag: 'prompt-injection',
    label: '提示注入',
    keywords: ['prompt injection', 'prompt-injection', 'indirect prompt', '提示注入', '越狱', 'jailbreak'],
  },
  {
    tag: 'llm-app',
    label: '大模型应用安全',
    keywords: ['llm', 'large language model', 'chatgpt', 'gpt-', 'claude', 'gemini', '大模型', '生成式 ai'],
  },
  {
    tag: 'agent',
    label: 'Agent 与工具调用',
    keywords: ['agent', 'mcp', 'tool calling', 'function call', 'autonomous', '智能体', '工具调用'],
  },
  {
    tag: 'rag',
    label: 'RAG 与数据泄露',
    keywords: ['rag', 'retrieval augmented', 'vector database', 'embedding', '知识库', '数据泄露'],
  },
  {
    tag: 'model-supply-chain',
    label: '模型与供应链',
    keywords: ['model supply chain', 'model poisoning', 'backdoor', 'pickle', 'safetensors', 'hugging face', '模型投毒', '供应链'],
  },
  {
    tag: 'adversarial-ml',
    label: '对抗机器学习',
    keywords: ['adversarial', 'evasion', 'membership inference', 'model extraction', '对抗样本', '模型窃取'],
  },
  {
    tag: 'ai-governance',
    label: 'AI 治理与合规',
    keywords: ['ai act', 'nist ai', 'iso 42001', 'owasp llm', '生成式人工智能', 'ai 治理', '合规'],
  },
  {
    tag: 'ai-offensive',
    label: 'AI 赋能攻防',
    keywords: ['ai-powered attack', 'llm-assisted', 'deepfake', 'ai 钓鱼', '自动化攻击', 'ai agent attack'],
  },
];

/** AI 安全关键词默认值（由词典展开，管理员可覆盖）。 */
export const DEFAULT_AI_SECURITY_KEYWORDS: string[] = AI_SECURITY_TAXONOMY.flatMap((t) => t.keywords);

/** 默认关注关键词（影响情报列表的「重点关注」标记与报告导语）。 */
export const DEFAULT_WATCH_KEYWORDS: string[] = [
  'openai',
  'anthropic',
  'deepseek',
  'mcp',
  'prompt injection',
  'owasp',
  'cve',
  'langchain',
  'ollama',
  'nvd',
];

/** 严重度推导阈值：CVSS >= 9.0 critical，>= 7.0 high，>= 4.0 medium，> 0 low。 */
export const CVSS_SEVERITY_THRESHOLDS: Array<{ min: number; severity: Severity }> = [
  { min: 9.0, severity: 'critical' },
  { min: 7.0, severity: 'high' },
  { min: 4.0, severity: 'medium' },
  { min: 0.1, severity: 'low' },
];

/** 运行期可修改的系统设置（数据库 settings 表逐项存储）。 */
export interface AppSettings {
  /** 重点关注关键词 */
  watchKeywords: string[];
  /** AI 安全分类关键词 */
  aiSecurityKeywords: string[];
  /** 默认报告回看天数 */
  reportRangeDays: number;
  /** 报告启用的章节 */
  reportSections: ItemCategory[];
  /** 是否启用通知 */
  notificationEnabled: boolean;
  /** 通知渠道 */
  notificationChannel: NotificationChannel;
  /** 通知 Webhook 地址 */
  notificationWebhook: string;
  /** 是否启用 LLM 摘要增强 */
  llmEnabled: boolean;
  /** OpenAI 兼容接口 Base URL */
  llmBaseUrl: string;
  /** LLM API Key（落库前加密，接口返回脱敏） */
  llmApiKey: string;
  /** LLM 模型名 */
  llmModel: string;
  /** 情报保留天数，超期在每日维护任务中清理 */
  retentionDays: number;
  /** 默认采集间隔（分钟），新建数据源时使用 */
  fetchIntervalMinutes: number;
}

/** 系统设置默认值：首次启动写入 settings 表。 */
export const DEFAULT_SETTINGS: AppSettings = {
  watchKeywords: DEFAULT_WATCH_KEYWORDS,
  aiSecurityKeywords: DEFAULT_AI_SECURITY_KEYWORDS,
  reportRangeDays: 7,
  reportSections: ['ai-security', 'vuln', 'cyber', 'research', 'tool', 'policy', 'news'],
  notificationEnabled: false,
  notificationChannel: 'generic',
  notificationWebhook: '',
  llmEnabled: false,
  llmBaseUrl: 'https://api.deepseek.com',
  llmApiKey: '',
  llmModel: 'deepseek-chat',
  retentionDays: 180,
  fetchIntervalMinutes: 360,
};

/** 管理面板默认每页条数等 UI 常量。 */
export const UI_PAGE_SIZES = [10, 20, 50, 100] as const;

/** 默认管理员用户名（可用环境变量覆盖）。 */
export const DEFAULT_ADMIN_USERNAME = 'admin';