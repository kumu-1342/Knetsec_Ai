/**
 * 系统设置（契约 §6 /settings）。
 *
 * 安全约定：
 * - GET 返回的 llmApiKey 一律 maskSecret 脱敏，面板只能看到前后各 4 位；
 * - PUT 时 llmApiKey 传空字符串或脱敏值（含 ****）表示「保持原值」，
 *   避免面板把脱敏串回写导致真实 Key 被覆盖；
 * - 所有变更写审计日志，但 detail 只记录字段名不记录值（防止密钥入审计表）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ITEM_CATEGORIES, NOTIFICATION_CHANNELS, type SettingsDTO } from '@knetsec/shared';
import type { AppSettings } from '@knetsec/shared';
import { createGuards } from '../core/auth-guard.js';
import type { AppContext } from '../core/context.js';
import { replyOk } from '../core/envelope.js';
import { maskSecret } from '../../infra/security.js';

/** 更新设置请求体：字段全部可选，但类型必须正确。 */
const updateSettingsSchema = z.object({
  watchKeywords: z.array(z.string().trim().min(1).max(100)).max(500).optional(),
  aiSecurityKeywords: z.array(z.string().trim().min(1).max(100)).max(1000).optional(),
  reportRangeDays: z.number().int().min(1).max(90).optional(),
  reportSections: z.array(z.enum(ITEM_CATEGORIES)).min(1).max(7).optional(),
  notificationEnabled: z.boolean().optional(),
  notificationChannel: z.enum(NOTIFICATION_CHANNELS).optional(),
  notificationWebhook: z.string().trim().max(500).optional(),
  llmEnabled: z.boolean().optional(),
  llmBaseUrl: z
    .string()
    .trim()
    .max(300)
    .refine((value) => value === '' || /^https?:\/\//i.test(value), 'LLM Base URL 必须以 http(s):// 开头')
    .optional(),
  llmApiKey: z.string().max(300).optional(),
  llmModel: z.string().trim().max(100).optional(),
  retentionDays: z.number().int().min(7).max(3650).optional(),
  fetchIntervalMinutes: z.number().int().min(5).max(10080).optional(),
});

/** 设置 → DTO（脱敏）。 */
function toSettingsDto(settings: AppSettings): SettingsDTO {
  return {
    ...settings,
    llmApiKey: maskSecret(settings.llmApiKey),
  };
}

/** 注册设置路由。 */
export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const guards = createGuards(ctx);

  app.get('/settings', { preHandler: guards.requireAuth }, async (request, reply) => {
    return replyOk(request, reply, toSettingsDto(ctx.settings.get()));
  });

  app.put('/settings', { preHandler: guards.requireAdmin }, async (request, reply) => {
    const body = updateSettingsSchema.parse(request.body ?? {}) as Partial<SettingsDTO>;
    const patch: Partial<AppSettings> = { ...body } as Partial<AppSettings>;

    // 空字符串或脱敏值表示保持原值：面板加载时拿到的是 sk-****abcd
    if (patch.llmApiKey === undefined || patch.llmApiKey === '' || patch.llmApiKey.includes('****')) {
      delete patch.llmApiKey;
    }

    const updated = Object.keys(patch).length > 0 ? ctx.settings.update(patch) : ctx.settings.get();
    ctx.audit.record({
      username: request.authUser?.username ?? 'unknown',
      action: 'settings.update',
      target: 'settings',
      // 只记录字段名，绝不记录值（可能含 Webhook / API Key）
      detail: { keys: Object.keys(patch) },
      ip: request.ip,
    });
    return replyOk(request, reply, toSettingsDto(updated));
  });
}
