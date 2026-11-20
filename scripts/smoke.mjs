#!/usr/bin/env node
/**
 * 端到端冒烟测试（需要服务端已启动：npm start 或 npm run dev）。
 *
 * 覆盖：健康检查 → 登录 → 仪表盘 → 数据源列表 → 触发采集 → 轮询任务 →
 *       情报查询 → 生成周报 → 下载报告 → 审计日志。
 *
 * 用法：
 *   node scripts/smoke.mjs
 *   KNETSEC_BASE_URL=http://127.0.0.1:8787 node scripts/smoke.mjs
 *   SMOKE_SOURCES=github-ghsa,cisa-kev node scripts/smoke.mjs
 */
import process from 'node:process';

const BASE = process.env.KNETSEC_BASE_URL ?? `http://127.0.0.1:${process.env.KNETSEC_PORT ?? '8787'}`;
const USERNAME = process.env.ADMIN_USERNAME ?? 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin123';
const ONLY_SOURCES = process.env.SMOKE_SOURCES
  ? process.env.SMOKE_SOURCES.split(',').map((s) => s.trim()).filter(Boolean)
  : undefined;

const results = [];
let token = '';

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const message = body?.error?.message ?? (typeof body === 'string' ? body.slice(0, 200) : response.statusText);
    throw new Error(`HTTP ${response.status} ${path}: ${message}`);
  }
  return body;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`\n=== Knetsec_Ai 端到端冒烟 @ ${BASE} ===\n`);

  // 1. 健康检查
  try {
    const health = await api('/api/v1/health');
    record('健康检查', health?.success === true, JSON.stringify(health?.data ?? {}).slice(0, 80));
  } catch (error) {
    record('健康检查', false, error.message);
    throw error;
  }

  // 2. 登录
  try {
    const login = await api('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    token = login.data.token;
    record('管理员登录', Boolean(token), `用户=${login.data.user?.username} 角色=${login.data.user?.role}`);
  } catch (error) {
    record('管理员登录', false, error.message);
    throw error;
  }

  // 3. 仪表盘
  try {
    const summary = await api('/api/v1/dashboard/summary');
    record('仪表盘聚合', Boolean(summary.data?.totals), `总情报=${summary.data.totals.items}`);
  } catch (error) {
    record('仪表盘聚合', false, error.message);
  }

  // 4. 数据源列表
  let sources = [];
  try {
    const res = await api('/api/v1/sources');
    sources = res.data ?? [];
    record('数据源列表', sources.length > 0, `共 ${sources.length} 个，启用 ${sources.filter((s) => s.enabled).length} 个`);
  } catch (error) {
    record('数据源列表', false, error.message);
  }

  // 5. 触发采集
  let runId = null;
  try {
    const keys = ONLY_SOURCES ?? sources.filter((s) => s.enabled).slice(0, 3).map((s) => s.key);
    const started = await api('/api/v1/tasks/fetch', {
      method: 'POST',
      body: JSON.stringify({ sourceKeys: keys }),
      timeoutMs: 120_000,
    });
    runId = started.data.runId;
    record('触发采集', Boolean(runId), `runId=${runId} sources=${keys.join(',')}`);
  } catch (error) {
    record('触发采集', false, error.message);
  }

  // 6. 轮询任务
  if (runId) {
    const deadline = Date.now() + 240_000;
    let run = null;
    while (Date.now() < deadline) {
      await sleep(3000);
      try {
        const res = await api(`/api/v1/tasks/runs/${runId}`);
        run = res.data;
        if (run.status !== 'running') break;
      } catch (error) {
        record('轮询采集任务', false, error.message);
        break;
      }
    }
    if (run) {
      record(
        '采集任务完成',
        run.status === 'success' || run.status === 'partial',
        `状态=${run.status} 新增=${run.itemsNew} 重复=${run.itemsDuplicate} 成功源=${run.sourcesOk}/${run.sourcesTotal}`,
      );
    } else {
      record('采集任务完成', false, '轮询超时');
    }
  }

  // 7. 情报查询
  let itemCount = 0;
  try {
    const res = await api('/api/v1/items?pageSize=5');
    itemCount = res.data?.total ?? 0;
    record('情报查询', itemCount > 0, `总数=${itemCount}`);
  } catch (error) {
    record('情报查询', false, error.message);
  }

  // 8. 生成周报
  let report = null;
  try {
    const res = await api('/api/v1/reports/generate', {
      method: 'POST',
      body: JSON.stringify({ type: 'weekly' }),
      timeoutMs: 120_000,
    });
    report = res.data;
    record('生成周报', Boolean(report?.id), `标题=${report?.title} 条数=${report?.itemCount}`);
  } catch (error) {
    record('生成周报', false, error.message);
  }

  // 9. 下载报告
  if (report?.id) {
    try {
      const res = await fetch(`${BASE}/api/v1/reports/${report.id}/download?format=html`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const html = await res.text();
      record('下载报告(HTML)', res.ok && html.includes('<html'), `${html.length} 字节`);
    } catch (error) {
      record('下载报告(HTML)', false, error.message);
    }
  }

  // 10. 审计日志
  try {
    const res = await api('/api/v1/audit-logs?pageSize=10');
    record('审计日志', Array.isArray(res.data?.items), `记录数=${res.data?.total}`);
  } catch (error) {
    record('审计日志', false, error.message);
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n=== 结果：${passed}/${results.length} 通过 ===`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log('失败项：');
    for (const f of failed) console.log(`- ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('\n冒烟测试异常终止：', error.message);
  process.exit(1);
});
