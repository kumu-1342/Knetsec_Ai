/**
 * 采集任务集成测试：异步 202、互斥 409、参数校验、运行记录、调度器状态。
 * 使用假流水线（会回写 fetch_runs），不触发任何真实 HTTP。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/infra/db.js';
import type { PipelineRunner } from '../src/modules/core/context.js';
import type { RunSummary } from '../src/pipeline/orchestrator.js';
import { authHeader, createTestApp, createViewer, type TestApp } from './api-helpers.js';

let ctx: TestApp | null = null;
afterEach(async () => {
  if (ctx) {
    await ctx.close();
    ctx = null;
  }
});

/** 假流水线：模拟成功执行并回写 fetch_runs，便于断言任务状态流转。 */
function fakePipeline(db: Db): PipelineRunner {
  return {
    async run(runId: number, sourceKeys?: string[]): Promise<RunSummary> {
      const finishedAt = new Date().toISOString();
      const sourceCount = sourceKeys?.length ?? 0;
      db.run(
        "UPDATE fetch_runs SET status = 'success', finished_at = ?, sources_total = ?, sources_ok = ?, items_new = ?, logs = ? WHERE id = ?",
        [finishedAt, sourceCount, sourceCount, 0, JSON.stringify([`${finishedAt} 假流水线执行完成`]), runId],
      );
      return {
        runId,
        status: 'success',
        startedAt: finishedAt,
        finishedAt,
        durationMs: 0,
        sourcesTotal: sourceCount,
        sourcesOk: sourceCount,
        sourcesFailed: 0,
        itemsNew: 0,
        itemsDuplicate: 0,
        errors: [],
      };
    },
  };
}

/** 轮询等待运行记录进入终态。 */
async function waitForRunFinished(app: TestApp['app'], token: string, runId: number): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/tasks/runs/${runId}`,
      headers: authHeader(token),
    });
    const status = (response.json() as { data: { status: string } }).data.status;
    if (status !== 'running') return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return 'running';
}

describe('采集任务', () => {
  it('触发采集返回 202 + runId，异步执行后记录可查', async () => {
    ctx = await createTestApp();
    // 应用创建后替换流水线：路由在请求时才读取 ctx.pipeline，因此注入生效
    ctx.app.knetsec.pipeline = fakePipeline(ctx.db);
    const headers = authHeader(ctx.token);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tasks/fetch',
      headers,
      payload: {},
    });
    expect(response.statusCode).toBe(202);
    const started = (response.json() as { data: { runId: number; status: string } }).data;
    expect(started.status).toBe('running');
    expect(started.runId).toBeGreaterThan(0);

    const status = await waitForRunFinished(ctx.app, ctx.token, started.runId);
    expect(status).toBe('success');

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/tasks/runs/${started.runId}`,
      headers,
    });
    expect(detail.statusCode).toBe(200);
    const run = (detail.json() as { data: { status: string; logs: string[]; finishedAt: string | null } })
      .data;
    expect(run.status).toBe('success');
    expect(run.logs.length).toBeGreaterThan(0);
    expect(run.finishedAt).toBeTruthy();
  });

  it('已有运行中的任务时返回 409', async () => {
    ctx = await createTestApp();
    ctx.db.run("INSERT INTO fetch_runs (trigger, status, started_at) VALUES ('manual', 'running', ?)", [
      new Date().toISOString(),
    ]);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tasks/fetch',
      headers: authHeader(ctx.token),
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe('CONFLICT');
  });

  it('指定不存在的 sourceKey 返回 400', async () => {
    ctx = await createTestApp();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tasks/fetch',
      headers: authHeader(ctx.token),
      payload: { sourceKeys: ['not-exist-source'] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('指定存在的 sourceKey 可正常入队', async () => {
    ctx = await createTestApp();
    ctx.app.knetsec.pipeline = fakePipeline(ctx.db);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tasks/fetch',
      headers: authHeader(ctx.token),
      payload: { sourceKeys: ['github-ghsa'] },
    });
    expect(response.statusCode).toBe(202);
  });

  it('运行记录分页与调度器状态', async () => {
    ctx = await createTestApp();
    const headers = authHeader(ctx.token);
    ctx.db.run(
      "INSERT INTO fetch_runs (trigger, status, started_at, sources_total) VALUES ('manual', 'success', ?, 2)",
      [new Date().toISOString()],
    );

    const runs = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/tasks/runs?page=1&pageSize=10',
      headers,
    });
    expect(runs.statusCode).toBe(200);
    const body = runs.json() as {
      data: { total: number; items: Array<{ logs: string[]; status: string }> };
    };
    expect(body.data.total).toBe(1);
    expect(body.data.items[0]?.logs).toEqual([]);

    const status = await ctx.app.inject({ method: 'GET', url: '/api/v1/tasks/status', headers });
    expect(status.statusCode).toBe(200);
    const scheduler = (status.json() as { data: { enabled: boolean; jobs: unknown[] } }).data;
    // 测试构建时 scheduler=false
    expect(scheduler.enabled).toBe(false);
    expect(scheduler.jobs).toEqual([]);
  });

  it('viewer 不能触发采集（403）', async () => {
    ctx = await createTestApp();
    const viewerToken = await createViewer(ctx.app, ctx.db);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tasks/fetch',
      headers: authHeader(viewerToken),
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  });
});
