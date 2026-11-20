#!/usr/bin/env node
/**
 * 演示数据采集脚本：登录 → 触发指定数据源采集 → 轮询进度 → 打印统计。
 *
 * 用途：首次部署后快速填充真实情报、验收采集链路；
 * 也可用于日常手动巡检（等价于面板「采集任务 → 立即采集」）。
 *
 * 用法：
 *   node scripts/collect-demo.mjs
 *   COLLECT_SOURCES=cisa-kev,github-ghsa node scripts/collect-demo.mjs
 */
import process from 'node:process';

const BASE = process.env.KNETSEC_BASE_URL ?? `http://127.0.0.1:${process.env.KNETSEC_PORT ?? '8787'}`;
const USERNAME = process.env.ADMIN_USERNAME ?? 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin123';

/** 默认采集集：覆盖 GitHub / 漏洞库 / 厂商 / 研究 / 媒体 / 社区六类来源。 */
const DEFAULT_SOURCES = [
  'cisa-kev',
  'github-ghsa',
  'github-ghsa-ai',
  'nvd-ai',
  'nvd-recent',
  'msrc',
  'arxiv-cr',
  'arxiv-ai',
  'cisco',
  'unit42',
  'microsoft-security',
  'aws-security',
  'cloudflare-blog',
  'securelist',
  'openai',
  'embracethered',
  'simonwillison',
  'github-ai-security-projects',
  'github-releases',
  'github-blog',
];

const sourceKeys = process.env.COLLECT_SOURCES
  ? process.env.COLLECT_SOURCES.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_SOURCES;

let token = '';

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${path}: ${body?.error?.message ?? response.statusText}`);
  }
  return body;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log(`\n=== Knetsec_Ai 演示数据采集 @ ${BASE} ===`);
  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  token = login.data.token;
  console.log(`登录成功：${login.data.user.username}`);

  const started = await api('/api/v1/tasks/fetch', {
    method: 'POST',
    body: JSON.stringify({ sourceKeys }),
  });
  const runId = started.data.runId;
  console.log(`采集任务已启动 runId=${runId}，共 ${sourceKeys.length} 个源`);

  const deadline = Date.now() + 20 * 60 * 1000;
  let run = null;
  while (Date.now() < deadline) {
    await sleep(8000);
    run = (await api(`/api/v1/tasks/runs/${runId}`)).data;
    const lines = run.logs ?? [];
    console.log(`[${run.status}] 新增=${run.itemsNew} 重复=${run.itemsDuplicate} 源=${run.sourcesOk}/${run.sourcesTotal}${lines.length ? ' | ' + lines[lines.length - 1] : ''}`);
    if (run.status !== 'running') break;
  }

  console.log('\n=== 采集完成 ===');
  console.log(JSON.stringify({
    runId,
    status: run?.status,
    itemsNew: run?.itemsNew,
    itemsDuplicate: run?.itemsDuplicate,
    sourcesOk: run?.sourcesOk,
    sourcesFailed: run?.sourcesFailed,
    finishedAt: run?.finishedAt,
  }, null, 2));

  const summary = (await api('/api/v1/dashboard/summary')).data;
  console.log(`\n库内总计 ${summary.totals.items} 条，今日新增 ${summary.totals.itemsToday} 条`);
  console.log('按来源：');
  for (const row of summary.sourceDistribution) console.log(`  ${row.sourceName}: ${row.count}`);
  if (run?.status === 'failed') process.exit(1);
}

main().catch((error) => {
  console.error('采集失败：', error.message);
  process.exit(1);
});
