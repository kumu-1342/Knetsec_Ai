#!/usr/bin/env node
/**
 * 数据源可达性实测脚本。
 *
 * 直接复用编译后的采集器（不启动服务、不写数据库），逐个执行默认数据源的
 * fetch()，打印「状态 / 条数 / 耗时 / 样本标题 / 错误原因」。
 *
 * 用法（需先 npm run build）：
 *   npm run verify:sources            # 只测 enabled=true 的源
 *   node scripts/verify-sources.mjs --all   # 测全部源
 */
import process from 'node:process';
import { DEFAULT_SETTINGS } from '../packages/shared/dist/index.js';
import { config } from '../apps/server/dist/config.js';
import { HttpClient } from '../apps/server/dist/infra/http.js';
import { createCollector } from '../apps/server/dist/collectors/index.js';
import { DEFAULT_SOURCES } from '../apps/server/dist/seed/sources.seed.js';

const testAll = process.argv.includes('--all');
const sources = DEFAULT_SOURCES.filter((s) => testAll || s.enabled !== false);

/** 极简日志器：只保留 warn/error，避免刷屏 */
const logger = {
  debug: () => {},
  info: () => {},
  warn: (obj, msg) => console.warn('[warn]', msg ?? '', typeof obj === 'string' ? obj : ''),
  error: (obj, msg) => console.error('[error]', msg ?? '', typeof obj === 'string' ? obj : ''),
};

const http = new HttpClient({ timeoutMs: 30_000, retries: 1, proxyUrl: config.httpProxy, logger });

const settings = { ...DEFAULT_SETTINGS };
const headers = ['数据源', '状态', '条数', '耗时', '说明/样本'];

function printRow(cols) {
  const widths = [30, 6, 6, 8, 60];
  const line = cols.map((c, i) => String(c).padEnd(widths[i] ?? 20).slice(0, widths[i] ?? 60)).join(' ');
  console.log(line);
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

console.log('\n=== Knetsec_Ai 数据源实测 ===');
console.log(`共 ${sources.length} 个源，模式：${testAll ? '全部' : '仅启用'}，代理：${config.httpProxy || '无'}\n`);
printRow(headers);

let ok = 0;
let failed = 0;
const detail = [];

for (const [index, source] of sources.entries()) {
  const descriptor = { ...source, id: index + 1 };
  const startedAt = Date.now();
  let status = 'OK';
  let count = 0;
  let note = '';

  try {
    const collector = createCollector(descriptor);
    const result = await withTimeout(
      collector.fetch({
        source: descriptor,
        now: new Date(),
        logger,
        http,
        settings,
        secrets: config.secrets,
      }),
      90_000,
      source.key,
    );
    count = result.items.length;
    if (count === 0) {
      status = 'EMPTY';
      note = '未返回条目（可能窗口内无更新）';
    } else {
      ok += 1;
      note = result.items.slice(0, 2).map((i) => i.title.slice(0, 40)).join(' | ');
    }
    if (result.warnings?.length) note += ` [warn: ${result.warnings.length}]`;
  } catch (error) {
    failed += 1;
    status = 'FAIL';
    note = error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120);
  }

  const duration = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  printRow([source.key, status, String(count), duration, note]);
  detail.push({ key: source.key, name: source.name, status, count, note, duration });
}

console.log('\n=== 汇总 ===');
console.log(`成功：${ok}  失败：${failed}  总计：${sources.length}`);
const failedList = detail.filter((d) => d.status === 'FAIL');
if (failedList.length > 0) {
  console.log('\n失败源与原因：');
  for (const item of failedList) console.log(`- ${item.key}（${item.name}）：${item.note}`);
}
console.log('\n提示：GitHub 未配置 GITHUB_TOKEN 时限流 60 次/小时；NVD 未配置 NVD_API_KEY 时约 5 次/30 秒。');
process.exit(ok > 0 ? 0 : 1);
