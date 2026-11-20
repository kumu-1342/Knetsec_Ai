/**
 * 采集器统一 HTTP 客户端。
 *
 * 能力：
 * - 超时、重试（429 / 5xx / 网络异常）、指数退避 + 抖动；
 * - 尊重 Retry-After；
 * - 统一 User-Agent（部分站点会拒绝空 UA，如 GitHub、NVD）；
 * - 可选 HTTP 代理（大陆网络访问 CNVD、部分厂商站点时必需）；
 * - 响应体大小上限，防止异常大文件打爆内存。
 */
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { CollectorHttpClient, CollectorLogger } from '@knetsec/shared';

export interface HttpClientOptions {
  timeoutMs?: number;
  retries?: number;
  userAgent?: string;
  proxyUrl?: string;
  logger?: CollectorLogger;
  maxResponseBytes?: number;
}

const DEFAULT_UA = 'Knetsec_Ai/1.0 (security-intelligence-collector; +https://github.com/knetsec)';

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(message: string, status: number, url: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpClient implements CollectorHttpClient {
  private readonly dispatcher: Dispatcher;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly userAgent: string;
  private readonly logger?: CollectorLogger;
  private readonly maxResponseBytes: number;

  constructor(options: HttpClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.retries = options.retries ?? 2;
    this.userAgent = options.userAgent ?? DEFAULT_UA;
    this.logger = options.logger;
    this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
    this.dispatcher = options.proxyUrl
      ? new ProxyAgent({ uri: options.proxyUrl, requestTls: { rejectUnauthorized: true } })
      : new Agent({ connections: 16, keepAliveTimeout: 10_000 });
  }

  async getText(url: string, init?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? this.timeoutMs);

    try {
      let lastError: unknown;

      for (let attempt = 0; attempt <= this.retries; attempt += 1) {
        try {
          const response = await undiciFetch(url, {
            method: 'GET',
            dispatcher: this.dispatcher,
            signal: controller.signal,
            headers: {
              'user-agent': this.userAgent,
              accept: 'application/json, application/xml, text/xml, text/html;q=0.9, */*;q=0.8',
              ...init?.headers,
            },
          });

          if (response.status === 429 || response.status >= 500) {
            const retryAfter = Number(response.headers.get('retry-after') ?? '');
            if (attempt < this.retries) {
              const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : 500 * 2 ** attempt + Math.floor(Math.random() * 300);
              this.logger?.warn({ url, status: response.status, attempt, waitMs }, '上游限流或错误，准备重试');
              await sleep(waitMs);
              continue;
            }
          }

          if (!response.ok) {
            throw new HttpError(`HTTP ${response.status} ${response.statusText}`, response.status, url);
          }

          const contentLength = Number(response.headers.get('content-length') ?? '0');
          if (contentLength > this.maxResponseBytes) {
            throw new HttpError(`响应体过大: ${contentLength} bytes`, response.status, url);
          }

          const text = await response.text();
          if (text.length > this.maxResponseBytes) {
            throw new HttpError('响应体超过上限', response.status, url);
          }
          return text;
        } catch (error) {
          lastError = error;
          const isAbort = error instanceof Error && error.name === 'AbortError';
          if (isAbort || attempt >= this.retries) break;
          const waitMs = 500 * 2 ** attempt + Math.floor(Math.random() * 300);
          this.logger?.warn({ url, attempt, waitMs, err: String(error) }, '请求失败，准备重试');
          await sleep(waitMs);
        }
      }

      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    } finally {
      clearTimeout(timer);
    }
  }

  async getJson<T = unknown>(
    url: string,
    init?: { headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<T> {
    const text = await this.getText(url, {
      ...init,
      headers: { accept: 'application/json', ...init?.headers },
    });
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new HttpError(`JSON 解析失败: ${String(error)}`, 200, url);
    }
  }
}
