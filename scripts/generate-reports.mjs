#!/usr/bin/env node
/**
 * 一键生成演示报告：清理旧报告 → 周报 → 月报 → AI 安全专题。
 *
 * 用途：部署/演示前快速产出三类报告，验证报告生成链路。
 * 用法：node scripts/generate-reports.mjs
 */
import process from 'node:process';

const BASE = process.env.KNETSEC_BASE_URL ?? `http://127.0.0.1:${process.env.KNETSEC_PORT ?? '8787'}`;
const USERNAME = process.env.ADMIN_USERNAME ?? 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin123';

let token = '';

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${body?.error?.message ?? response.statusText}`);
  return body;
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function main() {
  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  token = login.data.token;

  const existing = await api('/api/v1/reports?pageSize=100');
  for (const report of existing.data.items) {
    await api(`/api/v1/reports/${report.id}`, { method: 'DELETE', body: JSON.stringify({}) });
    console.log(`已删除旧报告 #${report.id} ${report.title}`);
  }

  const weekly = await api('/api/v1/reports/generate', {
    method: 'POST',
    body: JSON.stringify({ type: 'weekly' }),
  });
  console.log(`周报 #${weekly.data.id}：${weekly.data.title}（${weekly.data.itemCount} 条）`);

  const monthly = await api('/api/v1/reports/generate', {
    method: 'POST',
    body: JSON.stringify({ type: 'monthly', periodStart: isoDaysAgo(30), periodEnd: new Date().toISOString() }),
  });
  console.log(`月报 #${monthly.data.id}：${monthly.data.title}（${monthly.data.itemCount} 条）`);

  const aiItems = await api('/api/v1/items?category=ai-security&pageSize=100&sort=importance&order=desc');
  const topic = await api('/api/v1/reports/generate', {
    method: 'POST',
    body: JSON.stringify({
      type: 'custom',
      title: 'Knetsec_Ai AI 安全专题报告：模型 / MCP / Agent 风险',
      itemIds: aiItems.data.items.map((item) => item.id),
    }),
  });
  console.log(`AI 专题 #${topic.data.id}：${topic.data.title}（${topic.data.itemCount} 条）`);

  const summary = (await api('/api/v1/dashboard/summary')).data;
  console.log(`\n情报总数 ${summary.totals.items}，分类分布：`);
  for (const row of summary.categoryDistribution) console.log(`  ${row.category}: ${row.count}`);
}

main().catch((error) => {
  console.error('生成报告失败：', error.message);
  process.exit(1);
});