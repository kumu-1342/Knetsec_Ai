/**
 * 统一 HTTP 客户端。
 *
 * 为什么集中在一处：token 注入、超时、401 跳登录、错误提示、文件下载这些横切逻辑，
 * 如果每个页面各写一遍，行为必然不一致。这里保证：
 * - 所有请求自动带 `Authorization: Bearer <token>`；
 * - 20 秒超时，避免上游采集慢时页面无限等待；
 * - 业务错误统一 `ElMessage.error`，页面只需要处理成功分支；
 * - 401 清除本地 token 并跳转登录页，同时保留 redirect 参数便于回跳；
 * - 下载接口兼容「文件流」与「JSON 信封里塞 base64/文本」两种后端实现。
 */
import axios, { AxiosError, type AxiosRequestConfig } from 'axios';
import { ElMessage } from 'element-plus';
import { API_PREFIX, type ApiFailure, type ApiSuccess } from '@knetsec/shared';

declare module 'axios' {
  export interface AxiosRequestConfig {
    /** 静默请求：失败时不弹全局错误提示（登录页等自行展示错误的场景）。 */
    silent?: boolean;
  }
}

/** localStorage 中 token 的存储键，契约固定，修改需同步登录态判断。 */
export const TOKEN_STORAGE_KEY = 'knetsec_token';

/** 登录页路径，401 时跳转目标。 */
const LOGIN_PATH = '/login';

/** 前端统一错误对象：页面可依据 code 做分支，例如 409 冲突时提示刷新。 */
export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
  }
}

const instance = axios.create({
  baseURL: API_PREFIX,
  timeout: 20_000,
  headers: { 'Content-Type': 'application/json' },
});

instance.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/** 清除登录态并跳转登录页；用 location 跳转而不是 router，避免 client 与 router 循环依赖。 */
function redirectToLogin(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  if (window.location.pathname === LOGIN_PATH) return;
  const redirect = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.replace(`${LOGIN_PATH}?redirect=${redirect}`);
}

/** 网络层错误的人类可读兜底文案。 */
function fallbackMessage(error: AxiosError): string {
  if (error.code === 'ECONNABORTED') return '请求超时（20 秒），请稍后重试';
  if (error.code === 'ERR_NETWORK') return '无法连接服务端，请确认 Knetsec_Ai 服务已启动';
  if (error.response?.status === 403) return '当前账号无权执行该操作';
  if (error.response?.status === 404) return '请求的资源不存在';
  if (error.response?.status === 429) return '请求过于频繁，请稍后再试';
  if (error.response?.status && error.response.status >= 500) return '服务端异常，请查看服务端日志';
  return error.message || '请求失败';
}

instance.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiFailure>) => {
    const status = error.response?.status ?? 0;
    const failure = error.response?.data;
    // 服务端约定的失败信封优先，其次是网络层兜底文案。
    const message = failure && failure.success === false ? failure.error.message : fallbackMessage(error);
    const code = failure && failure.success === false ? failure.error.code : 'NETWORK_ERROR';

    if (status === 401) {
      // 登录接口的 401 表示账号密码错误，由登录页行内展示，不能当作会话过期处理。
      const isLoginRequest = error.config?.url?.includes('/auth/login') ?? false;
      if (isLoginRequest) {
        return Promise.reject(new ApiRequestError(message, 'UNAUTHORIZED', status));
      }
      redirectToLogin();
      ElMessage.error('登录已过期，请重新登录');
      return Promise.reject(new ApiRequestError('登录已过期，请重新登录', 'UNAUTHORIZED', status));
    }

    if (!error.config?.silent) {
      ElMessage.error(message);
    }
    return Promise.reject(new ApiRequestError(message, code, status));
  },
);

/**
 * 发起请求并解开 `{ success, data }` 信封。
 *
 * @param config axios 请求配置
 * @returns 业务数据本身
 * @throws ApiRequestError 网络错误或业务失败
 */
export async function request<T>(config: AxiosRequestConfig): Promise<T> {
  const response = await instance.request<ApiSuccess<T>>(config);
  const body = response.data;
  if (!body || body.success !== true) {
    throw new ApiRequestError('服务端响应格式异常', 'INTERNAL_ERROR', response.status);
  }
  return body.data;
}

/** 从 Content-Disposition 中解析文件名，兼容 filename*=UTF-8'' 编码形式。 */
function parseFilename(disposition: string | undefined): string | null {
  if (!disposition) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      return encoded[1].trim();
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain?.[1]?.trim() ?? null;
}

/** 触发浏览器下载。 */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // 延迟回收，避免部分浏览器点击后立即 revoke 导致下载中断。
  window.setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/** 把未知类型载荷转成可下载文本，用于服务端把导出内容包在 JSON 信封里返回的兼容分支。 */
function payloadToText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload === null || payload === undefined) return '';
  return JSON.stringify(payload, null, 2);
}

/**
 * 下载文件（导出情报、报告下载）。
 *
 * 后端可能直接返回文件流，也可能返回 `{ success, data: <文本> }` 信封；
 * 两种都兼容，避免前端与后端实现细节强耦合。
 *
 * @param url 相对 API_PREFIX 的路径
 * @param params 查询参数
 * @param fallbackName 服务端未给出文件名时的兜底名称
 */
export async function downloadFile(
  url: string,
  params: Record<string, unknown> | undefined,
  fallbackName: string,
): Promise<void> {
  const response = await instance.get<Blob>(url, { params, responseType: 'blob' });
  const contentType = String(response.headers['content-type'] ?? '');
  const filename =
    parseFilename(response.headers['content-disposition'] as string | undefined) ?? fallbackName;

  if (contentType.includes('application/json')) {
    const text = await response.data.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    const envelope = parsed as Partial<ApiSuccess<unknown>> & Partial<ApiFailure>;
    if (envelope.success === false) {
      throw new ApiRequestError(
        envelope.error?.message ?? '导出失败',
        envelope.error?.code ?? 'INTERNAL_ERROR',
        400,
      );
    }
    if (envelope.success === true) {
      saveBlob(new Blob([payloadToText(envelope.data)], { type: 'text/plain;charset=utf-8' }), filename);
      return;
    }
    // 不是统一信封（例如 /items/export?format=json 直接返回数组）：原样保存服务端文本，
    // 既保留服务端格式，也避免二次序列化改变字段顺序。
    saveBlob(new Blob([text], { type: contentType || 'application/json;charset=utf-8' }), filename);
    return;
  }

  saveBlob(response.data, filename);
}
