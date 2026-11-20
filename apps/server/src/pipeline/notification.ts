/**
 * 通知推送：新一轮采集出现 critical 或 KEV 条目时，推送到 Webhook / 企微 / 钉钉 / 飞书。
 *
 * 设计要点：
 * - 通知是旁路能力：任何失败只 warn，绝不影响采集主流程与运行记录状态；
 * - 各渠道报文格式不同但都是 POST JSON，故按渠道组装 body（契约 §5.3 NOTIFICATION_CHANNELS）；
 * - 只推送标题/链接/严重度，不推送正文（合规边界：只聚合公开披露信息）。
 */
import type { AppSettings, CollectorLogger, NormalizedItem } from '@knetsec/shared';
import { SEVERITY_LABELS } from '@knetsec/shared';

/** 单次通知结果，便于编排器写运行日志。 */
export interface NotificationResult {
  sent: boolean;
  channel: string;
  /** 推送的条目数（仅 critical/KEV 子集）。 */
  itemCount: number;
  error: string | null;
}

/** 单条消息最多展示的条目数（Webhook 通常有长度限制）。 */
const MAX_ITEMS_IN_MESSAGE = 10;
/** Webhook 请求超时，避免外部服务无响应拖住采集任务收尾。 */
const NOTIFY_TIMEOUT_MS = 10_000;

/** 组装纯文本消息正文（各渠道共用）。 */
function buildMessageText(items: NormalizedItem[], runId?: number): string {
  const lines: string[] = [];
  lines.push(`**Knetsec_Ai 采集告警**${runId ? `（运行 #${runId}）` : ''}`);
  lines.push(`本轮新增 ${items.length} 条高优先级情报：`);
  items.slice(0, MAX_ITEMS_IN_MESSAGE).forEach((item, index) => {
    const severity = SEVERITY_LABELS[item.severity];
    const kev = item.isKev ? ' [KEV 在野利用]' : '';
    const ids = [...item.cveIds, ...item.ghsaIds].join(', ');
    lines.push(`${index + 1}. [${severity}]${kev} ${item.title}${ids ? `（${ids}）` : ''}`);
    if (item.url) lines.push(item.url);
  });
  if (items.length > MAX_ITEMS_IN_MESSAGE) {
    lines.push(`……其余 ${items.length - MAX_ITEMS_IN_MESSAGE} 条请登录管理面板查看`);
  }
  return lines.join('\n');
}

/** 按渠道组装 Webhook 请求体（企业微信/钉钉/飞书机器人协议各不相同）。 */
function buildRequestPayload(
  channel: AppSettings['notificationChannel'],
  title: string,
  text: string,
): Record<string, unknown> {
  switch (channel) {
    case 'wecom':
      return { msgtype: 'markdown', markdown: { content: text } };
    case 'dingtalk':
      return { msgtype: 'markdown', markdown: { title, text } };
    case 'feishu':
      return { msgtype: 'text', content: { text } };
    case 'generic':
    default:
      return { title, content: text, source: 'Knetsec_Ai' };
  }
}

/**
 * 推送高优先级情报。
 *
 * @param items 本轮新增且 severity=critical 或 isKev 的条目（调用方筛选）
 * @param settings 当前系统设置（渠道、Webhook、开关）
 * @param logger 采集日志器
 * @param options.fetchImpl 测试可注入假 fetch，避免真实外网请求
 * @param options.runId 运行 id，仅用于消息落款
 */
export async function notifyCriticalItems(
  items: NormalizedItem[],
  settings: AppSettings,
  logger: CollectorLogger,
  options: { fetchImpl?: typeof fetch; runId?: number } = {},
): Promise<NotificationResult> {
  const channel = settings.notificationChannel;
  if (!settings.notificationEnabled || !settings.notificationWebhook || items.length === 0) {
    return { sent: false, channel, itemCount: 0, error: null };
  }

  const doFetch = options.fetchImpl ?? fetch;
  const text = buildMessageText(items, options.runId);
  const payload = buildRequestPayload(channel, 'Knetsec_Ai 采集告警', text);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);

  try {
    const response = await doFetch(settings.notificationWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    // 企业微信/钉钉/飞书即使 HTTP 200 也可能在 body 中返回错误码，尽力解析并告警
    try {
      const body = (await response.json()) as unknown;
      const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
      const errcode = record?.errcode ?? record?.code;
      if (typeof errcode === 'number' && errcode !== 0) {
        throw new Error(`webhook 返回错误码 ${errcode}`);
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        // 部分通用 Webhook 返回非 JSON（如 "ok"），视为成功
      } else {
        throw error;
      }
    }

    logger.info({ channel, count: items.length }, '高优先级情报通知已推送');
    return { sent: true, channel, itemCount: items.length, error: null };
  } catch (error) {
    logger.warn({ channel, err: String(error) }, '情报通知推送失败（已忽略）');
    return { sent: false, channel, itemCount: items.length, error: String(error) };
  } finally {
    clearTimeout(timer);
  }
}
