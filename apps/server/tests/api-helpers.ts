/**
 * 集成测试公共夹具。
 *
 * 所有测试都用 :memory: SQLite + app.inject()，不监听端口、不访问外网：
 * - collectorFactory / pipeline 一律注入假件；
 * - 报告落盘目录用系统临时目录，测试结束删除，不污染仓库 data/。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { Db } from '../src/infra/db.js';
import { hashPassword } from '../src/infra/security.js';
import type { AppLogger } from '../src/infra/logger.js';
import type { CollectorFactory, PipelineRunner } from '../src/modules/core/context.js';

/** 测试应用句柄。 */
export interface TestApp {
  app: FastifyInstance;
  db: Db;
  /** 临时目录（报告落盘 / 前端产物占位）。 */
  dir: string;
  /** 默认管理员 token。 */
  token: string;
  close(): Promise<void>;
}

/** 创建测试应用可注入项。 */
export interface CreateTestAppOptions {
  pipeline?: PipelineRunner;
  collectorFactory?: CollectorFactory;
  /** 是否执行种子数据（默认 true，创建 admin 与默认数据源）。 */
  seed?: boolean;
}

/** 静默日志器：测试不输出 pino 日志，避免污染断言输出。 */
export function silentLogger(): AppLogger {
  return pino({ level: 'silent' }) as unknown as AppLogger;
}

/** 创建测试应用并完成管理员登录。 */
export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestApp> {
  const dir = mkdtempSync(path.join(tmpdir(), 'knetsec-test-'));
  const logger = silentLogger();
  const db = new Db(':memory:');
  const app = await buildApp({
    db,
    logger,
    scheduler: false,
    seed: options.seed ?? true,
    pipeline: options.pipeline,
    collectorFactory: options.collectorFactory,
    reportsDir: path.join(dir, 'reports'),
    webDistDir: path.join(dir, 'web-dist'),
    jwtSecret: 'test-secret-0123456789abcdef',
  });

  const token = await login(app, config.admin.username, config.admin.password);
  return {
    app,
    db,
    dir,
    token,
    close: async () => {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 登录并返回 token（失败直接抛错，让测试失败信息明确）。 */
export async function login(app: FastifyInstance, username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`测试登录失败（${username}）：${response.statusCode} ${response.body}`);
  }
  const body = response.json() as { data: { token: string } };
  return body.data.token;
}

/** 构造 Bearer 头。 */
export function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** 插入一个只读用户并返回其 token。 */
export async function createViewer(
  app: FastifyInstance,
  db: Db,
  username = 'viewer',
  password = 'viewer1234',
): Promise<string> {
  const hash = await hashPassword(password);
  db.run(
    'INSERT INTO users (username, password_hash, display_name, role, must_change_password, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    [username, hash, '只读用户', 'viewer', new Date().toISOString()],
  );
  return login(app, username, password);
}

/** 插入测试情报的入参（全部可选，默认值足够构成一条合法记录）。 */
export interface InsertItemInput {
  uid?: string;
  sourceKey?: string;
  sourceName?: string;
  title: string;
  summary?: string | null;
  url?: string | null;
  publishedAt?: string | null;
  fetchedAt?: string;
  category?: string;
  tags?: string[];
  severity?: string;
  cveIds?: string[];
  ghsaIds?: string[];
  cvssScore?: number | null;
  isKev?: boolean;
  vendor?: string | null;
  lang?: string;
  importance?: number;
  raw?: string | null;
  isRead?: boolean;
  isStarred?: boolean;
}

/** 直接写库插入情报（绕过流水线，便于构造筛选/排序场景）。 */
export function insertItem(db: Db, input: InsertItemInput): number {
  const now = new Date().toISOString();
  const result = db.run(
    `INSERT INTO items (uid, source_key, source_name, title, summary, url, author, published_at, fetched_at,
        category, tags, severity, cve_ids, ghsa_ids, cvss_score, is_kev, vendor, lang, importance, raw,
        is_read, is_starred, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.uid ?? `uid-${Math.random().toString(36).slice(2)}`,
      input.sourceKey ?? 'test-source',
      input.sourceName ?? '测试源',
      input.title,
      input.summary ?? null,
      input.url ?? null,
      input.publishedAt ?? now,
      input.fetchedAt ?? now,
      input.category ?? 'news',
      JSON.stringify(input.tags ?? []),
      input.severity ?? 'unknown',
      JSON.stringify(input.cveIds ?? []),
      JSON.stringify(input.ghsaIds ?? []),
      input.cvssScore ?? null,
      input.isKev ? 1 : 0,
      input.vendor ?? null,
      input.lang ?? 'zh',
      input.importance ?? 0,
      input.raw ?? null,
      input.isRead ? 1 : 0,
      input.isStarred ? 1 : 0,
      now,
    ],
  );
  return result.lastInsertRowid;
}
